CREATE OR REPLACE FUNCTION public.enqueue_polling_for_due_equipments(_farm_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
  v_grp RECORD;
  v_eq RECORD;
  v_payload_bits text[];
  v_frame text;
  v_payload text;
  v_saida_idx int;
  v_active_expected_bit text;
  v_actual_bit text;
  v_pending_payload text;
  i int;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  FOR v_grp IN
    WITH due AS (
      SELECT e.id, e.hw_id, e.saida, e.plc_group_id, e.last_polling_at,
             COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn
      FROM public.equipments e
      LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
      WHERE e.farm_id = _farm_id
        AND e.active = true
        AND e.type IN ('poco', 'bombeamento')
        AND (
          e.last_polling_at IS NULL
          OR e.last_polling_at < now() - (e.polling_interval_seconds || ' seconds')::interval
        )
    ),
    plc_size AS (
      SELECT
        COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn,
        GREATEST(COALESCE(MAX(e.saida), 1), 1) AS max_saida
      FROM public.equipments e
      LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
      WHERE e.farm_id = _farm_id
        AND e.active = true
        AND e.type IN ('poco', 'bombeamento')
      GROUP BY 1
    )
    SELECT
      due.tsnn,
      array_agg(due.id) AS equipment_ids,
      (array_agg(due.id ORDER BY due.saida NULLS LAST))[1] AS rep_equipment_id,
      LEAST(GREATEST(ps.max_saida, 1), 6) AS payload_size
    FROM due
    JOIN plc_size ps ON ps.tsnn = due.tsnn
    GROUP BY due.tsnn, ps.max_saida
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.commands cp
      WHERE cp.farm_id = _farm_id
        AND cp.status = 'pending'
        AND cp.type = 'polling'
        AND cp.plc_hw_id = v_grp.tsnn
    ) THEN
      CONTINUE;
    END IF;

    v_payload_bits := ARRAY[]::text[];
    FOR i IN 1..v_grp.payload_size LOOP
      v_payload_bits := array_append(v_payload_bits, '0');
    END LOOP;

    FOR v_eq IN
      SELECT e.id,
             COALESCE(e.saida, 1) AS saida_idx,
             e.last_outputs_state,
             e.pending_command_id,
             c.type AS pending_type,
             c.status AS pending_status,
             c.frame AS pending_frame
      FROM public.equipments e
      LEFT JOIN public.commands c
        ON c.id = e.pending_command_id
       AND c.farm_id = e.farm_id
      WHERE e.id = ANY(v_grp.equipment_ids)
    LOOP
      v_saida_idx := v_eq.saida_idx;
      IF v_saida_idx < 1 OR v_saida_idx > v_grp.payload_size THEN
        CONTINUE;
      END IF;

      v_active_expected_bit := NULL;
      v_actual_bit := NULL;
      v_pending_payload := NULL;

      IF v_eq.pending_type = 'manual'
         AND v_eq.pending_status IN ('pending', 'sent')
         AND v_eq.pending_frame IS NOT NULL THEN
        v_pending_payload := substring(v_eq.pending_frame from '\{([01]{1,6})\}');

        IF v_pending_payload ~ '^[01]$' THEN
          v_active_expected_bit := v_pending_payload;
        ELSIF v_pending_payload ~ '^[01]{2,6}$'
              AND length(v_pending_payload) >= v_saida_idx THEN
          v_active_expected_bit := substring(v_pending_payload from v_saida_idx for 1);
        END IF;
      END IF;

      IF v_eq.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
        v_actual_bit := substring(v_eq.last_outputs_state from v_saida_idx for 1);
      ELSIF v_eq.last_outputs_state ~ '^[01]$' THEN
        v_actual_bit := v_eq.last_outputs_state;
      END IF;

      v_payload_bits[v_saida_idx] := COALESCE(v_active_expected_bit, v_actual_bit, '0');
    END LOOP;

    v_payload := array_to_string(v_payload_bits, '');
    v_frame := '[' || v_grp.tsnn || '_1_]{' || v_payload || '}[' || v_grp.tsnn || '_ETX_]' || E'\r';

    INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
    VALUES (_farm_id, v_grp.rep_equipment_id, v_grp.tsnn, 'polling', 5, v_frame, 8000, 'platform-scheduler');

    UPDATE public.equipments
    SET last_polling_at = now()
    WHERE id = ANY(v_grp.equipment_ids);

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

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
  v_pending_status public.command_status;
  v_pending_expected_bit text;
  v_received_bit text;
  v_pending_confirms_expected boolean := false;
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
    SELECT id, COALESCE(saida, 1) AS saida, pending_command_id, last_outputs_state, desired_running
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
    v_pending_status := NULL;
    v_pending_expected_bit := NULL;
    v_received_bit := NULL;
    v_pending_confirms_expected := false;
    v_clear_pending := false;
    v_fail_pending := false;
    v_recent_remote_command_at := NULL;
    v_recent_manual_expected_running := NULL;
    v_recent_manual_expected_known := false;
    v_next_desired_running := NULL;

    IF v_payload_safe IS NOT NULL THEN
      v_received_bit := substring(v_payload_safe from v_eq.saida::int for 1);
    END IF;

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
      SELECT frame, type = 'manual', status
        INTO v_pending_frame, v_pending_is_manual, v_pending_status
      FROM public.commands
      WHERE id = v_eq.pending_command_id
        AND farm_id = _farm_id
      LIMIT 1;

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

    IF v_received_bit IN ('0', '1') THEN
      IF v_pending_is_manual AND v_pending_expected_bit = '1' AND v_received_bit = '0' THEN
        v_next_desired_running := false;
        v_clear_pending := true;
        v_fail_pending := coalesce(v_pending_status, 'pending') <> 'executed';
      ELSIF v_eq.pending_command_id IS NOT NULL AND v_pending_is_manual AND NOT v_pending_confirms_expected THEN
        IF v_pending_expected_bit = '0' THEN
          v_next_desired_running := false;
        ELSE
          v_next_desired_running := v_eq.desired_running;
        END IF;
      ELSE
        v_next_desired_running := v_received_bit = '1';
      END IF;
    END IF;

    IF v_eq.pending_command_id IS NOT NULL
       AND v_pending_is_manual
       AND COALESCE(v_pending_status, 'pending') NOT IN ('pending', 'sent')
       AND v_received_bit = '0' THEN
      v_next_desired_running := false;
      v_clear_pending := true;
    END IF;

    v_clear_pending := v_clear_pending
                      OR v_pending_confirms_expected
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
      desired_running = COALESCE(v_next_desired_running, desired_running),
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
    ELSIF v_fail_pending AND v_eq.pending_command_id IS NOT NULL THEN
      UPDATE public.commands
      SET status = 'error',
          responded_at = now(),
          response = COALESCE(_raw_response, response),
          error_message = 'Telemetria confirmou 0: comando de ligar nao foi aplicado'
      WHERE id = v_eq.pending_command_id
        AND farm_id = _farm_id
        AND status IN ('pending', 'sent');
    END IF;
  END LOOP;

  IF _command_id IS NOT NULL THEN
    IF v_command_is_manual THEN
      UPDATE public.commands
      SET response = COALESCE(_raw_response, response)
      WHERE id = _command_id
        AND farm_id = _farm_id
        AND status IN ('pending', 'sent', 'executed', 'error');
    ELSE
      UPDATE public.commands
      SET status = 'executed',
          responded_at = now(),
          response = COALESCE(_raw_response, response)
      WHERE id = _command_id
        AND farm_id = _farm_id
        AND status IN ('pending', 'sent');
    END IF;
  END IF;

  RETURN v_first_eq_id;
END;
$function$;