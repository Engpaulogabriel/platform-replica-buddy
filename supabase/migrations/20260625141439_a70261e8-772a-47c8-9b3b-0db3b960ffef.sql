CREATE OR REPLACE FUNCTION public.enforce_maintenance_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Releasing maintenance always permitted.
  IF COALESCE(NEW.maintenance_mode, false) = false THEN
    RETURN NEW;
  END IF;

  -- Block ONLY transitions of desired_running from false -> true while in maintenance.
  -- Activating maintenance on an already-running pump is allowed; turning OFF is allowed.
  IF COALESCE(NEW.desired_running, false) = true
     AND COALESCE(OLD.desired_running, false) = false THEN
    RAISE EXCEPTION 'Equipamento em MANUTENÇÃO — não é possível LIGAR. Libere a manutenção primeiro.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_maintenance_lock ON public.equipments;
CREATE TRIGGER trg_enforce_maintenance_lock
BEFORE UPDATE ON public.equipments
FOR EACH ROW
EXECUTE FUNCTION public.enforce_maintenance_lock();