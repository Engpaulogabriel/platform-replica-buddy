-- Helper to compute on/off from PLC outputs string ("100000" → first char '1' = on)
CREATE OR REPLACE FUNCTION public._eq_output_on(out_state text, saida int)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN out_state IS NULL OR length(out_state) = 0 THEN NULL
    WHEN saida IS NULL OR saida < 1 OR saida > length(out_state) THEN NULL
    ELSE substr(out_state, saida, 1) = '1'
  END
$$;

CREATE OR REPLACE FUNCTION public.notify_equipment_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  _alerts_enabled boolean;
  _url text := 'https://dnyukgfedredvxpzjpqz.supabase.co/functions/v1/whatsapp-alerts';
  _anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk';
  _running_changed boolean;
  _has_recent_cmd boolean;
  _changer text;
  _is_remote boolean;
  _new_on boolean;
  _old_on boolean;
  _origin_local boolean;
BEGIN
  SELECT alerts_enabled INTO _alerts_enabled
    FROM public.whatsapp_alert_settings
    ORDER BY created_at ASC
    LIMIT 1;

  IF NOT COALESCE(_alerts_enabled, false) THEN
    RETURN NEW;
  END IF;

  -- Compute on/off from PLC outputs (truth source for what hardware is actually doing)
  _new_on := public._eq_output_on(NEW.last_outputs_state, NEW.saida);
  _old_on := public._eq_output_on(OLD.last_outputs_state, OLD.saida);

  _running_changed :=
    (OLD.desired_running IS DISTINCT FROM NEW.desired_running)
    OR (_old_on IS DISTINCT FROM _new_on);

  _origin_local := (
    NEW.last_actuation_origin = 'local'
    AND (OLD.last_actuation_origin IS DISTINCT FROM NEW.last_actuation_origin
         OR OLD.updated_at IS DISTINCT FROM NEW.updated_at)
  );

  IF _running_changed OR _origin_local THEN
    SELECT EXISTS (
      SELECT 1 FROM public.commands
      WHERE equipment_id = NEW.id
        AND created_at > now() - interval '2 minutes'
    ) INTO _has_recent_cmd;

    _changer := COALESCE(NEW.last_changed_by, '');
    _is_remote := (
      _changer ILIKE '%WhatsApp%'
      OR _changer ILIKE '%Usuário Web%'
      OR _changer ILIKE '%auto_schedule%'
      OR _changer ILIKE '%user:%'
      OR NEW.last_actuation_origin IN ('remote','schedule','automation')
    );

    -- Fire if origin is explicitly 'local', OR if state changed without a remote command
    IF NEW.last_actuation_origin = 'local'
       OR (_running_changed AND NOT _has_recent_cmd AND NOT _is_remote) THEN
      PERFORM net.http_post(
        url := _url,
        headers := jsonb_build_object('Authorization', 'Bearer ' || _anon, 'apikey', _anon, 'Content-Type', 'application/json'),
        body := jsonb_build_object(
          'alert_type','local_change',
          'equipment_id',NEW.id,
          'equipment_name',NEW.name,
          'new_running', COALESCE(_new_on, NEW.desired_running),
          'farm_id',NEW.farm_id
        )
      );
    END IF;
  END IF;

  IF (OLD.communication_status IS DISTINCT FROM NEW.communication_status
      AND NEW.communication_status = 'offline') THEN
    PERFORM net.http_post(
      url := _url,
      headers := jsonb_build_object('Authorization', 'Bearer ' || _anon, 'apikey', _anon, 'Content-Type', 'application/json'),
      body := jsonb_build_object('alert_type','offline','equipment_id',NEW.id,'equipment_name',NEW.name,'farm_id',NEW.farm_id)
    );
  END IF;

  IF (OLD.communication_status = 'offline'
      AND NEW.communication_status = 'online') THEN
    PERFORM net.http_post(
      url := _url,
      headers := jsonb_build_object('Authorization', 'Bearer ' || _anon, 'apikey', _anon, 'Content-Type', 'application/json'),
      body := jsonb_build_object('alert_type','back_online','equipment_id',NEW.id,'equipment_name',NEW.name,'farm_id',NEW.farm_id)
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_equipment_change failed: %', SQLERRM;
  RETURN NEW;
END;
$function$;

-- Reattach trigger (was missing on equipments)
DROP TRIGGER IF EXISTS equipment_state_notify ON public.equipments;
CREATE TRIGGER equipment_state_notify
  AFTER UPDATE ON public.equipments
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_equipment_change();