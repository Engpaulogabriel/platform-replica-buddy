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
    v_next_desired_running := NULL;
    v_new_running := NULL;
    v_old_running := NULL;
    -- SEMPRE persiste o que a bomba reportou (UI imediata via Realtime).
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

    -- Busca pending command
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

      v_pending_within_start_window := v_pending_expected_bit IS NOT NULL
                                       AND v_received_bit IS NOT NULL
                                       AND v_received_bit <> v_pending_expected_bit
                                       AND v_pending_started_at IS NOT NULL
                                       AND v_pending_started_at > now() - interval '60 seconds'
                                       AND NOT v_pending_is_protective_reset;
    END IF;

    -- Determina origem (sem disparar force_off automático)
    IF v_state_changed THEN
      IF v_pending_confirms_expected AND NOT v_pending_is_protective_reset THEN
        v_origin := 'remote';
      ELSIF v_pending_within_start_window THEN
        v_origin := COALESCE(v_eq.last_actuation_origin, NULL);
      ELSIF v_pending_is_manual AND v_pending_expected_bit IS NOT NULL
            AND v_received_bit = v_pending_expected_bit THEN
        v_origin := 'remote';
      ELSE
        -- Mudança de estado sem comando casando = atuação local
        v_origin := 'local';
        v_blocked_until := now() + interval '30 seconds';
      END IF;
    ELSE
      IF v_pending_confirms_expected AND NOT v_pending_is_protective_reset THEN
        v_origin := 'remote';
      END IF;
    END IF;

    -- Gestão do pending: confirma se bateu, falha apenas se desobedeceu fora da janela
    IF v_received_bit IN ('0', '1') THEN
      IF v_pending_confirms_expected THEN
        v_next_desired_running := v_pending_expected_bit = '1';
        v_clear_pending := true;
        v_fail_pending := false;
      ELSIF v_pending_within_start_window THEN
        -- Dentro dos 60s: mantém intenção, não falha
        v_next_desired_running := v_pending_expected_bit = '1';
        v_clear_pending := false;
        v_fail_pending := false;
      ELSIF v_pending_is_manual AND v_pending_expected_bit IS NOT NULL
            AND v_received_bit <> v_pending_expected_bit THEN
        -- Fora dos 60s e ainda não obedeceu: marca como falha e libera
        v_next_desired_running := v_received_bit = '1';
        v_clear_pending := true;
        v_fail_pending := COALESCE(v_pending_status, 'pending') <> 'executed';
      ELSE
        -- Sem comando manual pendente: reflete estado real
        v_next_desired_running := v_received_bit = '1';
      END IF;
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

    IF v_pending_confirms_expected
       AND v_eq.pending_command_id IS NOT NULL THEN
      UPDATE public.commands
      SET status = 'executed',
          response = COALESCE(response, _raw_response),
          responded_at = COALESCE(responded_at, now())
      WHERE id = v_eq.pending_command_id
        AND status IN ('pending', 'sent');
    END IF;

  END LOOP;

  RETURN v_first_eq_id;
END;
$function$;