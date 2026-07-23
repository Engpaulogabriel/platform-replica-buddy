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
BEGIN
  SELECT alerts_enabled INTO _alerts_enabled
    FROM public.whatsapp_alert_settings
    ORDER BY created_at ASC
    LIMIT 1;

  IF NOT COALESCE(_alerts_enabled, false) THEN
    RETURN NEW;
  END IF;

  -- Detect on/off state change
  _running_changed := (OLD.desired_running IS DISTINCT FROM NEW.desired_running);

  IF _running_changed THEN
    -- Was there a remote command for this equipment in the last 2 minutes?
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

    IF NOT _has_recent_cmd AND NOT _is_remote THEN
      PERFORM net.http_post(
        url := _url,
        headers := jsonb_build_object('Authorization', 'Bearer ' || _anon, 'apikey', _anon, 'Content-Type', 'application/json'),
        body := jsonb_build_object(
          'alert_type','local_change',
          'equipment_id',NEW.id,
          'equipment_name',NEW.name,
          'new_running',NEW.desired_running,
          'farm_id',NEW.farm_id
        )
      );
    END IF;
  END IF;

  -- OFFLINE
  IF (OLD.communication_status IS DISTINCT FROM NEW.communication_status
      AND NEW.communication_status = 'offline') THEN
    PERFORM net.http_post(
      url := _url,
      headers := jsonb_build_object('Authorization', 'Bearer ' || _anon, 'apikey', _anon, 'Content-Type', 'application/json'),
      body := jsonb_build_object('alert_type','offline','equipment_id',NEW.id,'equipment_name',NEW.name,'farm_id',NEW.farm_id)
    );
  END IF;

  -- BACK ONLINE
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