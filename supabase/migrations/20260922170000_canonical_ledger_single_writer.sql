-- ============================================================================
-- LEDGER OPERACIONAL CANÔNICO — ETAPA 1: um único produtor
-- ----------------------------------------------------------------------------
-- automation_log não é um ledger hoje: cinco produtores escrevem linha
-- operacional e cada um rotula a si próprio. Em 30 dias, 1.341 das 6.968
-- linhas operacionais repetem o estado da linha anterior do mesmo
-- equipamento — algo impossível num registro de transições.
--
-- Esta migration estabelece UM produtor canônico — log_equipment_state_change,
-- o gatilho da transição física — e rebaixa os demais a registro técnico.
-- NADA é apagado: as linhas continuam na tabela, com autoria, command_id,
-- source_device e details intactos, apenas com noise_reason preenchido.
--
-- O que foi provado no NEW antes de escrever isto:
--  · agent-local-actuation: 1.125 de 1.126 linhas repetem o estado anterior;
--    ZERO representam transição. Na Pérola, TODAS as 2.366 transições reais
--    vêm de auto-trigger (2.183 locais) e serial-bridge (183). O Agent grava o
--    BIT DO PAYLOAD, não uma mudança — por isso repete. Nenhum acionamento
--    local da Pérola se perde.
--  · backend-reset:*: as 46 linhas operacionais são todas 'turn_on_timeout'
--    com command_status='error' e NENHUMA tem par canônico. São comandos que
--    falharam, não acionamentos.
--  · apply_pump_telemetry: das 190 linhas próprias, 160 têm par canônico
--    (duplicata) e 36 na Terra Norte são evidência única. Por isso o
--    rebaixamento aqui é CONDICIONAL: só quando a linha canônica existe.
--  · intenção de comando: hoje só é marcada quando o comando executa com
--    sucesso; timeout/error ficavam operacionais.
--
-- NÃO toca: caminho físico de comando, frame, TX, polling, desired_running,
-- last_outputs_state, reconstrução de bitfield, Agent, rádio, serial,
-- automações. NÃO altera linha histórica. NÃO arma o árbitro
-- (enforce_automation_log_state_change) — ver auditoria no relatório: ele
-- aceita result='success' como prova de confirmação, o que deixaria o eco do
-- comando e o TX de segurança definirem last_confirmed_state.
-- ============================================================================

-- ── 1) PORTÃO DO LEDGER ────────────────────────────────────────────────────
-- Roda ANTES de todos os outros BEFORE INSERT (ordem é alfabética pelo nome do
-- gatilho: trg_a_ledger_gate < trg_attribute_... < trg_enforce_... < trg_z_...).
CREATE OR REPLACE FUNCTION public.ledger_row_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- só linhas de acionamento de bomba entram nesta decisão
  IF NEW.action NOT IN ('turn_on','turn_off','pump_on','pump_off') THEN
    RETURN NEW;
  END IF;
  IF NEW.noise_reason IS NOT NULL THEN
    RETURN NEW;                         -- o produtor já se declarou técnico
  END IF;

  -- (a) RELATO DE ESTADO DO AGENTE. O Agent grava o bit recebido no RX
  -- espontâneo, não uma transição — e grava DEPOIS de já ter chamado
  -- apply_pump_telemetry com o mesmo RX, que por sua vez dispara o gatilho
  -- canônico. É sempre a segunda ou terceira cópia.
  IF NEW.source_device = 'agent-local-actuation' THEN
    NEW.noise_reason := 'agent_local_state_report';
    RETURN NEW;
  END IF;

  -- (b) COMANDO QUE NÃO CONFIRMOU. O próprio details diz que falhou; o
  -- result='success' da linha não pode sobrepor isso. Era assim que
  -- 'TX 0 de seguranca sem confirmacao apos 60s' virava acionamento.
  IF lower(COALESCE(NEW.details->>'command_status','')) IN ('error','timeout','failed','cancelled')
     AND COALESCE(NEW.details->>'state_confirmed','') <> 'true' THEN
    NEW.noise_reason := 'command_not_confirmed';
    RETURN NEW;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_a_ledger_gate ON public.automation_log;
CREATE TRIGGER trg_a_ledger_gate
BEFORE INSERT ON public.automation_log
FOR EACH ROW EXECUTE FUNCTION public.ledger_row_gate();

