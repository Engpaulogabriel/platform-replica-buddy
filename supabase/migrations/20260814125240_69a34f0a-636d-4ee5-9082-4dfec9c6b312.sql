-- ── 1) Marcação de ruído (NULL = evento oficial válido) ─────────────────────
ALTER TABLE public.automation_log
  ADD COLUMN IF NOT EXISTS noise_reason text;

COMMENT ON COLUMN public.automation_log.noise_reason IS
  'NULL = transição confirmada (entra no relatório oficial). Preenchido = ruído técnico '
  '(not_confirmed | reading_origin | no_equipment | repeated_state) — fica na trilha, fora do histórico.';

CREATE INDEX IF NOT EXISTS idx_automation_log_official
  ON public.automation_log (farm_id, occurred_at DESC)
  WHERE noise_reason IS NULL
    AND action IN ('turn_on','turn_off','pump_on','pump_off');

CREATE INDEX IF NOT EXISTS idx_automation_log_equip_time
  ON public.automation_log (equipment_id, occurred_at)
  WHERE equipment_id IS NOT NULL;

-- ── 2) Guarda única de transição ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_automation_log_state_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_state SMALLINT;
  v_last_state SMALLINT;
  v_demote text := NULL;
BEGIN
  IF NEW.action NOT IN ('turn_on','turn_off','pump_on','pump_off') THEN
    RETURN NEW;
  END IF;

  IF NEW.equipment_id IS NULL THEN
    v_demote := 'no_equipment';
  ELSIF NEW.origin = 'reading'::public.event_origin THEN
    v_demote := 'reading_origin';
  ELSIF NEW.result IS DISTINCT FROM 'success'::public.event_result THEN
    v_demote := 'not_confirmed';
  END IF;

  IF v_demote IS NOT NULL THEN
    NEW.action := 'status_read'::public.event_action;
    NEW.noise_reason := v_demote;
    RETURN NEW;
  END IF;

  v_new_state := CASE WHEN NEW.action IN ('turn_on','pump_on') THEN 1 ELSE 0 END;

  SELECT last_confirmed_state INTO v_last_state
    FROM public.equipments
   WHERE id = NEW.equipment_id
   FOR UPDATE;

  IF v_last_state IS NOT NULL AND v_last_state = v_new_state THEN
    RETURN NULL;
  END IF;

  UPDATE public.equipments
     SET last_confirmed_state = v_new_state
   WHERE id = NEW.equipment_id;

  NEW.noise_reason := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_automation_log_state_change ON public.automation_log;
CREATE TRIGGER trg_enforce_automation_log_state_change
BEFORE INSERT ON public.automation_log
FOR EACH ROW
EXECUTE FUNCTION public.enforce_automation_log_state_change();