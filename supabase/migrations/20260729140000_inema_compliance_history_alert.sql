-- ============================================================================
-- INEMA — Parte 1: histórico de compliance (tabela + RPCs). DDL PURO.
-- SEM pg_cron / SEM pg_net (indisponíveis no Supabase gerenciado pelo Lovable).
-- O snapshot periódico + alerta WhatsApp 95% = Parte 2 (Edge Function ou agente),
-- que apenas CHAMAM as RPCs abaixo. Aplicar no SQL Editor.
-- ============================================================================

-- system_alerts (idempotente — usado pelo alerta na Parte 2 e pelo dashboard)
CREATE TABLE IF NOT EXISTS public.system_alerts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  source text, title text, details jsonb,
  resolved boolean NOT NULL DEFAULT false, resolved_at timestamptz
);

-- Histórico diário de compliance (1 linha por poço por dia).
CREATE TABLE IF NOT EXISTS public.inema_daily_compliance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL,
  equipment_id uuid NOT NULL,
  equipment_name text,
  day date NOT NULL,
  hours numeric, hours_limit numeric, hours_pct numeric,
  volume_m3 numeric, volume_limit numeric, volume_pct numeric,
  volume_source text,
  peak_pct numeric,                        -- max(hours_pct, volume_pct)
  status text,                             -- ok / warn / over
  alerted boolean NOT NULL DEFAULT false,  -- alerta de 95% já enviado hoje
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inema_daily_unique UNIQUE (equipment_id, day)
);
CREATE INDEX IF NOT EXISTS idx_inema_daily_farm_day ON public.inema_daily_compliance(farm_id, day DESC);

ALTER TABLE public.inema_daily_compliance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inema_daily_select ON public.inema_daily_compliance;
CREATE POLICY inema_daily_select ON public.inema_daily_compliance FOR SELECT
  USING (farm_id IN (SELECT ur.farm_id FROM public.user_roles ur WHERE ur.user_id = auth.uid()));

-- ── RPC inema_snapshot(): calcula horas (pump_runtime) + volume, faz UPSERT do dia
--    e RETORNA os poços que cruzaram ≥95% e ainda NÃO foram alertados (para a Parte 2
--    enviar o WhatsApp e depois chamar inema_mark_alerted). SEM pg_net aqui.
--    Chamada só pela Edge Function/agente (service_role) — revogada de anon/authenticated.
CREATE OR REPLACE FUNCTION public.inema_snapshot()
RETURNS TABLE(farm_id uuid, equipment_id uuid, equipment_name text,
              hours numeric, hours_limit numeric, volume_m3 numeric,
              volume_limit numeric, peak_pct numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_today     date        := (now() AT TIME ZONE 'America/Bahia')::date;
  v_day_start timestamptz := (v_today::timestamp AT TIME ZONE 'America/Bahia');
  v_day_end   timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'America/Bahia');
  r record; v_hours numeric; v_vol numeric; v_vol_src text; v_hpct numeric; v_vpct numeric; v_peak numeric; v_status text;