-- ── 2) INTENÇÃO DE COMANDO NUNCA É LINHA OPERACIONAL ───────────────────────
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
  v_running boolean;
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

  IF v_outs ~ '^[01]{6}$' AND v_saida BETWEEN 1 AND 6 THEN
    v_running := substring(v_outs from v_saida for 1) = '1';
  ELSIF v_outs ~ '^[01]$' THEN
    v_running := v_outs = '1';
  ELSE
    v_running := NULL;
  END IF;
  v_state_ok := (v_running IS NOT NULL)
                AND (v_running = (v_action = 'turn_on'::public.event_action));

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
    'command_status', NEW.status,
    'state_confirmed', v_state_ok
  );

  INSERT INTO public.automation_log (
    farm_id, user_id, user_email, equipment_id, equipment_name,
    action, origin, actor_label, result, occurred_at, source_device, details, client_event_id,
    noise_reason
  ) VALUES (
    NEW.farm_id, NEW.created_by, v_email, NEW.equipment_id, COALESCE(v_equipment_name, 'Equipamento'),
    v_action, v_origin, v_actor_label, v_result,
    COALESCE(NEW.responded_at, NEW.sent_at, NEW.created_at, now()),
    NEW.source_device, v_details, NEW.client_event_id,
    -- RUIDO DE RELATORIO: quando o comando foi EXECUTADO com sucesso, a
    -- transicao fisica oficial ja e gravada por log_equipment_state_change
    -- (com command_id e autoria). Este registro vira intencao/resultado
    -- tecnico e sai do relatorio operacional — mas CONTINUA na tabela, com
    -- user_id, source_device e details intactos.
    -- SEMPRE intencao. Criar comando nao e mudar estado fisico: nem quando
    -- executa, nem quando falha. A linha continua na tabela, com user_id,
    -- source_device, command_id e details intactos — fora da contagem
    -- operacional. Antes, timeout/error ficavam visiveis e entravam no
    -- ledger como se fossem acionamento.
    'remote_command_intent'
  )
  ON CONFLICT (farm_id, client_event_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- ── 3) A SEGUNDA CÓPIA DA MESMA TRANSIÇÃO VIRA TÉCNICA ─────────────────────
