
-- 1) Extensão pg_net
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- 2) Log de alertas
CREATE TABLE IF NOT EXISTS public.whatsapp_alerts_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  alert_type text NOT NULL,
  equipment_id uuid NOT NULL,
  equipment_name text,
  previous_state text,
  new_state text,
  message_sent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.whatsapp_alerts_log TO authenticated;
GRANT ALL ON public.whatsapp_alerts_log TO service_role;

ALTER TABLE public.whatsapp_alerts_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role manages alert log" ON public.whatsapp_alerts_log;
CREATE POLICY "service_role manages alert log"
  ON public.whatsapp_alerts_log FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "authenticated read alert log" ON public.whatsapp_alerts_log;
CREATE POLICY "authenticated read alert log"
  ON public.whatsapp_alerts_log FOR SELECT
  TO authenticated
  USING (true);

CREATE INDEX IF NOT EXISTS idx_whatsapp_alerts_log_lookup
  ON public.whatsapp_alerts_log (alert_type, equipment_id, created_at DESC);

-- 3) Trigger function — chama a edge function whatsapp-alerts via pg_net
CREATE OR REPLACE FUNCTION public.notify_equipment_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _alerts_enabled boolean;
  _url text := 'https://dnyukgfedredvxpzjpqz.supabase.co/functions/v1/whatsapp-alerts';
  _anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk';
BEGIN
  SELECT alerts_enabled INTO _alerts_enabled
    FROM public.whatsapp_alert_settings
    ORDER BY created_at ASC
    LIMIT 1;

  IF NOT COALESCE(_alerts_enabled, false) THEN
    RETURN NEW;
  END IF;

  -- LOCAL change
  IF (OLD.last_actuation_origin IS DISTINCT FROM NEW.last_actuation_origin
      AND NEW.last_actuation_origin = 'local') THEN
    PERFORM net.http_post(
      url := _url,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || _anon,
        'apikey', _anon,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'alert_type', 'local_change',
        'equipment_id', NEW.id,
        'equipment_name', NEW.name,
        'new_running', NEW.desired_running,
        'farm_id', NEW.farm_id
      )
    );
  END IF;

  -- OFFLINE
  IF (OLD.communication_status IS DISTINCT FROM NEW.communication_status
      AND NEW.communication_status = 'offline') THEN
    PERFORM net.http_post(
      url := _url,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || _anon,
        'apikey', _anon,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'alert_type', 'offline',
        'equipment_id', NEW.id,
        'equipment_name', NEW.name,
        'farm_id', NEW.farm_id
      )
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Nunca derrubar o UPDATE por causa do alerta
  RAISE WARNING 'notify_equipment_change failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- 4) Trigger
DROP TRIGGER IF EXISTS equipment_change_alert ON public.equipments;
CREATE TRIGGER equipment_change_alert
  AFTER UPDATE ON public.equipments
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_equipment_change();