BEGIN
  FOR r IN
    SELECT p.equipment_id, p.farm_id, p.max_daily_hours, p.max_daily_volume_m3,
           e.name AS eq_name, e.estimated_flow_m3h, e.flow_total_m3, e.flow_daily_start_m3
    FROM public.inema_permits p JOIN public.equipments e ON e.id = p.equipment_id
  LOOP
    SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
             LEAST(
               COALESCE(rt.ended_at,
                        CASE WHEN e2.last_communication > now() - interval '60 seconds' THEN now()
                             ELSE COALESCE(e2.last_communication, rt.started_at) END),
               v_day_end)
             - GREATEST(rt.started_at, v_day_start)
           )) / 3600.0), 0)
      INTO v_hours
      FROM public.pump_runtime rt
      JOIN public.equipments e2 ON e2.id = rt.equipment_id
     WHERE rt.equipment_id = r.equipment_id
       AND rt.started_at < v_day_end
       AND COALESCE(rt.ended_at, now()) > v_day_start;
    v_hours := round(GREATEST(v_hours, 0)::numeric, 2);

    IF r.flow_total_m3 IS NOT NULL AND r.flow_daily_start_m3 IS NOT NULL
       AND (r.flow_total_m3 - r.flow_daily_start_m3) >= 0 THEN
      v_vol := round(r.flow_total_m3 - r.flow_daily_start_m3); v_vol_src := 'telemetria';
    ELSIF r.estimated_flow_m3h IS NOT NULL THEN
      v_vol := round(v_hours * r.estimated_flow_m3h); v_vol_src := 'estimado';
    ELSE v_vol := NULL; v_vol_src := '—'; END IF;

    v_hpct := CASE WHEN COALESCE(r.max_daily_hours,0) > 0 THEN round(v_hours / r.max_daily_hours * 100, 1) END;
    v_vpct := CASE WHEN COALESCE(r.max_daily_volume_m3,0) > 0 AND v_vol IS NOT NULL THEN round(v_vol / r.max_daily_volume_m3 * 100, 1) END;
    v_peak := GREATEST(COALESCE(v_hpct,0), COALESCE(v_vpct,0));
    v_status := CASE WHEN v_peak >= 95 THEN 'over' WHEN v_peak >= 80 THEN 'warn' ELSE 'ok' END;

    INSERT INTO public.inema_daily_compliance
      (farm_id, equipment_id, equipment_name, day, hours, hours_limit, hours_pct,
       volume_m3, volume_limit, volume_pct, volume_source, peak_pct, status, updated_at)
    VALUES
      (r.farm_id, r.equipment_id, r.eq_name, v_today, v_hours, r.max_daily_hours, v_hpct,
       v_vol, r.max_daily_volume_m3, v_vpct, v_vol_src, v_peak, v_status, now())
    ON CONFLICT (equipment_id, day) DO UPDATE SET
      hours=EXCLUDED.hours, hours_limit=EXCLUDED.hours_limit, hours_pct=EXCLUDED.hours_pct,
      volume_m3=EXCLUDED.volume_m3, volume_limit=EXCLUDED.volume_limit, volume_pct=EXCLUDED.volume_pct,
      volume_source=EXCLUDED.volume_source, peak_pct=EXCLUDED.peak_pct, status=EXCLUDED.status,
      equipment_name=EXCLUDED.equipment_name, updated_at=now();
  END LOOP;

  -- poços que precisam de alerta (≥95% e ainda não alertados hoje)
  RETURN QUERY
    SELECT c.farm_id, c.equipment_id, c.equipment_name, c.hours, c.hours_limit,
           c.volume_m3, c.volume_limit, c.peak_pct
    FROM public.inema_daily_compliance c
    WHERE c.day = v_today AND c.peak_pct >= 95 AND c.alerted = false;

  -- retenção de 400 dias
  DELETE FROM public.inema_daily_compliance WHERE day < v_today - 400;
END
$fn$;

-- Marca o alerta como enviado (chamada pela Parte 2 após enviar o WhatsApp).
CREATE OR REPLACE FUNCTION public.inema_mark_alerted(_equipment_id uuid, _day date DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  UPDATE public.inema_daily_compliance SET alerted = true
   WHERE equipment_id = _equipment_id
     AND day = COALESCE(_day, (now() AT TIME ZONE 'America/Bahia')::date);
$$;

-- Score por fazenda (últimos N dias) — usado pelo dashboard (frontend).
CREATE OR REPLACE FUNCTION public.inema_farm_score(_farm_id uuid, _days int DEFAULT 30)
RETURNS TABLE(total_dias bigint, dias_ok bigint, dias_excedido bigint, score_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT count(*) AS total_dias,
         count(*) FILTER (WHERE peak_pct < 100) AS dias_ok,
         count(*) FILTER (WHERE peak_pct >= 100) AS dias_excedido,
         CASE WHEN count(*) > 0 THEN round(count(*) FILTER (WHERE peak_pct < 100)::numeric / count(*) * 100, 1) END AS score_pct
  FROM public.inema_daily_compliance
  WHERE farm_id = _farm_id
    AND day >= (now() AT TIME ZONE 'America/Bahia')::date - _days
    AND public.has_farm_access(auth.uid(), _farm_id);
$$;

-- Segurança: snapshot/mark_alerted só para a Parte 2 (service_role), não p/ usuários.
REVOKE EXECUTE ON FUNCTION public.inema_snapshot() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inema_mark_alerted(uuid, date) FROM anon, authenticated;