CREATE OR REPLACE FUNCTION public.apply_pump_telemetry(_farm_id uuid, _tsnn text, _payload text, _signal_bars smallint, _command_id uuid, _raw_response text, _origin text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_first_eq_id uuid := NULL;
  v_command_is_manual boolean := false;
  v_cmd_equipment_id uuid := NULL;
  v_cmd_frame text := NULL;
  v_cmd_payload text := NULL;
  v_payload_saida int := NULL;
  v_payload_bit text := NULL;
  v_is_full_bitfield boolean := false;
  v_eq RECORD;
  v_base_state text;
  v_payload_to_store text;
  v_origin text;
  v_blocked_until timestamptz;
  v_state_changed boolean;
  v_new_running boolean;
  v_old_running boolean;
  v_pending_frame text;
  v_pending_payload text;
  v_pending_is_manual boolean := false;
  v_pending_source_device text;
  v_pending_is_protective_reset boolean := false;
  v_pending_status public.command_status;
  v_pending_started_at timestamptz;
  v_pending_expected_bit text;
  v_received_bit text;
  v_pending_confirms_expected boolean := false;
  v_pending_within_start_window boolean := false;
  v_pending_reset_still_waiting boolean := false;
  v_pending_command_active boolean := false;
  v_recent_safety_expiry boolean := false;
  v_recent_remote_match boolean := false;
  v_desired_matches_received boolean := false;
  v_clear_pending boolean := false;
  v_enqueue_safety_off boolean := false;
  v_next_desired_running boolean := NULL;
  v_explicit_origin text := NULL;
  v_old_desired boolean;
  v_audit_cmd record;
  v_tsnn_norm text;
  v_plc_output_count int := 6;
  v_recent_manual_cmd boolean := false;
  v_recent_cmd_90s boolean := false;
  v_local_no_recent_cmd boolean := false;
  v_preserve_local boolean := false;
BEGIN
  -- CONTEXTO DO RX, para o escritor do ledger. O Agent passa _command_id
  -- APENAS quando o RX é a resposta direta a um comando (main.cjs:4439); no
  -- polling e no espontâneo ele vem nulo. O gatilho da transição precisa saber
  -- disso para não tratar o eco do comando como observação física.
  -- Só publica contexto; não altera nada no processamento da telemetria.
  PERFORM set_config('renov.rx_command_id', COALESCE(_command_id::text, ''), true);

  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;
  v_tsnn_norm := upper(coalesce(_tsnn, ''));
  IF _origin IS NOT NULL THEN
    IF lower(_origin) = 'local' THEN
      v_explicit_origin := 'local';
    ELSIF lower(_origin) IN ('remote', 'remote-cmd', 'remote-desired', 'remote_cmd', 'remote_desired') THEN
      v_explicit_origin := 'remote';
    END IF;
  END IF;
  IF _command_id IS NOT NULL THEN
    SELECT type = 'manual', equipment_id, frame
      INTO v_command_is_manual, v_cmd_equipment_id, v_cmd_frame
    FROM public.commands
    WHERE id = _command_id AND farm_id = _farm_id
    LIMIT 1;
    v_command_is_manual := COALESCE(v_command_is_manual, false);
    IF v_cmd_frame IS NOT NULL THEN
      v_cmd_payload := substring(v_cmd_frame from '\{([01]{1,6})\}');
    END IF;
  END IF;
  SELECT COALESCE(output_count, 6) INTO v_plc_output_count
    FROM public.plc_groups
    WHERE farm_id = _farm_id
      AND upper(hw_id) = v_tsnn_norm
    LIMIT 1;
  v_plc_output_count := COALESCE(v_plc_output_count, 6);
  IF _payload IS NULL OR _payload = '' THEN
    v_payload_saida := NULL;
    v_payload_bit := NULL;
  ELSIF _payload ~ '^[01]{6}$' THEN
    v_is_full_bitfield := true;
  ELSIF _payload ~ '^[01]{2,5}$' AND v_plc_output_count > 1 AND length(_payload) = v_plc_output_count THEN
    v_is_full_bitfield := true;
  ELSIF _payload ~ '^[01]{2,5}$' THEN
    v_payload_saida := length(_payload);
    v_payload_bit := substring(_payload from length(_payload) for 1);
  ELSIF _payload ~ '^[01]$' THEN
    v_payload_bit := _payload;
    IF v_cmd_payload IS NOT NULL AND v_cmd_payload ~ '^[01]{1,5}$' THEN
      v_payload_saida := length(v_cmd_payload);
    ELSIF v_cmd_equipment_id IS NOT NULL THEN
      SELECT COALESCE(saida, 1) INTO v_payload_saida
        FROM public.equipments WHERE id = v_cmd_equipment_id LIMIT 1;
    ELSE
      v_payload_saida := 1;
    END IF;
  ELSE
    v_payload_saida := NULL;
    v_payload_bit := NULL;
  END IF;
  FOR v_eq IN
    SELECT id, name, COALESCE(saida, 1) AS saida, pending_command_id, last_outputs_state, desired_running, last_actuation_origin, safety_expired_at, command_blocked_until
    FROM public.equipments
    WHERE farm_id = _farm_id
      AND upper(substring(hw_id from 1 for 4)) = v_tsnn_norm
    ORDER BY COALESCE(saida, 1), id
  LOOP
    IF v_first_eq_id IS NULL THEN
      v_first_eq_id := v_eq.id;
    END IF;
    v_state_changed := false;
    v_origin := NULL;
    v_blocked_until := NULL;
    v_pending_frame := NULL;
    v_pending_payload := NULL;
    v_pending_is_manual := false;
    v_pending_source_device := NULL;
    v_pending_is_protective_reset := false;
    v_pending_status := NULL;
    v_pending_started_at := NULL;
    v_pending_expected_bit := NULL;
    v_received_bit := NULL;
    v_pending_confirms_expected := false;
    v_pending_within_start_window := false;
    v_pending_reset_still_waiting := false;
    v_pending_command_active := false;
    v_recent_safety_expiry := COALESCE(v_eq.safety_expired_at > now() - interval '30 seconds', false);
    v_recent_remote_match := false;
    v_desired_matches_received := false;
    v_clear_pending := false;
    v_enqueue_safety_off := false;
    v_next_desired_running := NULL;
    v_new_running := NULL;
    v_old_running := NULL;
    v_payload_to_store := NULL;
    v_old_desired := COALESCE(v_eq.desired_running, false);
    v_recent_manual_cmd := false;
    v_recent_cmd_90s := false;
    v_local_no_recent_cmd := false;
    v_preserve_local := false;
    IF v_eq.last_outputs_state ~ '^[01]{6}$' THEN
      v_base_state := v_eq.last_outputs_state;
    ELSE
      v_base_state := '000000';
    END IF;
    IF v_is_full_bitfield THEN
      v_payload_to_store := rpad(_payload, 6, '0');
      IF v_eq.saida BETWEEN 1 AND 6 THEN
        v_received_bit := substring(_payload from v_eq.saida::int for 1);
        v_new_running := v_received_bit = '1';
      END IF;
    ELSIF v_payload_saida IS NOT NULL AND v_payload_bit IS NOT NULL THEN
      v_payload_to_store := overlay(v_base_state placing v_payload_bit
                                    from v_payload_saida::int for 1);
      IF v_eq.saida = v_payload_saida THEN
        v_received_bit := v_payload_bit;
        v_new_running := v_received_bit = '1';
      END IF;
    END IF;
    IF v_eq.saida BETWEEN 1 AND 6 THEN
      v_old_running := substring(v_base_state from v_eq.saida::int for 1) = '1';
    END IF;
    IF v_old_running IS NOT NULL AND v_new_running IS NOT NULL THEN
      v_state_changed := v_new_running IS DISTINCT FROM v_old_running;
    END IF;
    IF v_eq.pending_command_id IS NOT NULL THEN
      SELECT frame, type = 'manual', status, COALESCE(sent_at, created_at), source_device
        INTO v_pending_frame, v_pending_is_manual, v_pending_status, v_pending_started_at, v_pending_source_device
      FROM public.commands
      WHERE id = v_eq.pending_command_id AND farm_id = _farm_id
      LIMIT 1;
    END IF;
    IF (NOT v_pending_is_manual OR v_pending_frame IS NULL) AND _command_id IS NOT NULL
       AND v_cmd_equipment_id = v_eq.id THEN
      SELECT frame, type = 'manual', status, COALESCE(sent_at, created_at), source_device
        INTO v_pending_frame, v_pending_is_manual, v_pending_status, v_pending_started_at, v_pending_source_device
      FROM public.commands
      WHERE id = _command_id AND farm_id = _farm_id
      LIMIT 1;
    END IF;
    IF (NOT v_pending_is_manual OR v_pending_frame IS NULL) THEN
      SELECT frame, type = 'manual', status, COALESCE(sent_at, created_at), source_device
        INTO v_pending_frame, v_pending_is_manual, v_pending_status, v_pending_started_at, v_pending_source_device
      FROM public.commands c
      WHERE c.farm_id = _farm_id
        AND c.equipment_id = v_eq.id
        AND c.type = 'manual'
        AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
        AND COALESCE(c.sent_at, c.created_at) > now() - interval '60 seconds'
      ORDER BY COALESCE(c.sent_at, c.created_at) DESC
      LIMIT 1;
    END IF;
    IF v_received_bit IN ('0','1') THEN
      v_desired_matches_received := COALESCE(v_eq.desired_running, false) = (v_received_bit = '1');
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.commands c
      WHERE c.farm_id = _farm_id
        AND c.equipment_id = v_eq.id
        AND c.type = 'manual'
        AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
        AND COALESCE(c.sent_at, c.created_at) > now() - interval '30 seconds'
    ) INTO v_recent_manual_cmd;
    SELECT EXISTS (
      SELECT 1 FROM public.commands c
      WHERE c.farm_id = _farm_id
        AND c.equipment_id = v_eq.id
        AND c.type IN ('manual', 'automation')
        AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
        AND COALESCE(c.sent_at, c.created_at) > now() - interval '90 seconds'
    ) INTO v_recent_cmd_90s;
    v_pending_command_active := v_pending_frame IS NOT NULL AND COALESCE(v_pending_status, 'pending'::public.command_status) IN ('pending'::public.command_status, 'sent'::public.command_status, 'delivered'::public.command_status);
    v_pending_is_protective_reset := COALESCE(v_pending_source_device, '') LIKE 'backend-reset:%';
    IF v_pending_is_manual AND v_received_bit IS NOT NULL AND v_pending_frame IS NOT NULL THEN
      v_pending_payload := substring(v_pending_frame from '\{([01]{1,6})\}');
      IF v_pending_payload ~ '^[01]$' THEN
        v_pending_expected_bit := v_pending_payload;
      ELSIF v_pending_payload ~ '^[01]{2,5}$' AND v_plc_output_count > 1 AND length(v_pending_payload) = v_plc_output_count AND v_eq.saida BETWEEN 1 AND v_plc_output_count THEN
        v_pending_expected_bit := substring(v_pending_payload from v_eq.saida::int for 1);
      ELSIF v_pending_payload ~ '^[01]{2,5}$' THEN
        v_pending_expected_bit := substring(v_pending_payload from length(v_pending_payload) for 1);
      ELSIF v_pending_payload ~ '^[01]{6}$' AND v_eq.saida BETWEEN 1 AND 6 THEN
        v_pending_expected_bit := substring(v_pending_payload from v_eq.saida::int for 1);
      END IF;
      v_pending_confirms_expected := v_pending_expected_bit IS NOT NULL
                                     AND v_received_bit = v_pending_expected_bit;
      v_pending_within_start_window := v_pending_expected_bit IS NOT NULL
                                       AND v_received_bit <> v_pending_expected_bit
                                       AND v_pending_started_at IS NOT NULL
                                       AND v_pending_started_at > now() - interval '60 seconds'
                                       AND v_pending_is_protective_reset;
    END IF;
    v_preserve_local := COALESCE(v_eq.last_actuation_origin, '') = 'local'
                        AND v_received_bit IN ('0','1')
                        AND v_desired_matches_received
                        AND NOT (v_pending_confirms_expected AND NOT v_pending_is_protective_reset);
    v_local_no_recent_cmd := (
      (v_state_changed OR v_explicit_origin = 'local')
      AND NOT v_recent_cmd_90s
      AND NOT v_pending_command_active
      AND NOT v_recent_safety_expiry
    );
    IF v_pending_confirms_expected AND NOT v_pending_is_protective_reset THEN
      v_origin := 'remote';
    ELSIF v_local_no_recent_cmd THEN
      v_origin := 'local';
      v_blocked_until := now() + interval '30 seconds';
    ELSIF v_explicit_origin = 'local' AND NOT v_recent_safety_expiry AND NOT v_pending_command_active AND NOT v_desired_matches_received THEN
      v_origin := 'local';
      v_blocked_until := now() + interval '30 seconds';
    ELSIF v_state_changed AND NOT v_pending_command_active AND NOT v_recent_safety_expiry AND NOT v_desired_matches_received THEN
      v_origin := 'local';
      v_blocked_until := now() + interval '30 seconds';
    ELSIF v_received_bit IN ('0','1')
          AND NOT v_desired_matches_received
          AND NOT v_pending_command_active
          AND NOT v_recent_manual_cmd
          AND NOT v_recent_safety_expiry THEN
      v_origin := 'local';
      v_blocked_until := now() + interval '30 seconds';
    ELSIF COALESCE(v_eq.last_actuation_origin, '') = 'local'
          AND v_received_bit IN ('0','1')
          AND v_desired_matches_received THEN
      v_origin := 'remote';
    ELSIF COALESCE(v_eq.last_actuation_origin, '') = 'local' THEN
      v_origin := NULL;
    ELSIF v_explicit_origin = 'remote' THEN
      v_origin := 'remote';
    ELSE
      v_origin := NULL;
    END IF;
    IF _origin IS NULL THEN
      v_origin := NULL;
    END IF;
    IF v_received_bit IN ('0', '1') THEN
      IF v_local_no_recent_cmd THEN
        v_next_desired_running := NULL;
        v_clear_pending := false;
        v_enqueue_safety_off := false;
      ELSIF v_pending_confirms_expected THEN
        v_next_desired_running := v_pending_expected_bit = '1';
        v_clear_pending := true;
      ELSIF v_pending_within_start_window THEN
        v_next_desired_running := v_pending_expected_bit = '1';
        v_clear_pending := false;
      ELSIF v_pending_reset_still_waiting THEN
        v_next_desired_running := false;
        v_clear_pending := false;
        v_enqueue_safety_off := false;
        v_blocked_until := now() + interval '30 seconds';
      ELSIF v_pending_is_manual AND v_pending_expected_bit IS NOT NULL
            AND v_received_bit <> v_pending_expected_bit
            AND v_explicit_origin IS DISTINCT FROM 'local' THEN
        v_next_desired_running := v_pending_expected_bit = '1';
        v_clear_pending := false;
        v_enqueue_safety_off := false;
      ELSIF COALESCE(v_eq.last_actuation_origin, '') = 'local' AND NOT v_recent_safety_expiry THEN
        v_next_desired_running := NULL;
        v_blocked_until := COALESCE(v_eq.command_blocked_until, now() + interval '30 seconds');
      ELSE
        v_next_desired_running := NULL;
      END IF;
    END IF;
    UPDATE public.equipments e
    SET
      last_outputs_state = COALESCE(v_payload_to_store, e.last_outputs_state),
      last_communication = now(),
      last_signal_bars = COALESCE(_signal_bars, e.last_signal_bars),
      desired_running = COALESCE(v_next_desired_running, e.desired_running),
      last_actuation_origin = CASE
                                WHEN v_preserve_local THEN 'local'
                                ELSE COALESCE(_origin, v_origin, e.last_actuation_origin)
                              END,
      command_blocked_until = COALESCE(v_blocked_until, e.command_blocked_until),
      pending_command_id = CASE WHEN v_clear_pending THEN NULL ELSE e.pending_command_id END,
      updated_at = now()
    WHERE e.id = v_eq.id;
    IF v_state_changed AND v_new_running IS NOT NULL THEN
      INSERT INTO public.automation_log(
        farm_id, equipment_id, equipment_name, action, origin, result, actor_label,
        new_state, source_device, occurred_at, details, noise_reason
      ) VALUES (
        _farm_id, v_eq.id, v_eq.name,
        CASE WHEN v_new_running THEN 'pump_on'::public.event_action ELSE 'pump_off'::public.event_action END,
        CASE WHEN COALESCE(_origin, v_origin) = 'local' THEN 'local'::public.event_origin
             WHEN COALESCE(_origin, v_origin) = 'remote' THEN 'remote'::public.event_origin
             ELSE 'system'::public.event_origin END,
        'success'::public.event_result,
        CASE WHEN COALESCE(_origin, v_origin) = 'local' THEN 'Acionamento local' ELSE 'Telemetria RF' END,
        CASE WHEN v_new_running THEN 'on' ELSE 'off' END,
        'serial-bridge',
        now(),
        jsonb_build_object('payload', _payload, 'raw', _raw_response, 'origin', COALESCE(_origin, v_origin)),
        -- RUIDO DE RELATORIO (nao muda nada operacional):
        -- Se este RX e a confirmacao de um comando remoto correlacionavel por
        -- command_id + equipment_id + estado esperado, ele NAO e um acionamento
        -- novo: e a confirmacao do comando. O evento oficial dessa transicao e
        -- gravado por log_equipment_state_change via classify_physical_transition.
        -- Sem correlacao valida, noise_reason fica NULL e o acionamento LOCAL
        -- real continua oficial, exatamente como antes.
        CASE WHEN _command_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM public.commands c
                WHERE c.id = _command_id
                  AND c.farm_id = _farm_id
                  AND c.equipment_id = v_eq.id
                  AND ((c.frame LIKE '%{1}%' OR c.frame LIKE '%{01}%' OR c.frame LIKE '%{001}%'
                        OR c.frame LIKE '%{0001}%' OR c.frame LIKE '%{00001}%' OR c.frame LIKE '%{000001}%')
                       = v_new_running))
             THEN 'remote_command_confirmation_duplicate'
             -- LEDGER CANÔNICO: se log_equipment_state_change já gravou esta
             -- mesma transição (ele roda no UPDATE de equipments, logo acima),
             -- esta linha é a segunda cópia do mesmo evento físico. Vira
             -- técnica. Quando NÃO existe a linha canônica — caso em que esta
             -- é a única evidência da mudança — ela permanece operacional.
             WHEN EXISTS (
               SELECT 1 FROM public.automation_log t
                WHERE t.equipment_id = v_eq.id
                  AND t.source_device = 'auto-trigger'
                  AND t.created_at > now() - interval '10 seconds'
                  AND (t.action IN ('turn_on','pump_on')) = v_new_running)
             THEN 'canonical_row_exists'
             -- O escritor canônico acabou de RECUSAR esta mudança (eco do
             -- comando ou resposta intermediária, registrados como evento
             -- técnico nesta mesma transação). Se ele recusou, esta cópia
             -- também não é acionamento.
             WHEN EXISTS (
               SELECT 1 FROM public.agent_technical_events te
                WHERE te.equipment_id = v_eq.id
                  AND te.kind IN ('command_echo','intermediate_rx')
                  AND te.occurred_at > now() - interval '10 seconds')
             THEN 'ledger_rejected_transition'
             ELSE NULL END
      );
    END IF;
    IF v_clear_pending AND v_eq.pending_command_id IS NOT NULL THEN
      UPDATE public.commands
      SET status = 'executed',
          response = COALESCE(response, _raw_response),
          responded_at = COALESCE(responded_at, now())
      WHERE id = v_eq.pending_command_id
        AND status IN ('pending', 'sent');
    END IF;
    IF v_enqueue_safety_off THEN
      PERFORM public.enqueue_reset_pump_command(_farm_id, v_eq.id, 'manual_60s_timeout');
    END IF;
  END LOOP;
  RETURN v_first_eq_id;
