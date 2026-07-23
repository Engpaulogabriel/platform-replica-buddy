
-- 1) Column on equipments
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS last_confirmed_state SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.equipments.last_confirmed_state IS
  'Último estado real confirmado da bomba (0=desligada, 1=ligada). Atualizado apenas quando o automation_log registra mudança real via trigger enforce_automation_log_state_change.';

-- 2) Backfill from latest turn_on/turn_off in automation_log
WITH last_ev AS (
  SELECT DISTINCT ON (equipment_id)
    equipment_id,
    action
  FROM public.automation_log
  WHERE equipment_id IS NOT NULL
    AND action IN ('turn_on','turn_off','pump_on','pump_off')
  ORDER BY equipment_id, occurred_at DESC
)
UPDATE public.equipments e
SET last_confirmed_state = CASE
    WHEN last_ev.action IN ('turn_on','pump_on') THEN 1
    ELSE 0
  END
FROM last_ev
WHERE e.id = last_ev.equipment_id;

-- 3) Trigger function: enforce state-change-only inserts
CREATE OR REPLACE FUNCTION public.enforce_automation_log_state_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_state SMALLINT;
  v_last_state SMALLINT;
BEGIN
  -- Audit-only actions (status readings, mode changes, polling, reset) pass through.
  IF NEW.action NOT IN ('turn_on','turn_off','pump_on','pump_off') THEN
    RETURN NEW;
  END IF;

  -- Rows without an equipment_id cannot be deduped; pass through as audit.
  IF NEW.equipment_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Failures/timeouts do not confirm a new state — treat as audit passthrough
  -- so we still keep the trail but do not shift last_confirmed_state.
  IF NEW.result IS NOT NULL AND NEW.result <> 'success' THEN
    RETURN NEW;
  END IF;

  v_new_state := CASE WHEN NEW.action IN ('turn_on','pump_on') THEN 1 ELSE 0 END;

  SELECT last_confirmed_state INTO v_last_state
    FROM public.equipments
   WHERE id = NEW.equipment_id
   FOR UPDATE;

  IF v_last_state IS NOT NULL AND v_last_state = v_new_state THEN
    -- No real change → discard this insert.
    RETURN NULL;
  END IF;

  -- Real transition → update equipment state and keep the insert.
  UPDATE public.equipments
     SET last_confirmed_state = v_new_state
   WHERE id = NEW.equipment_id;

  RETURN NEW;
END;
$$;

-- 4) Attach the trigger
DROP TRIGGER IF EXISTS trg_enforce_automation_log_state_change ON public.automation_log;
CREATE TRIGGER trg_enforce_automation_log_state_change
BEFORE INSERT ON public.automation_log
FOR EACH ROW
EXECUTE FUNCTION public.enforce_automation_log_state_change();
