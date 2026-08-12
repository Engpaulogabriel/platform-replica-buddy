-- ============================================================================
-- FIX: comando REMOTO que a bomba OBEDECEU não pode aparecer como "Falhou".
-- ----------------------------------------------------------------------------
-- Bug: log_manual_command_to_automation_log() gravava result='fail' sempre que o
-- comando manual virava timeout/error/cancelled — SEM olhar o estado real. O
-- agente v3.25.63 confirma o acionamento, mas quando a telemetria de retorno
-- chega DEPOIS da janela de 60s do pending_command, o comando não é marcado
-- 'executed' → um sweep marca 'timeout' → o trigger logava 'fail' mesmo com a
-- bomba ligada. (Ex.: 18 acionamentos remotos do operador, todos com a bomba ON,
-- apareciam como "Falhou" no Relatório de Automação.)
--
-- Correção: o result agora é 'success' quando o comando executou OU quando o
-- estado REAL do equipamento (bit da saída em last_outputs_state) confirma a
-- intenção do comando (turn_on→bit 1, turn_off→bit 0). Só marca 'fail' quando
-- o comando falhou E o estado NÃO chegou ao desejado. NÃO altera a lógica de
-- segurança (janela do pending_command / relé) — só a atribuição do relatório.
--
-- Idempotente. O trigger trg_log_manual_command permanece igual (chama a função
-- por nome). Aplicar via push (Lovable) ou SQL Editor.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.log_manual_command_to_automation_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_equipment_name text;
  v_saida int;
  v_outs text;
  v_running boolean;        -- estado REAL atual do equipamento (bit da saída)
  v_state_ok boolean := false;
  v_action public.event_action;
  v_email text;
  v_details jsonb;
  v_origin public.event_origin;
  v_actor_label text;
  v_result public.event_result;
BEGIN
  IF NEW.type <> 'manual'::public.command_type
     OR NEW.status NOT IN ('executed'::public.command_status, 'timeout'::public.command_status, 'error'::public.command_status)
     OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT name, COALESCE(saida, 1), last_outputs_state
    INTO v_equipment_name, v_saida, v_outs
    FROM public.equipments
   WHERE id = NEW.equipment_id;

  IF NEW.created_by IS NULL THEN
    v_origin := 'system'::public.event_origin;
    v_actor_label := 'Sistema (proteção automática)';
    v_email := NULL;
  ELSE
    v_origin := 'remote'::public.event_origin;
    v_actor_label := NULL;
    SELECT email INTO v_email FROM public.profiles WHERE id = NEW.created_by;
  END IF;

  v_action := CASE
    WHEN NEW.frame LIKE '%{1}%' OR NEW.frame LIKE '%{01}%' OR NEW.frame LIKE '%{001}%' OR NEW.frame LIKE '%{0001}%' OR NEW.frame LIKE '%{00001}%' OR NEW.frame LIKE '%{000001}%'
      THEN 'turn_on'::public.event_action
    ELSE 'turn_off'::public.event_action
  END;

  -- Estado REAL atual (bit da saída no last_outputs_state).
  IF v_outs ~ '^[01]{6}$' AND v_saida BETWEEN 1 AND 6 THEN
    v_running := substring(v_outs from v_saida for 1) = '1';
  ELSIF v_outs ~ '^[01]$' THEN
    v_running := v_outs = '1';
  ELSE
    v_running := NULL;
  END IF;
  -- A telemetria confirma que o equipamento chegou ao estado que o comando pediu?
  v_state_ok := (v_running IS NOT NULL)
                AND (v_running = (v_action = 'turn_on'::public.event_action));

  -- SUCESSO se o comando executou OU se o estado real confirma a intenção
  -- (confirmação tardia após o timeout do pending_command não vira "Falhou").
  IF NEW.status = 'executed'::public.command_status OR v_state_ok THEN
    v_result := 'success'::public.event_result;
  ELSE
    v_result := 'fail'::public.event_result;
  END IF;

  v_details := jsonb_build_object(
    'type', 'manual',
    'command_id', NEW.id,
    'frame', NEW.frame,
    'systemic', NEW.created_by IS NULL,
    'error_message', NEW.error_message,
    'command_status', NEW.status,       -- status bruto do comando (auditoria)
    'state_confirmed', v_state_ok       -- true = telemetria confirmou o estado
  );

  INSERT INTO public.automation_log (
    farm_id, user_id, user_email, equipment_id, equipment_name,
    action, origin, actor_label, result, occurred_at, source_device, details, client_event_id
  ) VALUES (
    NEW.farm_id, NEW.created_by, v_email, NEW.equipment_id, COALESCE(v_equipment_name, 'Equipamento'),
    v_action, v_origin, v_actor_label, v_result,
    COALESCE(NEW.responded_at, NEW.sent_at, NEW.created_at, now()),
    NEW.source_device, v_details, NEW.client_event_id
  )
  ON CONFLICT (farm_id, client_event_id) DO NOTHING;

  RETURN NEW;
END;
$function$;
