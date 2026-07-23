-- Recria o trigger que gera registros de automation_log a partir de comandos
-- manuais confirmados, usando commands.created_by como autor real.
CREATE OR REPLACE FUNCTION public.log_manual_command_to_automation_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eq_name text;
  v_action  event_action;
  v_result  event_result;
  v_email   text;
  v_name    text;
  v_payload text;
  v_saida   smallint;
  v_bit     char;
BEGIN
  IF NEW.type <> 'manual' THEN RETURN NEW; END IF;
  IF NEW.status <> 'executed' THEN RETURN NEW; END IF;
  IF OLD.status = 'executed' THEN RETURN NEW; END IF;

  SELECT name, COALESCE(saida, 1)
    INTO v_eq_name, v_saida
  FROM equipments WHERE id = NEW.equipment_id;
  IF v_eq_name IS NULL THEN RETURN NEW; END IF;

  v_payload := substring(NEW.frame from '\{([01]+)\}');
  IF v_payload IS NULL OR length(v_payload) < v_saida THEN RETURN NEW; END IF;
  v_bit := substr(v_payload, v_saida, 1);
  v_action := CASE WHEN v_bit = '1' THEN 'turn_on'::event_action ELSE 'turn_off'::event_action END;

  v_result := 'success'::event_result;

  IF NEW.created_by IS NOT NULL THEN
    SELECT email, full_name INTO v_email, v_name
    FROM profiles WHERE id = NEW.created_by;
  END IF;

  INSERT INTO automation_log (
    client_event_id,
    farm_id,
    user_id,
    user_email,
    equipment_id,
    equipment_name,
    action,
    origin,
    result,
    occurred_at,
    source_device,
    details
  ) VALUES (
    NEW.id,
    NEW.farm_id,
    NEW.created_by,
    v_email,
    NEW.equipment_id,
    v_eq_name,
    v_action,
    'remote'::event_origin,
    v_result,
    COALESCE(NEW.responded_at, now()),
    NEW.source_device,
    CASE WHEN v_name IS NOT NULL THEN jsonb_build_object('user_name', v_name) ELSE NULL END
  )
  ON CONFLICT (farm_id, client_event_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_manual_command ON public.commands;
CREATE TRIGGER trg_log_manual_command
AFTER UPDATE ON public.commands
FOR EACH ROW
WHEN (NEW.type = 'manual' AND NEW.status = 'executed' AND OLD.status IS DISTINCT FROM 'executed')
EXECUTE FUNCTION public.log_manual_command_to_automation_log();