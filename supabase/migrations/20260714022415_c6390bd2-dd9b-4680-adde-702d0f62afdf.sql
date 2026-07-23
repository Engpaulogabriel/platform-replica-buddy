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
  v_fail_pending boolean := false;
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
BEGIN
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
    v_fail_pending := false;
    v_enqueue_safety_off := false;
    v_next_desired_running := NULL;
    v_new_running := NULL;
    v_old_running := NULL;
    v_payload_to_store := NULL;
    v_old_desired := COALESCE(v_eq.desired_running, false);
    v_recent_manual_cmd := false;
    v_recent_cmd_90s := false;
    v_local_no_recent_cmd := false;

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
      SELECT EXISTS (
        SELECT 1 FROM public.commands c
        WHERE c.farm_id = _farm_id
          AND c.equipment_id = v_eq.id
          AND c.type = 'manual'
          AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
          AND COALESCE(c.responded_at, c.sent_at, c.created_at) > now() - interval '5 minutes'
          AND (
            substring(c.frame from '\{([01])\}') = v_received_bit
            OR (c.frame ~ '\{[01]{2,6}\}'
                AND substring(substring(c.frame from '\{([01]{2,6})\}')
                              from length(substring(c.frame from '\{([01]{2,6})\}')) for 1) = v_received_bit)
          )
      ) INTO v_recent_remote_match;
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

    v_pending_command_active := v_pending_frame IS NOT NULL AND COALESCE(v_pending_status, 'pending'::public.command_status) IN ('pending'::public.command_status, 'sent'::public.command_status);
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
    ELSIF v_explicit_origin = 'local' AND NOT v_recent_safety_expiry AND NOT v_pending_command_active AND NOT v_recent_remote_match AND NOT v_desired_matches_received THEN
      v_origin := 'local';
      v_blocked_until := now() + interval '30 seconds';
    ELSIF v_state_changed AND NOT v_pending_command_active AND NOT v_recent_remote_match AND NOT v_recent_safety_expiry AND NOT v_desired_matches_received THEN
      v_origin := 'local';
      v_blocked_until := now() + interval '30 seconds';
    ELSIF v_received_bit IN ('0','1')
          AND NOT v_desired_matches_received
          AND NOT v_pending_command_active
          AND NOT v_recent_manual_cmd
          AND NOT v_recent_remote_match
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

    IF v_received_bit IN ('0', '1') THEN
      IF v_local_no_recent_cmd THEN
        v_next_desired_running := NULL;
        v_clear_pending := false;
        v_fail_pending := false;
        v_enqueue_safety_off := false;
      ELSIF v_pending_confirms_expected THEN
        v_next_desired_running := v_pending_expected_bit = '1';
        v_clear_pending := true;
        v_fail_pending := false;
      ELSIF v_pending_within_start_window THEN
        v_next_desired_running := v_pending_expected_bit = '1';
        v_clear_pending := false;
        v_fail_pending := false;
      ELSIF v_pending_reset_still_waiting THEN
        v_next_desired_running := false;
        v_clear_pending := false;
        v_fail_pending := false;
        v_enqueue_safety_off := false;
        v_blocked_until := now() + interval '30 seconds';
      ELSIF v_pending_is_manual AND v_pending_expected_bit IS NOT NULL
            AND v_received_bit <> v_pending_expected_bit THEN
        -- Correção definitiva: RX divergente durante comando manual é apenas telemetria intermediária.
        -- O agente local mantém o reforço e decide timeout/erro após a janela operacional.
        v_next_desired_running := v_pending_expected_bit = '1';
        v_clear_pending := false;
        v_fail_pending := false;
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
      last_actuation_origin = COALESCE(v_origin, e.last_actuation_origin),
      command_blocked_until = COALESCE(v_blocked_until, e.command_blocked_until),
      pending_command_id = CASE WHEN v_clear_pending THEN NULL ELSE e.pending_command_id END,
      updated_at = now()
    WHERE e.id = v_eq.id;

    IF v_state_changed AND v_new_running IS NOT NULL THEN
      INSERT INTO public.automation_log(
        farm_id, equipment_id, equipment_name, action, origin, result, actor_label,
        new_state, source_device, occurred_at, details
      ) VALUES (
        _farm_id, v_eq.id, v_eq.name,
        CASE WHEN v_new_running THEN 'pump_on'::public.event_action ELSE 'pump_off'::public.event_action END,
        CASE WHEN v_origin = 'local' THEN 'local'::public.event_origin
             WHEN v_origin = 'remote' THEN 'remote'::public.event_origin
             ELSE 'system'::public.event_origin END,
        'success'::public.event_result,
        CASE WHEN v_origin = 'local' THEN 'Acionamento local' ELSE 'Telemetria RF' END,
        CASE WHEN v_new_running THEN 'on' ELSE 'off' END,
        'serial-bridge',
        now(),
        jsonb_build_object('payload', _payload, 'raw', _raw_response, 'origin', v_origin)
      );
    END IF;

    IF v_fail_pending THEN
      UPDATE public.commands
      SET status = 'error',
          error_message = COALESCE(error_message, 'RX divergente do payload esperado'),
          responded_at = COALESCE(responded_at, now())
      WHERE id = v_eq.pending_command_id
        AND status IN ('pending', 'sent');
    ELSIF v_clear_pending AND v_eq.pending_command_id IS NOT NULL THEN
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