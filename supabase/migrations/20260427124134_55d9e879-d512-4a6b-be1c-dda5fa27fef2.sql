CREATE OR REPLACE FUNCTION public.cancel_protective_reset_on_remote_start()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_saida_idx int;
  v_new_running boolean := false;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NEW.type NOT IN ('poco', 'bombeamento') THEN
    RETURN NEW;
  END IF;

  v_saida_idx := COALESCE(NEW.saida, 1);

  IF NEW.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_new_running := substring(NEW.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF NEW.last_outputs_state ~ '^[01]$' THEN
    v_new_running := NEW.last_outputs_state = '1';
  END IF;

  IF v_new_running
     AND COALESCE(NEW.desired_running, false) = true
     AND COALESCE(NEW.last_actuation_origin, '') = 'remote' THEN
    UPDATE public.commands
    SET status = 'cancelled',
        responded_at = now(),
        error_message = 'Cancelado: bomba confirmou ligada por comando da pagina antes do TX 0 automatico'
    WHERE farm_id = NEW.farm_id
      AND equipment_id = NEW.id
      AND status IN ('pending', 'sent')
      AND source_device IN (
        'backend-reset:local_startup_detected',
        'backend-reset:local_shutdown_detected'
      );
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_cancel_protective_reset_on_remote_start ON public.equipments;
CREATE TRIGGER trg_cancel_protective_reset_on_remote_start
AFTER UPDATE OF last_outputs_state, desired_running, last_actuation_origin ON public.equipments
FOR EACH ROW
EXECUTE FUNCTION public.cancel_protective_reset_on_remote_start();

REVOKE ALL ON FUNCTION public.cancel_protective_reset_on_remote_start() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_protective_reset_on_remote_start() FROM anon;