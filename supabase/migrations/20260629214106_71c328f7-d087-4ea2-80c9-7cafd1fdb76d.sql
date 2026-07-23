CREATE OR REPLACE FUNCTION public.notify_engine_mode_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.enabled IS DISTINCT FROM NEW.enabled THEN
    INSERT INTO public.pending_notifications (
      farm_id,
      equipment_id,
      change_type,
      old_value,
      new_value,
      changed_by,
      changed_via,
      payload
    ) VALUES (
      NEW.farm_id,
      NULL,
      'engine_mode',
      CASE WHEN OLD.enabled THEN 'on' ELSE 'off' END,
      CASE WHEN NEW.enabled THEN 'on' ELSE 'off' END,
      COALESCE(NULLIF(NEW.last_changed_by, ''), 'Usuário Web'),
      COALESCE(NULLIF(NEW.last_changed_via, ''), 'frontend'),
      jsonb_build_object('source_table', 'automation_engine')
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_engine_mode_change failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_schedule_mode_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.active, false) THEN
      INSERT INTO public.pending_notifications (
        farm_id,
        equipment_id,
        change_type,
        old_value,
        new_value,
        changed_by,
        changed_via,
        payload
      ) VALUES (
        NEW.farm_id,
        NEW.equipment_id,
        'schedule_mode',
        'off',
        'on',
        COALESCE(NULLIF(NEW.last_toggled_by, ''), NULLIF(NEW.created_by_name, ''), NULLIF(NEW.last_modified_by_name, ''), 'Usuário Web'),
        COALESCE(NULLIF(NEW.last_toggled_via, ''), NULLIF(NEW.created_by_via, ''), NULLIF(NEW.last_modified_by_via, ''), 'frontend'),
        jsonb_build_object('source_table', 'automation_schedules', 'schedule_id', NEW.id, 'operation', TG_OP)
      );
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.active IS DISTINCT FROM NEW.active THEN
      INSERT INTO public.pending_notifications (
        farm_id,
        equipment_id,
        change_type,
        old_value,
        new_value,
        changed_by,
        changed_via,
        payload
      ) VALUES (
        NEW.farm_id,
        NEW.equipment_id,
        'schedule_mode',
        CASE WHEN OLD.active THEN 'on' ELSE 'off' END,
        CASE WHEN NEW.active THEN 'on' ELSE 'off' END,
        COALESCE(NULLIF(NEW.last_toggled_by, ''), NULLIF(NEW.last_modified_by_name, ''), 'Usuário Web'),
        COALESCE(NULLIF(NEW.last_toggled_via, ''), NULLIF(NEW.last_modified_by_via, ''), 'frontend'),
        jsonb_build_object('source_table', 'automation_schedules', 'schedule_id', NEW.id, 'operation', TG_OP)
      );
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_schedule_mode_change failed: %', SQLERRM;
  RETURN NEW;
END;
$$;