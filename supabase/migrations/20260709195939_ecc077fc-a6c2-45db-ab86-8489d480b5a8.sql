
-- 1) Tabela detalhamento por bomba/dia
CREATE TABLE IF NOT EXISTS public.energy_efficiency_daily_pumps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  date date NOT NULL,
  equipment_id uuid NOT NULL,
  equipment_name text NOT NULL,
  first_on timestamptz,
  late_min int NOT NULL DEFAULT 0,
  last_off timestamptz,
  early_off_min int NOT NULL DEFAULT 0,
  mode text NOT NULL DEFAULT 'remote',        -- 'remote' | 'local'
  peak_minutes int NOT NULL DEFAULT 0,
  post_status text NOT NULL DEFAULT 'ok',     -- 'ok' | 'late' | 'not_started'
  pre_status  text NOT NULL DEFAULT 'ok',     -- 'ok' | 'early' | 'no_shutdown'
  peak_violation boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, date, equipment_id)
);

CREATE INDEX IF NOT EXISTS idx_eedp_farm_date ON public.energy_efficiency_daily_pumps (farm_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_eedp_equipment ON public.energy_efficiency_daily_pumps (equipment_id, date DESC);

GRANT SELECT ON public.energy_efficiency_daily_pumps TO authenticated;
GRANT ALL ON public.energy_efficiency_daily_pumps TO service_role;

ALTER TABLE public.energy_efficiency_daily_pumps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "eedp_select_members" ON public.energy_efficiency_daily_pumps
  FOR SELECT TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id) OR public.is_platform_staff(auth.uid()));

CREATE POLICY "eedp_no_user_writes_insert" ON public.energy_efficiency_daily_pumps
  FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY "eedp_no_user_writes_update" ON public.energy_efficiency_daily_pumps
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "eedp_no_user_writes_delete" ON public.energy_efficiency_daily_pumps
  FOR DELETE TO authenticated USING (false);

