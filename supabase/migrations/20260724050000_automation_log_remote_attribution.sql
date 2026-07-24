-- v3.25.30 — Relatório de automação: atribuir comandos REMOTOS corretamente.
--
-- BUGS corrigidos:
-- (P1) Comando remoto que a bomba não obedeceu aparecia como "Acionamento Local"
--      (sem usuário), porque o agente/cron marcam last_actuation_origin='local' e o
--      trigger de state-change logava 'local'.
-- (P2) O user_id sumia em comandos remotos que FALHAVAM: o trigger trg_log_manual_command
--      só dispara WHEN status='executed', então timeout/error nunca eram logados.
--
-- REGRAS (definidas pelo operador):
--  1. LOCAL de verdade = RX muda de estado SEM comando recente → origin='local', user=null.
--  2. REMOTO (veio de commands) = origin='remote' + user_id do created_by, SEMPRE — mesmo
--     quando falha (result='fail').
--  3. Reforço esgotou/bomba não desligou = origin='remote', result='fail', user preservado.
--
-- (O agente v3.25.30 passou a marcar esses comandos como 'timeout' em vez de 'cancelled',
--  preservando o created_by. O last_actuation_origin='local' que ele grava continua sendo
--  necessário para a SEGURANÇA do relé/polling — a atribuição do relatório é feita aqui.)

-- ── 1) Trigger de comando manual: disparar também em falha (timeout/error), não só executed
DROP TRIGGER IF EXISTS trg_log_manual_command ON public.commands;
CREATE TRIGGER trg_log_manual_command
  AFTER UPDATE ON public.commands
  FOR EACH ROW
  WHEN (
    new.type = 'manual'::public.command_type
    AND new.status IN ('executed'::public.command_status, 'timeout'::public.command_status, 'error'::public.command_status)
    AND old.status IS DISTINCT FROM new.status
  )
  EXECUTE FUNCTION public.log_manual_command_to_automation_log();

-- ── 2) Função de log de comando: aceitar os status de falha (result já vira 'fail')
CREATE OR REPLACE FUNCTION public.log_manual_command_to_automation_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_equipment_name text;
  v_action public.event_action;
  v_email text;
  v_details jsonb;
  v_origin public.event_origin;
  v_actor_label text;
BEGIN
  -- v3.25.30: loga executed (sucesso) E timeout/error (falha). Assim um comando REMOTO
  -- que falhou continua no relatório como origin='remote', result='fail', com o usuário.
  IF NEW.type <> 'manual'::public.command_type
     OR NEW.status NOT IN ('executed'::public.command_status, 'timeout'::public.command_status, 'error'::public.command_status)
     OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT name INTO v_equipment_name
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

  v_details := jsonb_build_object(
    'type', 'manual',
    'command_id', NEW.id,
    'frame', NEW.frame,
    'systemic', NEW.created_by IS NULL,
    'error_message', NEW.error_message
  );

  INSERT INTO public.automation_log (
    farm_id, user_id, user_email, equipment_id, equipment_name,
    action, origin, actor_label, result, occurred_at, source_device, details, client_event_id
  ) VALUES (
    NEW.farm_id, NEW.created_by, v_email, NEW.equipment_id, COALESCE(v_equipment_name, 'Equipamento'),
    v_action, v_origin, v_actor_label,
    CASE WHEN NEW.status IN ('error'::public.command_status, 'timeout'::public.command_status, 'cancelled'::public.command_status)
         THEN 'fail'::public.event_result ELSE 'success'::public.event_result END,
    COALESCE(NEW.responded_at, NEW.sent_at, NEW.created_at, now()),
    NEW.source_device, v_details, NEW.client_event_id
  )
  ON CONFLICT (farm_id, client_event_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- ── 3) Trigger de state-change: NÃO logar local/reading quando há comando recente
--       (a atuação é atribuível ao comando, já logado acima com o usuário). Só loga
--       'local'/'reading' quando NÃO há comando recente (regra 1 — local de verdade).
CREATE OR REPLACE FUNCTION public.log_equipment_state_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_saida_idx int;
  v_old_running boolean;
  v_new_running boolean;
  v_origin public.event_origin;
  v_action public.event_action;
  v_dup_count int;
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
    v_old_running := false;
  END IF;

  IF NEW.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_new_running := substring(NEW.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF NEW.last_outputs_state ~ '^[01]$' THEN
    v_new_running := NEW.last_outputs_state = '1';
  ELSE
    v_new_running := false;
  END IF;

  IF v_old_running IS NOT DISTINCT FROM v_new_running THEN
    RETURN NEW;
  END IF;

  v_origin := CASE
    WHEN NEW.last_actuation_origin = 'local' THEN 'local'::public.event_origin
    WHEN NEW.last_actuation_origin = 'remote' THEN 'remote'::public.event_origin
    ELSE 'reading'::public.event_origin
  END;

  IF v_origin = 'remote'::public.event_origin THEN
    RETURN NEW;
  END IF;

  -- v3.25.30: se há comando manual/automação recente (≤120s) para esta bomba, a
  -- mudança de estado é atribuível a esse comando (logado por
  -- log_manual_command_to_automation_log, com o usuário). NÃO loga como local/reading.
  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.equipment_id = NEW.id
      AND c.type IN ('manual'::public.command_type, 'automation'::public.command_type)
      AND COALESCE(c.sent_at, c.created_at) > now() - interval '120 seconds'
  ) THEN
    RETURN NEW;
  END IF;

  v_action := CASE WHEN v_new_running THEN 'turn_on'::public.event_action ELSE 'turn_off'::public.event_action END;

  SELECT count(*) INTO v_dup_count
  FROM public.automation_log
  WHERE equipment_id = NEW.id AND action = v_action AND occurred_at > now() - interval '5 seconds';

  IF v_dup_count > 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.automation_log (
    farm_id, equipment_id, equipment_name, occurred_at, origin, action, result,
    new_state, client_event_id, source_device, details
  )
  VALUES (
    NEW.farm_id, NEW.id, NEW.name, COALESCE(NEW.last_communication, now()),
    v_origin, v_action, 'success'::public.event_result, NEW.last_outputs_state,
    gen_random_uuid(), 'auto-trigger',
    jsonb_build_object('actuation_origin', NEW.last_actuation_origin)
  );

  RETURN NEW;
END;
$function$;
