CREATE OR REPLACE FUNCTION public.attribute_scheduled_shutdown_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rule text;
BEGIN
  IF NEW.equipment_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(NEW.source_device, '') <> 'serial-bridge' THEN RETURN NEW; END IF;
  IF NEW.action NOT IN ('pump_on'::public.event_action, 'pump_off'::public.event_action,
                        'turn_on'::public.event_action, 'turn_off'::public.event_action) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.equipment_id = NEW.equipment_id
      AND c.source_device LIKE 'backend-reset:scheduled_shutdown%'
      AND c.created_at > now() - interval '3 minutes'
  ) THEN
    SELECT NULLIF(btrim(last_changed_by), '') INTO v_rule
      FROM public.equipments WHERE id = NEW.equipment_id;
    NEW.origin := 'auto'::public.event_origin;
    NEW.actor_label := COALESCE(v_rule, 'Desligamento Programado');
    NEW.details := COALESCE(NEW.details, '{}'::jsonb) || jsonb_build_object('scheduled_shutdown', true);
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_attribute_scheduled_shutdown ON public.automation_log;
CREATE TRIGGER trg_attribute_scheduled_shutdown
  BEFORE INSERT ON public.automation_log
  FOR EACH ROW EXECUTE FUNCTION public.attribute_scheduled_shutdown_log();

COMMENT ON FUNCTION public.attribute_scheduled_shutdown_log() IS
  'BEFORE INSERT em automation_log: reatribui a linha de telemetria de um desligamento programado (scheduled-shutdown) para origin=auto + nome da regra.';