END;
$function$;

-- ── 4) O ESCRITOR CANÔNICO PASSA A MEDIR CONTRA O ESTADO DO LEDGER ─────────
-- Antes ele comparava OLD.last_outputs_state com NEW.last_outputs_state. Isso
-- transforma em transição qualquer oscilação do que foi ARMAZENADO — inclusive
-- a resposta imediata ao comando, que diz o estado que a bomba ainda tem.
-- Na Sossego isso produziu pares "Ligada" e "Desligada" a dois segundos.
--
-- Agora a referência é `last_confirmed_state`: o último estado que o LEDGER
-- aceitou como confirmado. E, enquanto existe comando manual em voo com alvo
-- conhecido, uma transição CONTRA esse alvo não confirma nada — é a bomba
-- dizendo "ainda não cheguei". Vai para agent_technical_events, não para o
-- ledger.
--
-- Não altera telemetria, frame, atuação nem desired_running: decide apenas se
-- a linha operacional nasce.
CREATE OR REPLACE FUNCTION public.log_equipment_state_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_saida_idx int; v_new boolean; v_ledger smallint;
  v_action public.event_action; c record; v_at timestamptz;
  v_alvo text; v_cmd record; v_rx_cmd text;
BEGIN
  IF NEW.type NOT IN ('poco','bombeamento') THEN RETURN NEW; END IF;

  v_saida_idx := COALESCE(NEW.saida, 1);

  IF NEW.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_new := substring(NEW.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF NEW.last_outputs_state ~ '^[01]$' THEN
    v_new := NEW.last_outputs_state = '1';
  ELSE v_new := NULL; END IF;

  IF v_new IS NULL THEN RETURN NEW; END IF;   -- payload ilegível: nada a afirmar

  -- (1) HOUVE TRANSIÇÃO EM RELAÇÃO AO LEDGER?
  SELECT last_confirmed_state INTO v_ledger FROM public.equipments WHERE id = NEW.id;
  IF v_ledger IS NOT NULL AND v_ledger = (CASE WHEN v_new THEN 1 ELSE 0 END) THEN
    RETURN NEW;                                -- mesmo estado: não é evento
  END IF;

  v_alvo := CASE WHEN v_new THEN 'turn_on' ELSE 'turn_off' END;

  -- (2a) ECO DO COMANDO. A resposta direta a um comando manual diz o que o
  -- PLC recebeu, não o que a bomba fez. Ela sozinha não confirma transição: a
  -- confirmação vem da telemetria seguinte (polling ou espontâneo), que é o
  -- que o protocolo garante ser leitura de estado. Foi o eco tratado como
  -- observação que produziu, na Sossego, "Ligada" e "Desligada" a 2 segundos.
  v_rx_cmd := NULLIF(current_setting('renov.rx_command_id', true), '');
  IF v_rx_cmd IS NOT NULL THEN
    PERFORM 1 FROM public.commands c3
      WHERE c3.id = v_rx_cmd::uuid
        AND c3.type = 'manual'::public.command_type
        AND public.command_intent_from_frame(c3.frame, v_saida_idx) = v_alvo;
    IF FOUND THEN
      INSERT INTO public.agent_technical_events
        (farm_id, equipment_id, equipment_name, kind, occurred_at, details)
      VALUES (NEW.farm_id, NEW.id, NEW.name, 'command_echo',
              COALESCE(NEW.last_communication, now()),
              jsonb_build_object('received_state', NEW.last_outputs_state,
                                 'ledger_state', v_ledger, 'command_id', v_rx_cmd,
                                 'note', 'resposta do comando — aguarda telemetria para confirmar'));
      RETURN NEW;
    END IF;
  END IF;

  -- (2b) RESPOSTA INTERMEDIÁRIA: comando em voo cujo alvo é o OPOSTO do que
  -- chegou. "Ainda não cheguei" não é acionamento.
  SELECT c2.id, c2.frame INTO v_cmd
    FROM public.commands c2
   WHERE c2.equipment_id = NEW.id
     AND c2.type = 'manual'::public.command_type
     AND c2.responded_at IS NULL
     AND c2.status IN ('pending','sent','delivered')
     AND COALESCE(c2.sent_at, c2.created_at) >
         now() - make_interval(secs => COALESCE(c2.timeout_ms, 120000) / 1000.0)
     AND public.command_intent_from_frame(c2.frame, v_saida_idx) IS NOT NULL
     AND public.command_intent_from_frame(c2.frame, v_saida_idx) <> v_alvo
   ORDER BY COALESCE(c2.sent_at, c2.created_at) DESC
   LIMIT 1;
  IF FOUND THEN
    INSERT INTO public.agent_technical_events
      (farm_id, equipment_id, equipment_name, kind, occurred_at, details)
    VALUES (NEW.farm_id, NEW.id, NEW.name, 'intermediate_rx',
            COALESCE(NEW.last_communication, now()),
            jsonb_build_object('received_state', NEW.last_outputs_state,
                               'ledger_state', v_ledger,
                               'pending_command_id', v_cmd.id,
                               'note', 'RX contra o alvo do comando em voo — não confirma transição'));
    RETURN NEW;
  END IF;

  v_action := CASE WHEN v_new THEN 'turn_on'::public.event_action
                   ELSE 'turn_off'::public.event_action END;
  v_at := COALESCE(NEW.last_communication, now());

  SELECT * INTO c FROM public.classify_physical_transition(
    NEW.id, NEW.farm_id, v_new, v_at);

  INSERT INTO public.automation_log (
    farm_id, equipment_id, equipment_name, occurred_at, origin, action, result,
    new_state, client_event_id, source_device,
    user_id, user_email, actor_label, noise_reason, details)
  VALUES (
    NEW.farm_id, NEW.id, NEW.name, v_at, c.origin, v_action,
    'success'::public.event_result, NEW.last_outputs_state,
    gen_random_uuid(), 'auto-trigger',
    c.user_id, c.user_email, c.actor_label,
    NULL,
    jsonb_build_object(
      'actuation_origin', NEW.last_actuation_origin,
      'authorship_source', c.authorship_source,
      'command_id', c.command_id,
      'ledger_state_before', v_ledger,
      'confirmation_method', 'telemetria_rf'));

  -- (3) O LEDGER PASSA A CONHECER ESTE ESTADO.
  UPDATE public.equipments SET last_confirmed_state = CASE WHEN v_new THEN 1 ELSE 0 END
   WHERE id = NEW.id;

  RETURN NEW;
END; $$;

-- ── 4b) ATRIBUIÇÃO: comando que falhou não explica transição ───────────────
CREATE OR REPLACE FUNCTION public.classify_physical_transition(
  _equipment_id uuid, _farm_id uuid, _turning_on boolean,
  _at timestamptz DEFAULT now(), _window interval DEFAULT interval '3 minutes')
