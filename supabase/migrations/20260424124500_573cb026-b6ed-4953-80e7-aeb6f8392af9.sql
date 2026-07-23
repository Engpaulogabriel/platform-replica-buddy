CREATE OR REPLACE FUNCTION public.apply_pump_telemetry(
  _farm_id uuid,
  _tsnn text,
  _payload text,
  _signal_bars smallint DEFAULT NULL::smallint,
  _command_id uuid DEFAULT NULL::uuid,
  _raw_response text DEFAULT NULL::text
)
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
  v_pending_expected_bit text;
  v_received_bit text;
  v_pending_confirms_expected boolean := false;
  v_clear_pending boolean := false;
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
    SELECT id, COALESCE(saida, 1) AS saida, pending_command_id, last_outputs_state
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
    v_pending_expected_bit := NULL;
    v_received_bit := NULL;
    v_pending_confirms_expected := false;
    v_clear_pending := false;
    v_recent_remote_command_at := NULL;
    v_recent_manual_expected_running := NULL;
    v_recent_manual_expected_known := false;

    IF v_payload_safe IS NOT NULL AND v_eq.last_outputs_state IS NOT NULL
       AND v_eq.last_outputs_state ~ '^[01]{6}$' THEN
      BEGIN
        v_new_running := substring(v_payload_safe from v_eq.saida::int for 1) = '1';
        v_old_running := substring(v_eq.last_outputs_state from v_eq.saida::int for 1) = '1';
        v_state_changed := v_new_running IS DISTINCT FROM v_old_running;
      EXCEPTION WHEN OTHERS THEN
        v_state_changed := false;
      END;
    END IF;

    IF v_eq.pending_command_id IS NOT NULL THEN
      SELECT frame, type = 'manual'
        INTO v_pending_frame, v_pending_is_manual
      FROM public.commands
      WHERE id = v_eq.pending_command_id
        AND farm_id = _farm_id
      LIMIT 1;

      IF v_pending_is_manual AND v_payload_safe IS NOT NULL AND v_pending_frame IS NOT NULL THEN
        v_pending_payload := substring(v_pending_frame from '\{([01]{1,6})\}');
        v_received_bit := substring(v_payload_safe from v_eq.saida::int for 1);

        IF v_pending_payload ~ '^[01]$' THEN
          v_pending_expected_bit := v_pending_payload;
        ELSIF v_pending_payload ~ '^[01]{2,6}$' THEN
          IF length(v_pending_payload) >= v_eq.saida THEN
            v_pending_expected_bit := substring(v_pending_payload from v_eq.saida::int for 1);
          END IF;
        END IF;

        v_pending_confirms_expected := v_pending_expected_bit IS NOT NULL
                                       AND v_received_bit = v_pending_expected_bit;
      END IF;
    END IF;

    IF v_state_changed THEN
      IF v_pending_confirms_expected THEN
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
        ELSE
          v_origin := 'local';
          v_blocked_until := now() + interval '30 seconds';
        END IF;
      END IF;
    END IF;

    v_clear_pending := v_pending_confirms_expected
                      OR (
                        _command_id IS NOT NULL
                        AND _command_id = v_eq.pending_command_id
                        AND NOT v_pending_is_manual
                      );

    UPDATE public.equipments
    SET
      last_communication = now(),
      last_signal_bars = COALESCE(_signal_bars, last_signal_bars),
      last_outputs_state = COALESCE(v_payload_safe, last_outputs_state),
      last_actuation_origin = COALESCE(v_origin, last_actuation_origin),
      command_blocked_until = COALESCE(v_blocked_until, command_blocked_until),
      pending_command_id = CASE WHEN v_clear_pending THEN NULL ELSE pending_command_id END,
      updated_at = now()
    WHERE id = v_eq.id;

    IF v_pending_confirms_expected AND v_eq.pending_command_id IS NOT NULL THEN
      UPDATE public.commands
      SET status = 'executed',
          responded_at = now(),
          response = COALESCE(_raw_response, response)
      WHERE id = v_eq.pending_command_id
        AND farm_id = _farm_id
        AND status IN ('pending', 'sent');
    END IF;
  END LOOP;

  IF _command_id IS NOT NULL THEN
    UPDATE public.commands
    SET status = 'executed',
        responded_at = now(),
        response = COALESCE(_raw_response, response)
    WHERE id = _command_id
      AND farm_id = _farm_id;
  END IF;

  RETURN v_first_eq_id;
END;
$function$;