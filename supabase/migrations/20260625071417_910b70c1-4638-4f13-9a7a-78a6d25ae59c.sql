
CREATE TABLE IF NOT EXISTS public.bridge_heartbeat (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  bridge_name text NOT NULL DEFAULT 'main',
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'online',
  electron_version text,
  ip_address text,
  uptime_seconds integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(farm_id, bridge_name)
);

GRANT SELECT ON public.bridge_heartbeat TO authenticated;
GRANT ALL ON public.bridge_heartbeat TO service_role;

ALTER TABLE public.bridge_heartbeat ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view their farm bridge heartbeat"
ON public.bridge_heartbeat FOR SELECT
TO authenticated
USING (
  farm_id IN (
    SELECT farm_id FROM public.profiles WHERE id = auth.uid()
    UNION
    SELECT farm_id FROM public.user_roles WHERE user_id = auth.uid()
  )
);

CREATE POLICY "Service role full access bridge heartbeat"
ON public.bridge_heartbeat FOR ALL
TO service_role
USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.bridge_heartbeat_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  details text,
  alerted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bridge_log_farm_time ON public.bridge_heartbeat_log(farm_id, alerted_at DESC);

GRANT SELECT ON public.bridge_heartbeat_log TO authenticated;
GRANT ALL ON public.bridge_heartbeat_log TO service_role;

ALTER TABLE public.bridge_heartbeat_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view their farm bridge logs"
ON public.bridge_heartbeat_log FOR SELECT
TO authenticated
USING (
  farm_id IN (
    SELECT farm_id FROM public.profiles WHERE id = auth.uid()
    UNION
    SELECT farm_id FROM public.user_roles WHERE user_id = auth.uid()
  )
);

CREATE POLICY "Service role full access bridge logs"
ON public.bridge_heartbeat_log FOR ALL
TO service_role
USING (true) WITH CHECK (true);

-- Seed default row for Terra Norte (idempotent)
INSERT INTO public.bridge_heartbeat (farm_id, bridge_name)
SELECT id, 'main' FROM public.farms WHERE name ILIKE '%terra norte%' LIMIT 1
ON CONFLICT (farm_id, bridge_name) DO NOTHING;

-- Trigger to maintain updated_at
CREATE OR REPLACE FUNCTION public.update_bridge_heartbeat_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_bridge_heartbeat_updated ON public.bridge_heartbeat;
CREATE TRIGGER trg_bridge_heartbeat_updated
BEFORE UPDATE ON public.bridge_heartbeat
FOR EACH ROW EXECUTE FUNCTION public.update_bridge_heartbeat_updated_at();

-- ============================================================
-- Heartbeat checker function (called every minute by pg_cron)
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_bridge_heartbeats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
  v_anon_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk';
  v_alerts_url text := 'https://dnyukgfedredvxpzjpqz.supabase.co/functions/v1/whatsapp-alerts';
  v_farm_name text;
  v_minutes_offline int;
BEGIN
  -- 1) Online -> Warning (>= 2 min sem ping)
  FOR rec IN
    SELECT bh.*, f.name AS farm_name
    FROM bridge_heartbeat bh
    JOIN farms f ON f.id = bh.farm_id
    WHERE bh.last_heartbeat_at < now() - interval '2 minutes'
      AND bh.status = 'online'
  LOOP
    UPDATE bridge_heartbeat SET status = 'warning' WHERE id = rec.id;
    INSERT INTO bridge_heartbeat_log(farm_id, event_type, details)
    VALUES (rec.farm_id, 'warning', 'Bridge sem heartbeat há 2+ min');

    PERFORM net.http_post(
      url := v_alerts_url,
      headers := jsonb_build_object('Content-Type','application/json','apikey', v_anon_key, 'Authorization','Bearer '||v_anon_key),
      body := jsonb_build_object(
        'alert_type','bridge_warning',
        'farm_id', rec.farm_id,
        'farm_name', rec.farm_name,
        'last_heartbeat_at', rec.last_heartbeat_at,
        'force', true
      )
    );
  END LOOP;

  -- 2) Warning -> Offline (>= 5 min sem ping)
  FOR rec IN
    SELECT bh.*, f.name AS farm_name
    FROM bridge_heartbeat bh
    JOIN farms f ON f.id = bh.farm_id
    WHERE bh.last_heartbeat_at < now() - interval '5 minutes'
      AND bh.status = 'warning'
  LOOP
    UPDATE bridge_heartbeat SET status = 'offline' WHERE id = rec.id;
    INSERT INTO bridge_heartbeat_log(farm_id, event_type, details)
    VALUES (rec.farm_id, 'offline', 'Bridge offline há 5+ min');

    PERFORM net.http_post(
      url := v_alerts_url,
      headers := jsonb_build_object('Content-Type','application/json','apikey', v_anon_key, 'Authorization','Bearer '||v_anon_key),
      body := jsonb_build_object(
        'alert_type','bridge_offline',
        'farm_id', rec.farm_id,
        'farm_name', rec.farm_name,
        'last_heartbeat_at', rec.last_heartbeat_at,
        'force', true
      )
    );
  END LOOP;

  -- 3) Recovered (warning/offline -> online se ping < 1 min)
  FOR rec IN
    SELECT bh.*, f.name AS farm_name
    FROM bridge_heartbeat bh
    JOIN farms f ON f.id = bh.farm_id
    WHERE bh.last_heartbeat_at >= now() - interval '1 minute'
      AND bh.status IN ('warning','offline')
  LOOP
    v_minutes_offline := GREATEST(
      EXTRACT(EPOCH FROM (rec.last_heartbeat_at - (
        SELECT MAX(alerted_at) FROM bridge_heartbeat_log
        WHERE farm_id = rec.farm_id AND event_type IN ('warning','offline')
      )))::int / 60, 0
    );

    UPDATE bridge_heartbeat SET status = 'online' WHERE id = rec.id;
    INSERT INTO bridge_heartbeat_log(farm_id, event_type, details)
    VALUES (rec.farm_id, 'recovered', 'Bridge online novamente');

    PERFORM net.http_post(
      url := v_alerts_url,
      headers := jsonb_build_object('Content-Type','application/json','apikey', v_anon_key, 'Authorization','Bearer '||v_anon_key),
      body := jsonb_build_object(
        'alert_type','bridge_recovered',
        'farm_id', rec.farm_id,
        'farm_name', rec.farm_name,
        'recovered_at', now(),
        'minutes_offline', v_minutes_offline,
        'force', true
      )
    );
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_bridge_heartbeats() TO service_role;
