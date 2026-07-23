CREATE OR REPLACE FUNCTION public.apply_pump_telemetry(_farm_id uuid, _tsnn text, _payload text, _signal_bars smallint DEFAULT NULL::smallint, _command_id uuid DEFAULT NULL::uuid, _raw_response text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_first_eq_id uuid := NULL;
  v_command_is_manual boolean := false;

  v_eq RECORD;
  v_payload_safe text;
  v_payload_to_store text;
  v_origin text;
  v_blocked_until timestamptz;
  v_state_changed boolean;
  v_new_running boolean;
  v_old_running boolean;
  v_recent_remote_command_at timestamptz;
  v_recent_manual_expected_running boolean;
  v_recent_manual_expected_known boolean := false;
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
  v_clear_pending boolean := false;
  v_fail_pending boolean := false;
  v_next_desired_running boolean := NULL;
  v_should_force_off boolean := false;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  IF _command_id IS NOT NULL THEN
    SELECT type = 'manual'
      INTO v_command_is_manual
    FROM public.commands
    WHERE id = _command_id
      AND farm_id = _farm_id
    LIMIT 1;

    v_command_is_manual := COALESCE(v_command_is_manual, false);
  END IF;

  FOR v_eq IN
    SELECT id, name, COALESCE(saida, 1) AS saida, pending_command_id, last_outputs_state, desired_running, last_actuation_origin
    FROM public.equipments
    WHERE farm_id = _farm_id
      AND substring(hw_id from 1 for 4) = _tsnn
    ORDER BY COALESCE(saida, 1), id
  LOOP
    IF v_first_eq_id IS NULL THEN
      v_first_eq_id := v_eq.id;
    END IF;

    IF _payload IS NULL THEN
      v_payload_safe := NULL;
    ELSIF _payload ~ '^[01]{6}$' THEN
      v_payload_safe := _payload;
    ELSIF _payload ~ '^[01]{2,5}$' THEN
      v_payload_safe := rpad(_payload, 6, '0');
    ELSIF _payload ~ '^[01]$' AND v_eq.saida BETWEEN 1 AND 6 THEN
      v_payload_safe := overlay('000000' placing _payload from v_eq.saida::int for 1);
    ELSIF _payload = '' THEN
      v_payload_safe := NULL;
    ELSE
      v_payload_safe := NULL;
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
    v_clear_pending := false;
    v_fail_pending := false;
    v_recent_remote_command_at := NULL;
    v_recent_manual_expected_running := NULL;
    v_recent_manual_expected_known := false;
    v_next_desired_running := NULL;
    v_should_force_off := false;
    v_new_running := NULL;
    v_old_running := NULL;
    -- IMPORTANTE: SEMPRE persistimos o que a bomba realmente reportou.
    -- Isso garante que a UI atualize imediatamente em qualquer Espontâneo
    -- (mesmo durante a janela de 60s de um comando manual).
    v_payload_to_store := v_payload_safe;

    IF v_payload_safe IS NOT NULL THEN
      v_received_bit := substring(v_payload_safe from v_eq.saida::int for 1);
      IF v_received_bit IN ('0', '1') THEN
        v_new_running := v_received_bit = '1';
      END IF;
    END IF;

    IF v_eq.last_outputs_state ~ '^[01]{6}$' AND v_eq.saida BETWEEN 1 AND 6 THEN
      v_old_running := substring(v_eq.last_outputs_state from v_eq.saida::int for 1) = '1';
    ELSIF v_eq.last_outputs_state ~ '^[01]$' THEN
      v_old_running := v_eq.last_outputs_state = '1';
    END IF;

    IF v_old_running IS NOT NULL AND v_new_running IS NOT NULL THEN
      v_state_changed := v_new_running IS DISTINCT FROM v_old_running;
    END IF;

    IF v_eq.pending_command_id IS NOT NULL THEN
      SELECT frame, type = 'manual', status, COALESCE(sent_at, created_at), source_device
        INTO v_pending_frame, v_pending_is_manual, v_pending_status, v_pending_started_at, v_pending_source_device
      FROM public.commands
      WHERE id = v_eq.pending_command_id
        AND farm_id = _farm_id
      LIMIT 1;
    END IF;

    IF (NOT v_pending_is_manual OR v_pending_frame IS NULL) AND _command_id IS NOT NULL THEN
      SELECT frame, type = 'manual', status, COALESCE(sent_at, created_at), source_device
        INTO v_pending_frame, v_pending_is_manual, v_pending_status, v_pending_started_at, v_pending_source_device
      FROM public.commands
      WHERE id = _command_id
        AND farm_id = _farm_id
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

    v_pending_is_protective_reset := COALESCE(v_pending_source_device, '') LIKE 'backend-reset:%';

    IF v_pending_is_manual AND v_payload_safe IS NOT NULL AND v_pending_frame IS NOT NULL THEN
      v_pending_payload := substring(v_pending_frame from '\{([01]{1,6})\}');

      IF v_pending_payload ~ '^[01]$' THEN
        v_pending_expected_bit := v_pending_payload;
      ELSIF v_pending_payload ~ '^[01]{2,6}$' THEN
        IF length(v_pending_payload) >= v_eq.saida THEN
          v_pending_expected_bit := substring(v_pending_payload from v_eq.saida::int for 1);
        END IF;
      END IF;

      v_pending_confirms_expected := v_pending_expected_bit IS NOT NULL
                                     AND v_received_bit = v_pending_expected_bit;

      -- Janela de 60s do comando manual: enquanto ela estiver aberta E a bomba
      -- ainda não confirmou o estado esperado, NÃO marcamos como falha local
      -- e NÃO encerramos o pending. O estado físico continua sendo atualizado
      -- (UI imediata), mas o comando segue ativo, polling continua reafirmando
      -- a intenção. Só após o minuto a próxima telemetria decide.
      v_pending_within_start_window := v_pending_expected_bit IS NOT NULL
                                       AND v_received_bit IS NOT NULL
                                       AND v_received_bit <> v_pending_expected_bit
                                       AND v_pending_started_at IS NOT NULL
                                       AND v_pending_started_at > now() - interval '60 seconds'
                                       AND NOT v_pending_is_protective_reset;
    END IF;

    IF v_state_changed THEN
      IF v_pending_confirms_expected AND NOT v_pending_is_protective_reset THEN
        v_origin := 'remote';
      ELSIF v_command_is_manual THEN
        SELECT CASE
                 WHEN frame ~ '\{[01]{2,6}\}' AND length(substring(frame from '\{([01]{2,6})\}')) >= v_eq.saida
                   THEN substring(substring(frame from '\{([01]{2,6})\}') from v_eq.saida::int for 1) = '1'
                 WHEN frame ~ '\{[01]\}' THEN substring(frame from '\{([01])\}') = '1'
                 ELSE NULL
               END
          INTO v_recent_manual_expected_running
        FROM public.commands
        WHERE id = _command_id
          AND farm_id = _farm_id
        LIMIT 1;

        v_recent_manual_expected_known := v_recent_manual_expected_running IS NOT NULL;

        IF v_recent_manual_expected_known AND v_recent_manual_expected_running = v_new_running THEN
          v_origin := 'remote';
        ELSIF v_pending_within_start_window THEN
          -- Dentro da janela: NÃO marcar como local. Aguarda confirmação.
          v_origin := COALESCE(v_eq.last_actuation_origin, NULL);
        ELSE
          v_origin := 'local';
          v_blocked_until := now() + interval '30 seconds';
        END IF;
      ELSE
        SELECT c.sent_at,
               CASE
                 WHEN c.frame ~ '\{[01]{2,6}\}' AND length(substring(c.frame from '\{([01]{2,6})\}')) >= v_eq.saida
                   THEN substring(substring(c.frame from '\{([01]{2,6})\}') from v_eq.saida::int for 1) = '1'
                 WHEN c.frame ~ '\{[01]\}' THEN substring(c.frame from '\{([01])\}') = '1'
                 ELSE NULL
               END
        INTO v_recent_remote_command_at, v_recent_manual_expected_running
        FROM public.commands c
        WHERE c.equipment_id = v_eq.id
          AND c.type = 'manual'
          AND c.sent_at > now() - interval '60 seconds'
        ORDER BY c.sent_at DESC
        LIMIT 1;

        v_recent_manual_expected_known := v_recent_remote_command_at IS NOT NULL AND v_recent_manual_expected_running IS NOT NULL;

        IF v_recent_manual_expected_known AND v_recent_manual_expected_running = v_new_running THEN
          v_origin := 'remote';
        ELSIF v_pending_within_start_window THEN
          v_origin := COALESCE(v_eq.last_actuation_origin, NULL);
        ELSE
          v_origin := 'local';
          v_blocked_until := now() + interval '30 seconds';
        END IF;
      END IF;

      IF v_origin = 'local'
         AND v_new_running = false
         AND (
           v_old_running = true
           OR COALESCE(v_eq.desired_running, false) = true
         )
         AND NOT v_pending_within_start_window THEN
        v_should_force_off := true;
      END IF;
    ELSE
      IF v_pending_confirms_expected AND NOT v_pending_is_protective_reset THEN
        v_origin := 'remote';
      END IF;

      IF v_pending_is_manual
         AND v_pending_expected_bit = '1'
         AND v_received_bit = '0'
         AND NOT v_pending_within_start_window THEN
        v_origin := 'local';
        v_blocked_until := now() + interval '30 seconds';
      END IF;

      IF v_pending_is_manual
         AND v_pending_expected_bit = '0'
         AND v_received_bit = '1'
         AND NOT v_pending_within_start_window THEN
        v_origin := 'local';
        v_blocked_until := now() + interval '30 seconds';
      END IF;

      IF v_received_bit = '1'
         AND COALESCE(v_eq.desired_running, false) = false
         AND v_eq.pending_command_id IS NULL
         AND COALESCE(v_eq.last_actuation_origin, '') <> 'local'
         AND NOT v_pending_within_start_window THEN
        v_origin := 'local';
        v_blocked_until := now() + interval '30 seconds';
      END IF;

      IF COALESCE(v_eq.desired_running, false) = true
         AND v_new_running = false
         AND NOT v_pending_within_start_window
         AND COALESCE(v_pending_expected_bit, '') <> '0' THEN
        IF v_pending_started_at IS NULL OR v_pending_started_at <= now() - interval '60 seconds' THEN
          v_should_force_off := true;
          v_origin := COALESCE(v_origin, 'local');
          v_blocked_until := COALESCE(v_blocked_until, now() + interval '30 seconds');
        END IF;
      END IF;
    END IF;

    IF v_received_bit IN ('0', '1') THEN
      IF v_pending_within_start_window THEN
        -- Dentro da janela: mantém intenção do comando.
        v_next_desired_running := v_pending_expected_bit = '1';
        v_clear_pending := false;
        v_fail_pending := false;
      ELSIF v_pending_is_manual AND v_pending_expected_bit = '1' AND v_received_bit = '0' THEN
        v_next_desired_running := false;
        v_clear_pending := true;
        v_fail_pending := COALESCE(v_pending_status, 'pending') <> 'executed';
      ELSIF v_pending_is_manual AND v_pending_expected_bit = '0' AND v_received_bit = '1' THEN
        v_next_desired_running := false;
        v_clear_pending := true;
        v_fail_pending := COALESCE(v_pending_status, 'pending') <> 'executed';
      ELSIF v_eq.pending_command_id IS NOT NULL AND v_pending_is_manual AND NOT v_pending_confirms_expected THEN
        IF v_pending_expected_bit = '0' THEN
          v_next_desired_running := false;
        ELSE
          v_next_desired_running := v_eq.desired_running;
        END IF;
      ELSIF v_received_bit = '1' AND COALESCE(v_eq.desired_running, false) = false THEN
        v_next_desired_running := false;
      ELSIF v_received_bit = '0' AND COALESCE(v_eq.desired_running, false) = true
            AND (v_pending_started_at IS NULL OR v_pending_started_at <= now() - interval '60 seconds') THEN
        v_next_desired_running := false;
      ELSE
        v_next_desired_running := v_received_bit = '1';
      END IF;
    END IF;

    IF v_eq.pending_command_id IS NOT NULL
       AND v_pending_is_manual
       AND COALESCE(v_pending_status, 'pending') NOT IN ('pending', 'sent')
       AND v_received_bit = '0'
       AND NOT v_pending_within_start_window THEN
      v_next_desired_running := false;
      v_clear_pending := true;
    END IF;

    -- Atualiza o equipamento (sempre persiste o que a bomba reportou)
    UPDATE public.equipments e
    SET
      last_outputs_state = COALESCE(v_payload_to_store, e.last_outputs_state),
      last_communication = now(),
      last_signal_bars = COALESCE(_signal_bars, e.last_signal_bars),
      desired_running = COALESCE(v_next_desired_running, e.desired_running),
      last_actuation_origin = COALESCE(v_origin, e.last_actuation_origin),
      command_blocked_until = COALESCE(v_blocked_until, e.command_blocked_until),
      pending_command_id = CASE WHEN v_clear_pending THEN NULL ELSE e.pending_command_id END,
      updated_at = now()
    WHERE e.id = v_eq.id;

    IF v_fail_pending AND v_eq.pending_command_id IS NOT NULL THEN
      UPDATE public.commands
      SET status = 'error',
          error_message = COALESCE(error_message, 'Bomba não obedeceu a ordem dentro da janela de 60s'),
          responded_at = COALESCE(responded_at, now())
      WHERE id = v_eq.pending_command_id
        AND status IN ('pending', 'sent');
    END IF;

    -- Confirma o comando assim que o estado bater (mesmo dentro da janela
    -- isso é OK: confirmar cedo é desejável quando a bomba REALMENTE bateu o
    -- estado esperado).
    IF v_pending_confirms_expected
       AND v_eq.pending_command_id IS NOT NULL THEN
      UPDATE public.commands
      SET status = 'executed',
          response = COALESCE(response, _raw_response),
          responded_at = COALESCE(responded_at, now())
      WHERE id = v_eq.pending_command_id
        AND status IN ('pending', 'sent');

      UPDATE public.equipments
      SET pending_command_id = NULL
      WHERE id = v_eq.id;
    END IF;

    IF v_should_force_off THEN
      INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
      SELECT _farm_id, v_eq.id, _tsnn, 'manual', 0,
             '[' || _tsnn || '_1_]{0}[' || _tsnn || '_ETX_]' || E'\r',
             10000, 'backend-reset:protective_off'
      WHERE NOT EXISTS (
        SELECT 1 FROM public.commands c2
        WHERE c2.equipment_id = v_eq.id
          AND c2.status = 'pending'
          AND c2.source_device = 'backend-reset:protective_off'
          AND c2.created_at > now() - interval '20 seconds'
      );
    END IF;

  END LOOP;

  RETURN v_first_eq_id;
END;
$function$;