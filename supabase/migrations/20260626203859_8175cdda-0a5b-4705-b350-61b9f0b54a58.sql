CREATE OR REPLACE FUNCTION public.notify_equipment_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  _alerts_enabled boolean;
  _local_enabled boolean;
  _url text := 'https://dnyukgfedredvxpzjpqz.supabase.co/functions/v1/whatsapp-alerts';
  _anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdWJhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk';
  _running_changed boolean;
  _has_recent_cmd boolean;
  _changer text;
  _is_remote boolean;
  _new_on boolean;
  _old_on boolean;
  _effective_new_on boolean;
  _effective_old_on boolean;
  _should_queue_local boolean;
  _recent_local boolean;
  _new_value text;
BEGIN
  SELECT alerts_enabled, COALESCE(alert_local_change_enabled, true)
    INTO _alerts_enabled, _local_enabled
    FROM public.whatsapp_alert_settings
    ORDER BY created_at ASC
    LIMIT 1;

  _new_on := public._eq_output_on(NEW.last_outputs_state, NEW.saida);
  _old_on := public._eq_output_on(OLD.last_outputs_state, OLD.saida);
  _effective_new_on := COALESCE(_new_on, NEW.desired_running);
  _effective_old_on := COALESCE(_old_on, OLD.desired_running);

  _running_changed := _effective_old_on IS DISTINCT FROM _effective_new_on;

  IF COALESCE(_alerts_enabled, false) AND COALESCE(_local_enabled, true) AND _running_changed THEN
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
      OR NEW.last_actuation_origin IN ('remote','schedule','automation','automacao')
    );

    _should_queue_local := (NEW.last_actuation_origin = 'local') OR (NOT _has_recent_cmd AND NOT _is_remote);

    IF _should_queue_local THEN
      _new_value := CASE WHEN COALESCE(_effective_new_on, false) THEN 'on' ELSE 'off' END;

      SELECT EXISTS (
        SELECT 1
        FROM public.pending_notifications pn
        WHERE pn.equipment_id = NEW.id
          AND pn.change_type = 'local_change'
          AND pn.new_value = _new_value
          AND pn.created_at > now() - interval '60 seconds'
        UNION ALL
        SELECT 1
        FROM public.whatsapp_alerts_log wal
        WHERE wal.equipment_id = NEW.id
          AND wal.alert_type = 'local_change'
          AND wal.created_at > now() - interval '60 seconds'
          AND (
            (_new_value = 'on'  AND upper(coalesce(wal.message_sent,'')) LIKE '%LIGOU%' AND upper(coalesce(wal.message_sent,'')) NOT LIKE '%DESLIGOU%')
            OR (_new_value = 'off' AND upper(coalesce(wal.message_sent,'')) LIKE '%DESLIGOU%')
          )
        LIMIT 1
      ) INTO _recent_local;

      IF NOT COALESCE(_recent_local, false) THEN
        INSERT INTO public.pending_notifications (
          farm_id, equipment_id, change_type, old_value, new_value,
          changed_by, changed_via, payload
        ) VALUES (
          NEW.farm_id,
          NEW.id,
          'local_change',
          CASE WHEN COALESCE(_effective_old_on, false) THEN 'on' ELSE 'off' END,
          _new_value,
          COALESCE(NULLIF(NEW.last_changed_by, ''), 'Painel físico'),
          COALESCE(NEW.last_actuation_origin, 'local'),
          jsonb_build_object(
            'alert_type', 'local_change',
            'equipment_name', NEW.name,
            'new_running', COALESCE(_effective_new_on, false),
            'old_running', COALESCE(_effective_old_on, false),
            'saida', NEW.saida,
            'last_outputs_state', NEW.last_outputs_state,
            'actuation_origin', NEW.last_actuation_origin,
            'source_table', 'equipments'
          )
        );
      END IF;
    END IF;
  END IF;

  -- OFFLINE: proteção anti-flap (15 min)
  -- Qualquer escrita do agente Electron que flipe communication_status='offline'
  -- após poucas falhas consecutivas é IGNORADA aqui se last_communication ainda
  -- estiver dentro da janela de 15 minutos. Apenas o cron critical-alerts-tick
  -- (que usa o mesmo limiar) tem autoridade para gerar o alerta WhatsApp.
  IF COALESCE(_alerts_enabled, false)
     AND (OLD.communication_status IS DISTINCT FROM NEW.communication_status)
     AND NEW.communication_status = 'offline' THEN
    IF NEW.last_communication IS NULL
       OR NEW.last_communication < now() - interval '15 minutes' THEN
      PERFORM net.http_post(
        url := _url,
        headers := jsonb_build_object('Authorization', 'Bearer ' || _anon, 'apikey', _anon, 'Content-Type', 'application/json'),
        body := jsonb_build_object('alert_type','offline','equipment_id',NEW.id,'equipment_name',NEW.name,'farm_id',NEW.farm_id)
      );
    END IF;
    -- Caso contrário: flap momentâneo do agente — ignora silenciosamente.
  END IF;

  -- BACK_ONLINE: instantâneo (sem guarda de tempo)
  IF COALESCE(_alerts_enabled, false)
     AND OLD.communication_status = 'offline'
     AND NEW.communication_status = 'online' THEN
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