-- 2) Função que calcula snapshot por bomba de um ciclo
CREATE OR REPLACE FUNCTION public.calculate_energy_efficiency_pumps_for_date(_farm_id uuid, _date date)
 RETURNS TABLE(
   equipment_id uuid,
   equipment_name text,
   first_on timestamptz,
   late_min int,
   last_off timestamptz,
   early_off_min int,
   mode text,
   peak_minutes int,
   post_status text,
   pre_status text,
   peak_violation boolean
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  tz text;
  cycle_start timestamptz;
  entry_window_end timestamptz;
  post_window_end timestamptz;
  peak_start timestamptz;
  peak_end timestamptz;
  pre_target timestamptz;
  cycle_end timestamptz;
BEGIN
  SELECT COALESCE(f.timezone, 'America/Sao_Paulo') INTO tz
  FROM public.farms f WHERE f.id = _farm_id;
  IF tz IS NULL THEN RETURN; END IF;

  cycle_start := (((_date - 1)::text || ' 21:00')::timestamp AT TIME ZONE tz);
  entry_window_end := cycle_start + interval '6 hours';
  post_window_end := cycle_start + interval '9 hours';
  peak_start := ((_date::text || ' 18:00')::timestamp AT TIME ZONE tz);
  peak_end := ((_date::text || ' 21:00')::timestamp AT TIME ZONE tz);
  pre_target := ((_date::text || ' 17:45')::timestamp AT TIME ZONE tz);
  cycle_end := peak_end;

  RETURN QUERY
  WITH pump_equipment AS (
    SELECT e.id, e.name, e.saida, e.local_ack_at
      FROM public.equipments e
     WHERE e.farm_id = _farm_id AND e.active = true
       AND e.type::text IN ('poco','bombeamento','conjunto','rio')
  ),
  scheduled_pumps AS (
    SELECT DISTINCT s.equipment_id
      FROM public.automation_schedules s
     WHERE s.farm_id = _farm_id AND s.active = true AND s.equipment_id IS NOT NULL
  ),
  raw_events AS (
    SELECT al.equipment_id, al.occurred_at AS event_at, al.action
      FROM public.automation_log al JOIN pump_equipment pe ON pe.id = al.equipment_id
     WHERE al.farm_id = _farm_id AND al.result = 'success'
       AND al.action IN ('turn_on','turn_off') AND al.occurred_at < cycle_end
    UNION ALL
    SELECT c.equipment_id,
           COALESCE(c.responded_at, c.sent_at, c.created_at) AS event_at,
           public.infer_pump_action_from_command_frame(c.frame, pe.saida) AS action
      FROM public.commands c JOIN pump_equipment pe ON pe.id = c.equipment_id
     WHERE c.farm_id = _farm_id AND c.type = 'manual'::public.command_type
       AND c.status = 'executed'::public.command_status
       AND COALESCE(c.responded_at, c.sent_at, c.created_at) < cycle_end
       AND public.infer_pump_action_from_command_frame(c.frame, pe.saida) IN ('turn_on','turn_off')
  ),
  last_before AS (
    SELECT DISTINCT ON (equipment_id) equipment_id, event_at, action
      FROM raw_events WHERE event_at < cycle_start
     ORDER BY equipment_id, event_at DESC
  ),
  carry_on AS (
    SELECT equipment_id, cycle_start AS event_at, 'turn_on'::public.event_action AS action
      FROM last_before WHERE action = 'turn_on'::public.event_action
  ),
  period_events AS (
    SELECT equipment_id, event_at, action FROM raw_events
     WHERE event_at >= cycle_start AND event_at < cycle_end
  ),
  timeline_base AS (SELECT * FROM carry_on UNION ALL SELECT * FROM period_events),
  ordered_events AS (
    SELECT equipment_id, event_at, action,
           LAG(action) OVER (PARTITION BY equipment_id ORDER BY event_at, action::text) AS prev_action
      FROM timeline_base
  ),
  state_events AS (
    SELECT equipment_id, event_at, action FROM ordered_events
     WHERE prev_action IS NULL OR prev_action <> action
  ),
  ranked AS (
    SELECT equipment_id, event_at, action,
           LEAD(event_at) OVER (PARTITION BY equipment_id ORDER BY event_at, action::text) AS next_at,
           LEAD(action) OVER (PARTITION BY equipment_id ORDER BY event_at, action::text) AS next_action
      FROM state_events
  ),
  sessions AS (
    SELECT equipment_id, event_at AS on_at,
           CASE WHEN next_action = 'turn_off'::public.event_action THEN next_at ELSE cycle_end END AS off_at
      FROM ranked WHERE action = 'turn_on'::public.event_action
  ),
  valid_sessions AS (
    SELECT equipment_id, on_at, off_at,
           EXTRACT(epoch FROM (off_at - on_at))/60.0 AS on_minutes
      FROM sessions
     WHERE off_at > on_at AND off_at > cycle_start AND on_at < cycle_end
  ),
  -- Pós-ponta (regra nova): sessão ≥30min OU ≥60min acumulados nas 6h iniciais
  post_sessions AS (
    SELECT vs.equipment_id, vs.on_at, vs.off_at, vs.on_minutes
      FROM valid_sessions vs
     WHERE vs.on_at < LEAST(post_window_end, cycle_end) AND vs.off_at > cycle_start
  ),
  rule_a AS (
    SELECT DISTINCT equipment_id FROM post_sessions WHERE on_minutes >= 30
  ),
  rule_b AS (
    SELECT equipment_id FROM post_sessions
     WHERE on_at < entry_window_end
     GROUP BY equipment_id
    HAVING SUM(EXTRACT(epoch FROM (LEAST(off_at, entry_window_end) - GREATEST(on_at, cycle_start)))/60.0) >= 60
  ),
  qualified AS (SELECT equipment_id FROM rule_a UNION SELECT equipment_id FROM rule_b),
  first_valid_on AS (
    SELECT ps.equipment_id, MIN(GREATEST(ps.on_at, cycle_start)) AS first_on
      FROM post_sessions ps
     WHERE ps.equipment_id IN (SELECT equipment_id FROM qualified)
     GROUP BY ps.equipment_id
  ),
  operated AS (
    SELECT DISTINCT equipment_id FROM valid_sessions
     WHERE off_at > cycle_start AND on_at < peak_start
  ),
  expected_pumps AS (
    SELECT equipment_id FROM scheduled_pumps
    UNION SELECT equipment_id FROM operated
  ),
  -- Último off antes de 18:00 do dia
  last_off_pre AS (
    SELECT equipment_id, MAX(off_at) AS last_off
      FROM valid_sessions
     WHERE off_at <= peak_start
     GROUP BY equipment_id
  ),
  -- Minutos ligada 18-21
  peak_per_pump AS (
    SELECT equipment_id,
           SUM(GREATEST(0,
             EXTRACT(epoch FROM (LEAST(off_at, peak_end) - GREATEST(on_at, peak_start)))/60.0
           ))::int AS peak_minutes
      FROM valid_sessions
     WHERE off_at > peak_start AND on_at < peak_end
     GROUP BY equipment_id
  )
  SELECT
    ep.equipment_id,
    pe.name AS equipment_name,
    fvo.first_on,
    CASE
      WHEN fvo.first_on IS NULL THEN 540
      ELSE LEAST(540, GREATEST(0, FLOOR(EXTRACT(epoch FROM (fvo.first_on - cycle_start))/60))::int)
    END AS late_min,
    lop.last_off,
    CASE
      WHEN lop.last_off IS NULL THEN 0
      WHEN lop.last_off >= pre_target THEN 0
      ELSE GREATEST(0, FLOOR(EXTRACT(epoch FROM (pre_target - lop.last_off))/60))::int
    END AS early_off_min,
    CASE
      WHEN COALESCE(pe.local_ack_at, 'epoch'::timestamptz) > cycle_start THEN 'local'
      ELSE 'remote'
    END AS mode,
    COALESCE(pk.peak_minutes, 0) AS peak_minutes,
    CASE
      WHEN fvo.first_on IS NULL THEN 'not_started'
      WHEN LEAST(540, GREATEST(0, FLOOR(EXTRACT(epoch FROM (fvo.first_on - cycle_start))/60))::int) > 8 THEN 'late'
      ELSE 'ok'
    END AS post_status,
    CASE
      WHEN lop.last_off IS NULL THEN 'no_shutdown'
      WHEN lop.last_off >= pre_target THEN 'ok'
      ELSE 'early'
    END AS pre_status,
    (COALESCE(pk.peak_minutes, 0) > 0) AS peak_violation
  FROM expected_pumps ep
  LEFT JOIN pump_equipment pe ON pe.id = ep.equipment_id
  LEFT JOIN first_valid_on fvo ON fvo.equipment_id = ep.equipment_id
  LEFT JOIN last_off_pre lop  ON lop.equipment_id = ep.equipment_id
  LEFT JOIN peak_per_pump pk  ON pk.equipment_id = ep.equipment_id
  WHERE pe.name IS NOT NULL;
END;
$function$;

-- 3) compute_energy_efficiency agora popula também a tabela por bomba
CREATE OR REPLACE FUNCTION public.compute_energy_efficiency(_farm_id uuid, _date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
BEGIN
  SELECT * INTO r
  FROM public.calculate_energy_efficiency_for_date(_farm_id, _date)
  LIMIT 1;

  IF r.cycle_date IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.energy_efficiency_daily
    (farm_id, date, pre_peak_shutdown_time, post_peak_startup_time,
     lost_minutes, pumps_on_during_peak, efficiency_percent,
     pumps_operated, minutes_on_during_peak, pre_peak_ok_count, post_peak_ok_count, updated_at)
  VALUES (_farm_id, r.cycle_date, r.pre_peak_shutdown_time, r.post_peak_startup_time,
          r.lost_minutes, r.pumps_on_during_peak, COALESCE(r.efficiency_percent, 100),
          r.pumps_operated, r.minutes_on_during_peak, r.pre_peak_ok_count, r.post_peak_ok_count, now())
  ON CONFLICT (farm_id, date) DO UPDATE SET
    pre_peak_shutdown_time = EXCLUDED.pre_peak_shutdown_time,
    post_peak_startup_time = EXCLUDED.post_peak_startup_time,
    lost_minutes           = EXCLUDED.lost_minutes,
    pumps_on_during_peak   = EXCLUDED.pumps_on_during_peak,
    efficiency_percent     = EXCLUDED.efficiency_percent,
    pumps_operated         = EXCLUDED.pumps_operated,
    minutes_on_during_peak = EXCLUDED.minutes_on_during_peak,
    pre_peak_ok_count      = EXCLUDED.pre_peak_ok_count,
    post_peak_ok_count     = EXCLUDED.post_peak_ok_count,
    updated_at             = now();

  -- Substitui snapshot por bomba do dia
  DELETE FROM public.energy_efficiency_daily_pumps
   WHERE farm_id = _farm_id AND date = _date;

  INSERT INTO public.energy_efficiency_daily_pumps
    (farm_id, date, equipment_id, equipment_name, first_on, late_min,
     last_off, early_off_min, mode, peak_minutes,
     post_status, pre_status, peak_violation, updated_at)
  SELECT _farm_id, _date, p.equipment_id, p.equipment_name, p.first_on, p.late_min,
         p.last_off, p.early_off_min, p.mode, p.peak_minutes,
         p.post_status, p.pre_status, p.peak_violation, now()
    FROM public.calculate_energy_efficiency_pumps_for_date(_farm_id, _date) p;
END;
$function$;

-- 4) RPC para o app buscar detalhamento de um dia
CREATE OR REPLACE FUNCTION public.get_energy_efficiency_pumps(_farm_id uuid, _date date)
 RETURNS TABLE(
   equipment_id uuid,
   equipment_name text,
   first_on timestamptz,
   late_min int,
   last_off timestamptz,
   early_off_min int,
   mode text,
   peak_minutes int,
   post_status text,
   pre_status text,
   peak_violation boolean
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_farm_access(auth.uid(), _farm_id) OR public.is_platform_staff(auth.uid())) THEN
    RETURN;
  END IF;

  -- Se já existe snapshot persistido, retorna-o (mais rápido)
  IF EXISTS (SELECT 1 FROM public.energy_efficiency_daily_pumps
              WHERE farm_id = _farm_id AND date = _date) THEN
    RETURN QUERY
    SELECT p.equipment_id, p.equipment_name, p.first_on, p.late_min,
           p.last_off, p.early_off_min, p.mode, p.peak_minutes,
           p.post_status, p.pre_status, p.peak_violation
      FROM public.energy_efficiency_daily_pumps p
     WHERE p.farm_id = _farm_id AND p.date = _date
     ORDER BY
       CASE p.post_status WHEN 'not_started' THEN 0 WHEN 'late' THEN 1 ELSE 2 END,
       p.late_min DESC, p.equipment_name;
    RETURN;
  END IF;

  -- Fallback: calcula ao vivo
  RETURN QUERY
  SELECT * FROM public.calculate_energy_efficiency_pumps_for_date(_farm_id, _date)
   ORDER BY
     CASE post_status WHEN 'not_started' THEN 0 WHEN 'late' THEN 1 ELSE 2 END,
     late_min DESC, equipment_name;
END;
$function$;
