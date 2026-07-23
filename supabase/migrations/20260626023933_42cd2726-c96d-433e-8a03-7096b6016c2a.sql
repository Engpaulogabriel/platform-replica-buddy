
-- 1) Columns to track WHO made the change
ALTER TABLE public.equipments ADD COLUMN IF NOT EXISTS last_changed_by TEXT;
ALTER TABLE public.automation_engine ADD COLUMN IF NOT EXISTS last_changed_by TEXT;
ALTER TABLE public.automation_engine ADD COLUMN IF NOT EXISTS last_changed_via TEXT;
ALTER TABLE public.automation_schedules ADD COLUMN IF NOT EXISTS last_toggled_by TEXT;
ALTER TABLE public.automation_schedules ADD COLUMN IF NOT EXISTS last_toggled_via TEXT;

-- 2) Pending notifications queue (drained by whatsapp-automation-notify cron)
CREATE TABLE IF NOT EXISTS public.pending_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID,
  equipment_id UUID,
  change_type TEXT NOT NULL,         -- 'equipment_state' | 'engine_mode' | 'schedule_mode'
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  changed_via TEXT,                  -- 'frontend' | 'whatsapp' | 'automacao' | 'local' | 'api'
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_notifications_unprocessed_idx
  ON public.pending_notifications (created_at)
  WHERE processed = FALSE;

CREATE INDEX IF NOT EXISTS pending_notifications_dedupe_idx
  ON public.pending_notifications (equipment_id, change_type, created_at DESC);

GRANT ALL ON public.pending_notifications TO service_role;
ALTER TABLE public.pending_notifications ENABLE ROW LEVEL SECURITY;

-- Only service_role (via edge functions) touches this table.
CREATE POLICY "Service role full access pending_notifications"
  ON public.pending_notifications
  FOR ALL
  TO service_role
  USING (TRUE) WITH CHECK (TRUE);

-- 3) Trigger: equipments physical state change (bit at saida-1 in last_outputs_state)
CREATE OR REPLACE FUNCTION public.notify_equipment_state_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_idx INT;
  v_old_bit TEXT;
  v_new_bit TEXT;
BEGIN
  IF NEW.last_outputs_state IS NULL THEN RETURN NEW; END IF;
  IF NEW.last_outputs_state = COALESCE(OLD.last_outputs_state, '') THEN RETURN NEW; END IF;

  v_idx := COALESCE(NEW.saida, 1) - 1;
  v_old_bit := substr(COALESCE(OLD.last_outputs_state, ''), v_idx + 1, 1);
  v_new_bit := substr(NEW.last_outputs_state, v_idx + 1, 1);

  IF v_old_bit = v_new_bit THEN RETURN NEW; END IF;
  IF v_new_bit NOT IN ('0','1') THEN RETURN NEW; END IF;

  INSERT INTO public.pending_notifications (
    farm_id, equipment_id, change_type, old_value, new_value,
    changed_by, changed_via, payload
  ) VALUES (
    NEW.farm_id, NEW.id, 'equipment_state',
    CASE WHEN v_old_bit = '1' THEN 'on' ELSE 'off' END,
    CASE WHEN v_new_bit = '1' THEN 'on' ELSE 'off' END,
    NEW.last_changed_by,
    COALESCE(NEW.last_actuation_origin, 'unknown'),
    jsonb_build_object(
      'equipment_name', NEW.name,
      'saida', NEW.saida,
      'actuation_origin', NEW.last_actuation_origin
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS equipments_state_notify ON public.equipments;
CREATE TRIGGER equipments_state_notify
  AFTER UPDATE ON public.equipments
  FOR EACH ROW EXECUTE FUNCTION public.notify_equipment_state_change();

-- 4) Trigger: automation_engine.enabled toggled
CREATE OR REPLACE FUNCTION public.notify_engine_mode_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.enabled, FALSE) IS NOT DISTINCT FROM COALESCE(NEW.enabled, FALSE) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.pending_notifications (
    farm_id, change_type, old_value, new_value, changed_by, changed_via, payload
  ) VALUES (
    NEW.farm_id, 'engine_mode',
    CASE WHEN COALESCE(OLD.enabled, FALSE) THEN 'on' ELSE 'off' END,
    CASE WHEN COALESCE(NEW.enabled, FALSE) THEN 'on' ELSE 'off' END,
    NEW.last_changed_by,
    COALESCE(NEW.last_changed_via, 'unknown'),
    '{}'::jsonb
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS automation_engine_mode_notify ON public.automation_engine;
CREATE TRIGGER automation_engine_mode_notify
  AFTER UPDATE ON public.automation_engine
  FOR EACH ROW EXECUTE FUNCTION public.notify_engine_mode_change();

-- 5) Trigger: automation_schedules toggled / created
CREATE OR REPLACE FUNCTION public.notify_schedule_mode_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old_active BOOLEAN;
  v_new_active BOOLEAN;
BEGIN
  v_new_active := COALESCE(NEW.active, FALSE);
  IF TG_OP = 'INSERT' THEN
    IF NOT v_new_active THEN RETURN NEW; END IF;
    v_old_active := FALSE;
  ELSE
    v_old_active := COALESCE(OLD.active, FALSE);
    IF v_old_active = v_new_active THEN RETURN NEW; END IF;
  END IF;

  INSERT INTO public.pending_notifications (
    farm_id, equipment_id, change_type, old_value, new_value,
    changed_by, changed_via, payload
  ) VALUES (
    NEW.farm_id, NEW.equipment_id, 'schedule_mode',
    CASE WHEN v_old_active THEN 'on' ELSE 'off' END,
    CASE WHEN v_new_active THEN 'on' ELSE 'off' END,
    NEW.last_toggled_by,
    COALESCE(NEW.last_toggled_via, 'unknown'),
    jsonb_build_object(
      'schedule_id', NEW.id,
      'time_on', NEW.time_on,
      'time_off', NEW.time_off,
      'mode', NEW.mode,
      'days', NEW.days,
      'op', TG_OP
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS automation_schedules_mode_notify ON public.automation_schedules;
CREATE TRIGGER automation_schedules_mode_notify
  AFTER INSERT OR UPDATE OF active ON public.automation_schedules
  FOR EACH ROW EXECUTE FUNCTION public.notify_schedule_mode_change();
