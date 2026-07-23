-- Ensure the pending notification queue is reachable by backend functions
GRANT ALL ON public.pending_notifications TO service_role;

-- Global automation engine mode changes (farm-level)
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
      COALESCE(NEW.last_changed_by, 'Usuário Web'),
      COALESCE(NEW.last_changed_via, 'frontend'),
      jsonb_build_object('source_table', 'automation_engine')
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_engine_mode_change failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS automation_engine_mode_notify ON public.automation_engine;
CREATE TRIGGER automation_engine_mode_notify
AFTER UPDATE ON public.automation_engine
FOR EACH ROW
EXECUTE FUNCTION public.notify_engine_mode_change();

-- Equipment automatic/schedule mode changes (equipment-level)
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
        COALESCE(NEW.last_toggled_by, NEW.created_by_name, NEW.last_modified_by_name, 'Usuário Web'),
        COALESCE(NEW.last_toggled_via, NEW.created_by_via, NEW.last_modified_by_via, 'frontend'),
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
        COALESCE(NEW.last_toggled_by, NEW.last_modified_by_name, 'Usuário Web'),
        COALESCE(NEW.last_toggled_via, NEW.last_modified_by_via, 'frontend'),
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

DROP TRIGGER IF EXISTS automation_schedule_mode_notify_insert ON public.automation_schedules;
DROP TRIGGER IF EXISTS automation_schedule_mode_notify_update ON public.automation_schedules;
DROP TRIGGER IF EXISTS automation_schedule_mode_notify ON public.automation_schedules;

CREATE TRIGGER automation_schedule_mode_notify_insert
AFTER INSERT ON public.automation_schedules
FOR EACH ROW
EXECUTE FUNCTION public.notify_schedule_mode_change();

CREATE TRIGGER automation_schedule_mode_notify_update
AFTER UPDATE OF active ON public.automation_schedules
FOR EACH ROW
EXECUTE FUNCTION public.notify_schedule_mode_change();

-- Equipment state changes from dashboard/bridge/WhatsApp
CREATE OR REPLACE FUNCTION public.notify_equipment_state_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_saida_idx integer;
  v_old_running boolean;
  v_new_running boolean;
BEGIN
  IF NEW.type NOT IN ('poco', 'bombeamento') THEN
    RETURN NEW;
  END IF;

  v_saida_idx := COALESCE(NEW.saida, 1);

  IF OLD.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_old_running := substring(OLD.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF OLD.last_outputs_state ~ '^[01]$' THEN
    v_old_running := OLD.last_outputs_state = '1';
  ELSE
    v_old_running := COALESCE(OLD.desired_running, false);
  END IF;

  IF NEW.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_new_running := substring(NEW.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF NEW.last_outputs_state ~ '^[01]$' THEN
    v_new_running := NEW.last_outputs_state = '1';
  ELSE
    v_new_running := COALESCE(NEW.desired_running, false);
  END IF;

  IF v_old_running IS DISTINCT FROM v_new_running THEN
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
      NEW.id,
      'equipment_state',
      CASE WHEN v_old_running THEN 'on' ELSE 'off' END,
      CASE WHEN v_new_running THEN 'on' ELSE 'off' END,
      COALESCE(NEW.last_changed_by, 'Usuário Web'),
      COALESCE(NEW.last_actuation_origin, 'unknown'),
      jsonb_build_object('source_table', 'equipments', 'desired_running', NEW.desired_running)
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_equipment_state_change failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS equipment_state_notify ON public.equipments;
CREATE TRIGGER equipment_state_notify
AFTER UPDATE OF last_outputs_state, desired_running ON public.equipments
FOR EACH ROW
EXECUTE FUNCTION public.notify_equipment_state_change();