RETURNS TABLE (origin public.event_origin, actor_label text, user_id uuid,
               user_email text, command_id uuid, authorship_source text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent text; r record; v_rule text;
  v_saida int; v_wa text; v_act_origin text;
BEGIN
  v_intent := CASE WHEN _turning_on THEN 'turn_on' ELSE 'turn_off' END;
  SELECT COALESCE(saida,1), last_actuation_origin INTO v_saida, v_act_origin
    FROM public.equipments WHERE id = _equipment_id;

  -- ── (2) AUTOMAÇÃO COMPATÍVEL ────────────────────────────────────────────
  IF NOT _turning_on AND EXISTS (
       SELECT 1 FROM public.commands c
        WHERE c.equipment_id = _equipment_id
          AND c.source_device LIKE 'backend-reset:scheduled_shutdown%'
          AND c.created_at BETWEEN _at - interval '10 minutes' AND _at + interval '2 minutes')
  THEN
    SELECT NULLIF(btrim(e.last_changed_by),'') INTO v_rule
      FROM public.equipments e WHERE e.id = _equipment_id;
    RETURN QUERY SELECT 'auto'::public.event_origin,
      COALESCE(v_rule,'Desligamento Programado'), NULL::uuid, NULL::text,
      NULL::uuid, 'scheduled_command';
    RETURN;
  END IF;

  IF NOT _turning_on THEN
    SELECT sa.name INTO v_rule
      FROM public.scheduled_automations sa
     WHERE sa.farm_id = _farm_id AND sa.is_active
       AND sa.time_brt ~ '^[0-9]{1,2}:[0-9]{2}'
       AND (sa.days_of_week IS NULL OR array_length(sa.days_of_week,1) IS NULL
            OR (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[
                 extract(dow from (_at AT TIME ZONE 'America/Bahia'))::int + 1] = ANY(sa.days_of_week))
       AND (extract(hour from (_at AT TIME ZONE 'America/Bahia'))::int * 60
            + extract(minute from (_at AT TIME ZONE 'America/Bahia'))::int)
           BETWEEN ((substring(sa.time_brt from '^([0-9]{1,2})')::int)*60
                    + (substring(sa.time_brt from ':([0-9]{2})')::int)) - 5
               AND ((substring(sa.time_brt from '^([0-9]{1,2})')::int)*60
                    + (substring(sa.time_brt from ':([0-9]{2})')::int))
                   + (COALESCE(sa.max_retries,3) * COALESCE(sa.retry_interval_min,5)) + 5
     ORDER BY sa.time_brt LIMIT 1;
    IF v_rule IS NOT NULL THEN
      RETURN QUERY SELECT 'auto'::public.event_origin, v_rule,
        NULL::uuid, NULL::text, NULL::uuid, 'scheduled_window';
      RETURN;
    END IF;
  END IF;

  -- ── (3) COMANDO CORRELACIONADO — a evidência vem do próprio comando ─────
  -- commands é a fonte viva; command_audit é a cópia durável (o comando é
  -- apagado quando termina). A intenção sai do frame, não de rótulo gravado.
  WITH cand AS (
    SELECT c.id AS cid, c.created_at AS at, c.source_device AS src,
           c.created_by AS uid, c.frame AS frame
      FROM public.commands c
     WHERE c.equipment_id = _equipment_id
       AND c.type = 'manual'::public.command_type
       AND COALESCE(c.source_device,'') NOT LIKE 'backend-reset:%'
       -- comando que terminou SEM confirmar não explica transição nenhuma:
       -- depois do timeout, uma mudança física é espontânea até prova em
       -- contrário, e o relatório deve dizer Local.
       AND c.status NOT IN ('timeout'::public.command_status,
                            'error'::public.command_status,
                            'cancelled'::public.command_status)
       AND c.created_at BETWEEN _at - _window AND _at + _window
    UNION ALL
    SELECT ca.command_id, ca.command_created_at, ca.source_device,
           ca.user_id, ca.frame
      FROM public.command_audit ca
     WHERE ca.equipment_id = _equipment_id
       AND COALESCE(ca.source_device,'') NOT LIKE 'backend-reset:%'
       AND COALESCE(ca.status_final,'') NOT IN ('timeout','error','cancelled')
       AND ca.command_created_at BETWEEN _at - _window AND _at + _window
  )
  SELECT cand.cid, cand.src, cand.uid, p.full_name, p.email
    INTO r
    FROM cand LEFT JOIN public.profiles p ON p.id = cand.uid
   WHERE COALESCE(public.command_intent_from_frame(cand.frame, v_saida), v_intent) = v_intent
   ORDER BY (public.command_intent_from_frame(cand.frame, v_saida) IS NULL),
            abs(extract(epoch FROM (cand.at - _at)))
   LIMIT 1;

  IF FOUND THEN
    -- WhatsApp: o operador real está em source_device, não em created_by.
    IF lower(COALESCE(r.src,'')) LIKE 'whatsapp:%' THEN
      v_wa := btrim(split_part(substr(r.src, strpos(r.src, ':') + 1), '|', 1));
      -- só dígitos/pontuação = telefone; telefone não é nome e não vai à tela
      IF v_wa ~ '^[+0-9 ()\-]*$' THEN v_wa := NULL; END IF;
      RETURN QUERY SELECT 'whatsapp'::public.event_origin,
        COALESCE(NULLIF(v_wa,''), r.full_name, r.email),
        r.uid, r.email, r.cid, 'whatsapp_source_device';
      RETURN;
    END IF;
    IF r.uid IS NOT NULL THEN
      RETURN QUERY SELECT 'remote'::public.event_origin,
        COALESCE(r.full_name, r.email), r.uid, r.email, r.cid, 'command_created_by';
      RETURN;
    END IF;
  END IF;

  -- ── (4) SEM CORRELAÇÃO ──────────────────────────────────────────────────
  -- Local só com evidência: a telemetria precisa ter declarado atuação local.
  IF lower(COALESCE(v_act_origin,'')) = 'local' THEN
    RETURN QUERY SELECT 'local'::public.event_origin, 'Acionamento local',
      NULL::uuid, NULL::text, NULL::uuid, 'local_declared';
    RETURN;
  END IF;

  -- Transição observada sem origem comprovada. Entra no histórico como tal.
  RETURN QUERY SELECT 'system'::public.event_origin, NULL::text,
    NULL::uuid, NULL::text, NULL::uuid, 'unidentified';
END; $$;

-- ── 5) RESSINCRONIZAÇÃO ÚNICA DO ESTADO DO LEDGER ──────────────────────────
-- `last_confirmed_state` está congelado desde que o gatilho de
-- enforce_automation_log_state_change deixou de existir no NEW, e já diverge
-- do estado observado em 21 dos 72 equipamentos. Sem este alinhamento, o
-- primeiro RX de cada equipamento divergente viraria um acionamento fantasma.
-- Nada vivo lê esta coluna hoje (os três leitores têm 0 gatilhos armados, e o
-- frontend a ignora explicitamente). Não toca last_outputs_state,
-- desired_running nem qualquer estado de atuação.
UPDATE public.equipments e
   SET last_confirmed_state = CASE
         WHEN e.last_outputs_state ~ '^[01]{6}$' AND COALESCE(e.saida,1) BETWEEN 1 AND 6
           THEN (substring(e.last_outputs_state from COALESCE(e.saida,1)::int for 1) = '1')::int
         WHEN e.last_outputs_state ~ '^[01]$'
           THEN (e.last_outputs_state = '1')::int
         ELSE e.last_confirmed_state END
 WHERE e.type IN ('poco','bombeamento');

-- ============================================================================
-- INVARIANTE (somente leitura, para acompanhar depois da implantação):
--   WITH fluxo AS (
--     SELECT equipment_id, occurred_at,
--            CASE WHEN action IN ('turn_on','pump_on') THEN 1 ELSE 0 END AS est,
--            lag(CASE WHEN action IN ('turn_on','pump_on') THEN 1 ELSE 0 END)
--              OVER (PARTITION BY equipment_id ORDER BY occurred_at, created_at) AS ant
--       FROM public.automation_log
--      WHERE noise_reason IS NULL
--        AND action IN ('turn_on','turn_off','pump_on','pump_off'))
--   SELECT count(*) FROM fluxo WHERE ant IS NOT NULL AND est = ant;   -- meta: 0
--
-- ROLLBACK:
--   DROP TRIGGER trg_a_ledger_gate ON public.automation_log;
--   e reaplicar as versões anteriores de log_manual_command_to_automation_log
--   (20260729004016) e apply_pump_telemetry (20260724001522).
-- ============================================================================
