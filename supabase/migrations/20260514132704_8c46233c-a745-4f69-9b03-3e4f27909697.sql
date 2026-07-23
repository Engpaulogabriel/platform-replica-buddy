
-- Tabela diária de eficiência energética
CREATE TABLE IF NOT EXISTS public.energy_efficiency_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL,
  date date NOT NULL,
  pre_peak_shutdown_time timestamptz,
  post_peak_startup_time timestamptz,
  lost_minutes integer NOT NULL DEFAULT 0,
  pumps_on_during_peak integer NOT NULL DEFAULT 0,
  efficiency_percent numeric(5,2) NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(farm_id, date)
);

CREATE INDEX IF NOT EXISTS idx_eed_farm_date ON public.energy_efficiency_daily(farm_id, date DESC);

ALTER TABLE public.energy_efficiency_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "eed_select_members" ON public.energy_efficiency_daily
  FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));

-- INSERT/UPDATE só via SECURITY DEFINER functions (sem policies de write para clientes)

-- Função: calcula eficiência para uma fazenda + data específica
CREATE OR REPLACE FUNCTION public.compute_energy_efficiency(_farm_id uuid, _date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tz text;
  pre_off timestamptz;
  post_on timestamptz;
  lost_min int := 0;
  pumps_peak int := 0;
  eff numeric := 100;
  peak_start timestamptz;
  peak_end timestamptz;
  shoulder_start timestamptz;
BEGIN
  SELECT COALESCE(timezone, 'America/Sao_Paulo') INTO tz FROM farms WHERE id = _farm_id;
  IF tz IS NULL THEN RETURN; END IF;

  peak_start := ((_date::text || ' 18:00')::timestamp AT TIME ZONE tz);
  peak_end := ((_date::text || ' 21:00')::timestamp AT TIME ZONE tz);
  shoulder_start := ((_date::text || ' 17:00')::timestamp AT TIME ZONE tz);

  SELECT MAX(occurred_at) INTO pre_off FROM automation_log
   WHERE farm_id = _farm_id AND action = 'turn_off' AND result = 'success'
     AND occurred_at >= shoulder_start AND occurred_at < peak_start;

  SELECT MIN(occurred_at) INTO post_on FROM automation_log
   WHERE farm_id = _farm_id AND action = 'turn_on' AND result = 'success'
     AND occurred_at >= peak_end AND occurred_at < peak_end + interval '3 hours';

  IF post_on IS NOT NULL THEN
    lost_min := GREATEST(0, FLOOR(EXTRACT(epoch FROM (post_on - peak_end)) / 60)::int);
  END IF;

  SELECT COUNT(DISTINCT equipment_id) INTO pumps_peak FROM automation_log
   WHERE farm_id = _farm_id AND action = 'turn_on' AND result = 'success'
     AND occurred_at >= peak_start AND occurred_at < peak_end
     AND equipment_id IS NOT NULL;

  eff := 100 - (pumps_peak * 15) - (lost_min * 0.5);
  IF pre_off IS NULL AND (now() AT TIME ZONE tz)::date > _date THEN
    eff := eff - 5;
  END IF;
  IF eff < 0 THEN eff := 0; END IF;
  IF eff > 100 THEN eff := 100; END IF;

  INSERT INTO energy_efficiency_daily
    (farm_id, date, pre_peak_shutdown_time, post_peak_startup_time,
     lost_minutes, pumps_on_during_peak, efficiency_percent, updated_at)
  VALUES (_farm_id, _date, pre_off, post_on, lost_min, pumps_peak, eff, now())
  ON CONFLICT (farm_id, date) DO UPDATE SET
    pre_peak_shutdown_time = EXCLUDED.pre_peak_shutdown_time,
    post_peak_startup_time = EXCLUDED.post_peak_startup_time,
    lost_minutes = EXCLUDED.lost_minutes,
    pumps_on_during_peak = EXCLUDED.pumps_on_during_peak,
    efficiency_percent = EXCLUDED.efficiency_percent,
    updated_at = now();
END;
$$;

-- Função: roda para todas as fazendas (data atual em cada timezone)
CREATE OR REPLACE FUNCTION public.compute_all_energy_efficiency(_date date DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  n int := 0;
  d date;
BEGIN
  FOR r IN SELECT id, COALESCE(timezone,'America/Sao_Paulo') AS tz FROM farms LOOP
    d := COALESCE(_date, (now() AT TIME ZONE r.tz)::date);
    PERFORM compute_energy_efficiency(r.id, d);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

-- Função: alertas proativos no dashboard (sino) — chamada a cada minuto via automation-tick
CREATE OR REPLACE FUNCTION public.check_peak_efficiency_alerts()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  loc_now timestamp;
  hh int;
  mm int;
  running_count int;
  inserted int := 0;
  today_start timestamptz;
BEGIN
  FOR r IN SELECT id, COALESCE(timezone,'America/Sao_Paulo') AS tz FROM farms LOOP
    loc_now := (now() AT TIME ZONE r.tz);
    hh := EXTRACT(hour FROM loc_now)::int;
    mm := EXTRACT(minute FROM loc_now)::int;
    today_start := (loc_now::date::text)::timestamp AT TIME ZONE r.tz;

    -- Conta bombas atualmente ligadas (qualquer saída em '1')
    SELECT COUNT(*) INTO running_count FROM equipments
     WHERE farm_id = r.id
       AND type IN ('poco','bombeamento')
       AND active = true
       AND COALESCE(last_outputs_state, '') ~ '1';

    -- 17:55 — bombas ligadas, ponta em 5 min
    IF hh = 17 AND mm = 55 AND running_count > 0 THEN
      INSERT INTO farm_notifications (farm_id, severity, title, message, source, source_ref)
      SELECT r.id, 'warning',
             'Horário de ponta em 5 min',
             running_count || ' bomba(s) ainda ligada(s). Desligue antes das 18:00 para preservar a eficiência.',
             'energy_efficiency', gen_random_uuid()
      WHERE NOT EXISTS (
        SELECT 1 FROM farm_notifications
        WHERE farm_id = r.id AND source = 'energy_efficiency'
          AND title = 'Horário de ponta em 5 min'
          AND created_at >= today_start
      );
      inserted := inserted + 1;
    END IF;

    -- 21:05 — ponta acabou, bombas ainda desligadas
    IF hh = 21 AND mm = 5 AND running_count = 0 THEN
      INSERT INTO farm_notifications (farm_id, severity, title, message, source, source_ref)
      SELECT r.id, 'info',
             'Ponta acabou — religar bombas',
             'Horário de ponta encerrou às 21:00. Religue as bombas para retomar a captação.',
             'energy_efficiency', gen_random_uuid()
      WHERE NOT EXISTS (
        SELECT 1 FROM farm_notifications
        WHERE farm_id = r.id AND source = 'energy_efficiency'
          AND title = 'Ponta acabou — religar bombas'
          AND created_at >= today_start
      );
      inserted := inserted + 1;
    END IF;

    -- 21:15 — perda relevante
    IF hh = 21 AND mm = 15 AND running_count = 0 THEN
      INSERT INTO farm_notifications (farm_id, severity, title, message, source, source_ref)
      SELECT r.id, 'warning',
             '15 min de captação perdidos',
             'Bombas continuam desligadas após o fim da ponta. Religue para evitar mais perda de produção.',
             'energy_efficiency', gen_random_uuid()
      WHERE NOT EXISTS (
        SELECT 1 FROM farm_notifications
        WHERE farm_id = r.id AND source = 'energy_efficiency'
          AND title = '15 min de captação perdidos'
          AND created_at >= today_start
      );
      inserted := inserted + 1;
    END IF;

    -- 21:10 — recalcula eficiência do dia (já tem o dado de religamento na maioria dos casos)
    IF hh = 21 AND mm = 10 THEN
      PERFORM compute_energy_efficiency(r.id, loc_now::date);
    END IF;

    -- 23:55 — fechamento do dia
    IF hh = 23 AND mm = 55 THEN
      PERFORM compute_energy_efficiency(r.id, loc_now::date);
    END IF;
  END LOOP;
  RETURN inserted;
END;
$$;

-- RPC pública: resumo do card (hoje + médias 7d e 30d)
CREATE OR REPLACE FUNCTION public.get_energy_efficiency_summary(_farm_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tz text;
  today_local date;
  today_row energy_efficiency_daily%ROWTYPE;
  avg_7 numeric;
  avg_30 numeric;
BEGIN
  IF NOT (has_farm_access(auth.uid(), _farm_id) OR is_platform_staff(auth.uid())) THEN
    RETURN jsonb_build_object('error','forbidden');
  END IF;

  SELECT COALESCE(timezone,'America/Sao_Paulo') INTO tz FROM farms WHERE id = _farm_id;
  today_local := (now() AT TIME ZONE tz)::date;

  SELECT * INTO today_row FROM energy_efficiency_daily
   WHERE farm_id = _farm_id AND date = today_local;

  SELECT ROUND(AVG(efficiency_percent), 1) INTO avg_7
    FROM energy_efficiency_daily
   WHERE farm_id = _farm_id AND date >= today_local - 7 AND date < today_local;

  SELECT ROUND(AVG(efficiency_percent), 1) INTO avg_30
    FROM energy_efficiency_daily
   WHERE farm_id = _farm_id AND date >= today_local - 30 AND date < today_local;

  RETURN jsonb_build_object(
    'date', today_local,
    'efficiency_percent', COALESCE(today_row.efficiency_percent, 100),
    'pre_peak_shutdown_time', today_row.pre_peak_shutdown_time,
    'post_peak_startup_time', today_row.post_peak_startup_time,
    'lost_minutes', COALESCE(today_row.lost_minutes, 0),
    'pumps_on_during_peak', COALESCE(today_row.pumps_on_during_peak, 0),
    'avg_7d', avg_7,
    'avg_30d', avg_30
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_energy_efficiency_summary(uuid) TO authenticated;
