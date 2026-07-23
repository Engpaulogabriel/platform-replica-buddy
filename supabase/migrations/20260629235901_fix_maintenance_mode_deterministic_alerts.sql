-- Critical fix: maintenance mode is deterministic and silent for alerts.
ALTER TABLE public.equipments ADD COLUMN IF NOT EXISTS maintenance_mode BOOLEAN DEFAULT false;

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
  _anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk';
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
  _has_real_offline_alert boolean;
  _has_recent_offline_flap boolean;
  _offline_min int;
  _output_count int;
  _is_level_sensor boolean;
BEGIN
  SELECT alerts_enabled, COALESCE(alert_local_change_enabled, true)
    INTO _alerts_enabled, _local_enabled
    FROM public.whatsapp_alert_settings
    ORDER BY created_at ASC
    LIMIT 1;

  -- Equipamento em manutenção não gera alertas de liga/desliga/offline/back_online.
  IF COALESCE(NEW.maintenance_mode, false) = true THEN
    RETURN NEW;
  END IF;

  _is_level_sensor := (
    COALESCE(NEW.type::text, '') IN ('nivel', 'repetidor')
    OR COALESCE(NEW.name, '') ILIKE '%canal%'
  );

  _new_on := public._eq_output_on(NEW.last_outputs_state, NEW.saida);
  _old_on := public._eq_output_on(OLD.last_outputs_state, OLD.saida);
  _effective_new_on := COALESCE(_new_on, NEW.desired_running);
  _effective_old_on := COALESCE(_old_on, OLD.desired_running);

  _running_changed := _effective_old_on IS DISTINCT FROM _effective_new_on;

  -- Sensores de nível/canais/repetidores não são bombas: não geram LIGOU/DESLIGOU.
  -- Mantemos a sequência do trigger para ainda permitir alertas de comunicação offline/back_online.
  IF NOT COALESCE(_is_level_sensor, false)
     AND COALESCE(_alerts_enabled, false)
     AND COALESCE(_local_enabled, true)
     AND _running_changed THEN
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
          AND pn.created_at > now() - interval '30 minutes'
        UNION ALL
        SELECT 1
        FROM public.whatsapp_alerts_log wal
        WHERE wal.equipment_id = NEW.id
          AND wal.alert_type = 'local_change'
          AND wal.created_at > now() - interval '30 minutes'
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

  -- Janela de offline diferenciada por número de saídas do PLC:
  -- 1 saída = 15 min; múltiplas saídas = 20 min.
  IF NEW.plc_group_id IS NULL THEN
    _output_count := 1;
  ELSE
    SELECT COALESCE(pg.output_count, 1)
      INTO _output_count
      FROM public.plc_groups pg
     WHERE pg.id = NEW.plc_group_id;

    IF _output_count IS NULL THEN
      SELECT COUNT(*) INTO _output_count
        FROM public.equipments
       WHERE plc_group_id = NEW.plc_group_id
         AND active = true;
    END IF;
  END IF;
  _offline_min := CASE WHEN COALESCE(_output_count, 1) > 1 THEN 20 ELSE 15 END;

  IF COALESCE(_alerts_enabled, false)
     AND (OLD.communication_status IS DISTINCT FROM NEW.communication_status)
     AND NEW.communication_status IN ('offline', 'online')
     AND (OLD.communication_status = 'offline' OR NEW.communication_status = 'offline') THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.whatsapp_alerts_log
      WHERE equipment_id = NEW.id
        AND alert_type IN ('offline', 'back_online')
        AND created_at > now() - interval '5 minutes'
      LIMIT 1
    ) INTO _has_recent_offline_flap;

    IF COALESCE(_has_recent_offline_flap, false) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF COALESCE(_alerts_enabled, false)
     AND (OLD.communication_status IS DISTINCT FROM NEW.communication_status)
     AND NEW.communication_status = 'offline' THEN
    IF NEW.last_communication IS NOT NULL
       AND NEW.last_communication < now() - make_interval(mins => _offline_min) THEN
      PERFORM net.http_post(
        url := _url,
        headers := jsonb_build_object('Authorization', 'Bearer ' || _anon, 'apikey', _anon, 'Content-Type', 'application/json'),
        body := jsonb_build_object('alert_type','offline','equipment_id',NEW.id,'equipment_name',NEW.name,'farm_id',NEW.farm_id)
      );
    END IF;
  END IF;

  IF COALESCE(_alerts_enabled, false)
     AND OLD.communication_status = 'offline'
     AND NEW.communication_status = 'online' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.whatsapp_alerts_log
      WHERE equipment_id = NEW.id
        AND alert_type = 'offline'
        AND created_at < now() - interval '5 minutes'
        AND created_at > now() - interval '24 hours'
      LIMIT 1
    ) INTO _has_real_offline_alert;

    IF COALESCE(_has_real_offline_alert, false) THEN
      PERFORM net.http_post(
        url := _url,
        headers := jsonb_build_object('Authorization', 'Bearer ' || _anon, 'apikey', _anon, 'Content-Type', 'application/json'),
        body := jsonb_build_object('alert_type','back_online','equipment_id',NEW.id,'equipment_name',NEW.name,'farm_id',NEW.farm_id)
      );
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_equipment_change failed: %', SQLERRM;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS equipment_state_notify ON public.equipments;
CREATE TRIGGER equipment_state_notify
AFTER UPDATE ON public.equipments
FOR EACH ROW
EXECUTE FUNCTION public.notify_equipment_change();

DELETE FROM public.pending_notifications pn
USING public.equipments e
WHERE pn.equipment_id = e.id
  AND pn.change_type = 'local_change'
  AND (
    COALESCE(e.type::text, '') IN ('nivel', 'repetidor')
    OR COALESCE(e.name, '') ILIKE '%canal%'
  );