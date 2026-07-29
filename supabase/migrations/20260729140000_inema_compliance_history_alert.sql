-- ============================================================================
-- INEMA — Persistência do histórico de compliance + alerta WhatsApp em 95%.
-- Roda server-side (pg_cron), independente de app aberto. Aplicar no SQL Editor.
-- Horas: derivadas de pump_runtime (mesma fonte do get_horimetro_daily), mas SEM
-- o check has_farm_access (aqui rodamos como postgres/cron).
-- ============================================================================

-- system_alerts (idempotente — pode já existir do monitor do WhatsApp)
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
  peak_pct numeric,                    -- max(hours_pct, volume_pct)
  status text,                         -- ok / warn / over
  alerted boolean NOT NULL DEFAULT false,  -- alerta de 95% já enviado hoje
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inema_daily_unique UNIQUE (equipment_id, day)
);
CREATE INDEX IF NOT EXISTS idx_inema_daily_farm_day ON public.inema_daily_compliance(farm_id, day DESC);

ALTER TABLE public.inema_daily_compliance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inema_daily_select ON public.inema_daily_compliance;
CREATE POLICY inema_daily_select ON public.inema_daily_compliance FOR SELECT
  USING (farm_id IN (SELECT ur.farm_id FROM public.user_roles ur WHERE ur.user_id = auth.uid()));

-- ── Função: snapshot do dia + alerta 95% (idempotente; chamada pelo cron) ──
CREATE OR REPLACE FUNCTION public.inema_snapshot_and_alert()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_today     date        := (now() AT TIME ZONE 'America/Bahia')::date;
  v_day_start timestamptz := (v_today::timestamp AT TIME ZONE 'America/Bahia');
  v_day_end   timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'America/Bahia');
  v_phone_id  text        := '1122648170939922';
  v_token     text;
  r record; op record;
  v_hours numeric; v_vol numeric; v_vol_src text; v_hpct numeric; v_vpct numeric; v_peak numeric; v_status text;
  v_already boolean; v_msg text;
BEGIN
  SELECT api_token INTO v_token FROM public.whatsapp_config WHERE api_token IS NOT NULL LIMIT 1;

  FOR r IN
    SELECT p.equipment_id, p.farm_id, p.max_daily_hours, p.max_daily_volume_m3,
           e.name AS eq_name, e.estimated_flow_m3h, e.flow_total_m3, e.flow_daily_start_m3
    FROM public.inema_permits p
    JOIN public.equipments e ON e.id = p.equipment_id
  LOOP
    -- horas de HOJE a partir de pump_runtime (sessões ligadas), recortadas ao dia
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

    -- volume: telemetria (flow_total - flow_daily_start) quando houver; senão horas × vazão estimada
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

    -- ── ALERTA em 95% (uma vez por poço por dia) ──
    IF v_peak >= 95 THEN
      SELECT alerted INTO v_already FROM public.inema_daily_compliance
        WHERE equipment_id = r.equipment_id AND day = v_today;
      IF NOT COALESCE(v_already, false) THEN
        v_msg := '⚠️ INEMA — ' || r.eq_name || ' atingiu ' || v_hours || 'h de uso hoje (limite '
                 || r.max_daily_hours || 'h'
                 || CASE WHEN v_vpct IS NOT NULL THEN '; volume ' || v_vol || '/' || r.max_daily_volume_m3 || ' m³' ELSE '' END
                 || '). Risco de infração — reduza o uso.';

        INSERT INTO public.system_alerts (severity, source, title, details)
        VALUES ('warning', 'inema-compliance', '⚠️ Poço próximo do limite INEMA',
                jsonb_build_object('equipment', r.eq_name, 'farm_id', r.farm_id, 'day', v_today,
                                   'hours', v_hours, 'peak_pct', v_peak));

        -- WhatsApp direto aos operadores da fazenda com receive_alerts (outbound independe do webhook)
        IF v_token IS NOT NULL THEN
          FOR op IN
            SELECT phone FROM public.whatsapp_operators
             WHERE farm_id = r.farm_id AND is_active = true AND receive_alerts = true AND phone IS NOT NULL
          LOOP
            PERFORM net.http_post(
              url  := 'https://graph.facebook.com/v21.0/' || v_phone_id || '/messages',
              body := jsonb_build_object('messaging_product','whatsapp',
                        'to', regexp_replace(op.phone, '\D', '', 'g'),
                        'type','text','text', jsonb_build_object('body', v_msg)),
              headers := jsonb_build_object('Authorization','Bearer '||v_token,'Content-Type','application/json'),
              timeout_milliseconds := 8000);
          END LOOP;
        END IF;

        UPDATE public.inema_daily_compliance SET alerted = true
          WHERE equipment_id = r.equipment_id AND day = v_today;
      END IF;
    END IF;
  END LOOP;

  -- retenção: 400 dias de histórico
  DELETE FROM public.inema_daily_compliance
   WHERE day < (now() AT TIME ZONE 'America/Bahia')::date - 400;
END
$fn$;

-- Cron a cada 15 min (detecta os 95% "antes de estourar" e mantém o histórico do dia).
DO $$ BEGIN PERFORM cron.unschedule('inema-compliance-tick'); EXCEPTION WHEN others THEN NULL; END $$;
SELECT cron.schedule('inema-compliance-tick', '*/15 * * * *', $$ SELECT public.inema_snapshot_and_alert(); $$);

-- Score por fazenda (últimos N dias) — usado pelo dashboard.
CREATE OR REPLACE FUNCTION public.inema_farm_score(_farm_id uuid, _days int DEFAULT 30)
RETURNS TABLE(total_dias bigint, dias_ok bigint, dias_excedido bigint, score_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT count(*) AS total_dias,
         count(*) FILTER (WHERE peak_pct < 100) AS dias_ok,
         count(*) FILTER (WHERE peak_pct >= 100) AS dias_excedido,
         CASE WHEN count(*) > 0 THEN round(count(*) FILTER (WHERE peak_pct < 100)::numeric / count(*) * 100, 1) ELSE NULL END AS score_pct
  FROM public.inema_daily_compliance
  WHERE farm_id = _farm_id
    AND day >= (now() AT TIME ZONE 'America/Bahia')::date - _days
    AND public.has_farm_access(auth.uid(), _farm_id);
$$;
