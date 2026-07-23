-- Trigger que gera log de relatório (automation_log) a partir do comando manual
-- usando o usuário REAL que comandou (commands.created_by), não o observador.

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
  -- Só processa transições de manual para um estado terminal com resposta executada
  IF NEW.type <> 'manual' THEN RETURN NEW; END IF;
  IF NEW.status <> 'executed' THEN RETURN NEW; END IF;
  IF OLD.status = 'executed' THEN RETURN NEW; END IF;

  -- Resolve nome do equipamento + saída
  SELECT name, COALESCE(saida, 1)
    INTO v_eq_name, v_saida
  FROM equipments WHERE id = NEW.equipment_id;
  IF v_eq_name IS NULL THEN RETURN NEW; END IF;

  -- Determina ação a partir do payload do FRAME enviado: [TSNN_1_]{XXXXXX}[TSNN_ETX_]
  v_payload := substring(NEW.frame from '\{([01]+)\}');
  IF v_payload IS NULL OR length(v_payload) < v_saida THEN RETURN NEW; END IF;
  v_bit := substr(v_payload, v_saida, 1);
  v_action := CASE WHEN v_bit = '1' THEN 'turn_on'::event_action ELSE 'turn_off'::event_action END;

  v_result := 'success'::event_result;

  -- Resolve usuário real (created_by do comando)
  IF NEW.created_by IS NOT NULL THEN
    SELECT email, full_name INTO v_email, v_name
    FROM profiles WHERE id = NEW.created_by;
  END IF;

  -- Idempotência: usa o id do comando como client_event_id
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
  ON CONFLICT (client_event_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_manual_command ON commands;
CREATE TRIGGER trg_log_manual_command
AFTER UPDATE ON commands
FOR EACH ROW
WHEN (NEW.type = 'manual' AND NEW.status = 'executed' AND OLD.status IS DISTINCT FROM 'executed')
EXECUTE FUNCTION public.log_manual_command_to_automation_log();