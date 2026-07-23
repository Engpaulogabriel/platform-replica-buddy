ALTER TABLE public.equipments
ADD COLUMN IF NOT EXISTS safety_expired_at timestamp with time zone;

CREATE OR REPLACE FUNCTION public.enqueue_reset_pump_command(_farm_id uuid, _equipment_id uuid, _reason text DEFAULT 'manual_reset'::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_eq RECORD;
  v_tsnn text;
  v_radio text := 'R1';
  v_via_rep boolean := false;
  v_payload text;
  v_frame text;
  v_command_id uuid;
  v_source_device text;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissão para fazenda %', _farm_id;
  END IF;

  SELECT e.*, COALESCE(pg.hw_id, substring(e.hw_id from 1 for 4)) AS plc_tsnn
  INTO v_eq
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.id = _equipment_id
    AND e.farm_id = _farm_id
    AND e.type IN ('poco', 'bombeamento')
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Equipamento % não encontrado', _equipment_id;
  END IF;

  v_tsnn := v_eq.plc_tsnn;
  IF v_tsnn IS NULL OR v_tsnn !~ '^\d{4}$' THEN
    RAISE EXCEPTION 'PLC inválido para equipamento %', _equipment_id;
  END IF;

  v_payload := repeat('0', GREATEST(1, LEAST(6, COALESCE(v_eq.saida, 1))));
  v_frame := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
  v_source_device := left('backend-reset:' || COALESCE(_reason, 'manual_reset'), 80);

  UPDATE public.commands
  SET status = 'cancelled',
      responded_at = now(),
      error_message = 'Cancelado por reset de segurança'
  WHERE farm_id = _farm_id
    AND status IN ('pending', 'sent')
    AND (
      equipment_id = _equipment_id
      OR (
        plc_hw_id = v_tsnn
        AND type = 'polling'
      )
    );

  INSERT INTO public.commands (
    farm_id, equipment_id, plc_hw_id, type, status, priority, frame,
    timeout_ms, source_device
  ) VALUES (
    _farm_id, _equipment_id, v_tsnn, 'manual', 'pending', 0, v_frame,
    10000, v_source_device
  )
  RETURNING id INTO v_command_id;

  UPDATE public.equipments
  SET pending_command_id = v_command_id,
      command_blocked_until = NULL,
      desired_running = false,
      safety_expired_at = now(),
      updated_at = now()
  WHERE id = _equipment_id
    AND farm_id = _farm_id;

  RETURN v_command_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enqueue_turn_on_timeout_resets(_farm_id uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_item RECORD;
  v_count integer := 0;
  v_is_running boolean;
  v_expected_bit text;
  v_payload text;
BEGIN
  IF _farm_id IS NULL THEN
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
      RAISE EXCEPTION 'Sem permissao para executar protecao global';
    END IF;
  ELSIF COALESCE(auth.role(), '') <> 'service_role'
        AND NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  FOR v_item IN
    SELECT
      e.farm_id,
      e.id AS equipment_id,
      COALESCE(e.saida, 1) AS saida_idx,
      e.last_outputs_state,
      e.last_actuation_origin,
      c.id AS command_id,
      c.frame
    FROM public.equipments e
    JOIN public.commands c
      ON c.id = e.pending_command_id
     AND c.farm_id = e.farm_id
    WHERE e.type IN ('poco', 'bombeamento')
      AND c.type = 'manual'
      AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
      AND c.status IN ('pending', 'sent', 'executed', 'timeout')
      AND COALESCE(c.sent_at, c.created_at) <= now() - interval '60 seconds'
      AND (_farm_id IS NULL OR e.farm_id = _farm_id)
  LOOP
    v_is_running := false;
    v_expected_bit := NULL;
    v_payload := substring(v_item.frame from '\{([01]{1,6})\}');

    IF v_payload ~ '^[01]$' THEN
      v_expected_bit := v_payload;
    ELSIF v_payload ~ '^[01]{2,6}$' AND length(v_payload) >= v_item.saida_idx THEN
      v_expected_bit := substring(v_payload from v_item.saida_idx for 1);
    END IF;

    IF v_expected_bit IS DISTINCT FROM '1' THEN
      CONTINUE;
    END IF;

    IF v_item.last_outputs_state ~ '^[01]{6}$' AND v_item.saida_idx BETWEEN 1 AND 6 THEN
      v_is_running := substring(v_item.last_outputs_state from v_item.saida_idx for 1) = '1';
    ELSIF v_item.last_outputs_state ~ '^[01]$' THEN
      v_is_running := v_item.last_outputs_state = '1';
    END IF;

    IF v_is_running THEN
      CONTINUE;
    END IF;

    UPDATE public.equipments
    SET last_actuation_origin = 'local',
        command_blocked_until = now() + interval '30 seconds',
        desired_running = false,
        safety_expired_at = now(),
        updated_at = now()
    WHERE id = v_item.equipment_id
      AND farm_id = v_item.farm_id;

    UPDATE public.commands
    SET status = 'timeout',
        responded_at = now(),
        error_message = 'Bomba nao ligou em 60s — comando TX 0 enfileirado por seguranca e alerta local ativado'
    WHERE id = v_item.command_id
      AND status IN ('pending', 'sent', 'executed', 'timeout');

    PERFORM public.enqueue_reset_pump_command(v_item.farm_id, v_item.equipment_id, 'turn_on_timeout');
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_commands_timeout(_farm_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
  v_stale_pending integer := 0;
  v_reset_count integer := 0;
  v_expired_reset_count integer := 0;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissão para fazenda %', _farm_id;
  END IF;

  v_reset_count := public.enqueue_turn_on_timeout_resets(_farm_id);

  WITH expired_resets AS (
    UPDATE public.commands
    SET status = 'error',
        responded_at = COALESCE(responded_at, now()),
        error_message = COALESCE(error_message, 'TX 0 de seguranca sem confirmacao apos 60s')
    WHERE farm_id = _farm_id
      AND type = 'manual'
      AND priority = 0
      AND status IN ('pending', 'sent')
      AND COALESCE(source_device, '') LIKE 'backend-reset:%'
      AND COALESCE(sent_at, created_at) <= now() - interval '60 seconds'
    RETURNING id, equipment_id
  ), clear_equipment AS (
    UPDATE public.equipments e
    SET pending_command_id = NULL,
        desired_running = false,
        safety_expired_at = now(),
        command_blocked_until = now() + interval '30 seconds',
        updated_at = now()
    FROM expired_resets r
    WHERE e.id = r.equipment_id
      AND e.farm_id = _farm_id
      AND e.pending_command_id = r.id
    RETURNING 1
  )
  SELECT count(*) INTO v_expired_reset_count FROM expired_resets;

  WITH updated AS (
    UPDATE public.commands
    SET status = 'timeout',
        responded_at = now(),
        error_message = 'Sem resposta dentro do timeout'
    WHERE farm_id = _farm_id
      AND status = 'sent'
      AND type <> 'manual'
      AND sent_at < now() - (timeout_ms || ' milliseconds')::interval
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM updated;

  WITH stale AS (
    UPDATE public.commands
    SET status = 'cancelled',
        responded_at = now(),
        error_message = 'Polling descartado: agente não pegou em 30s'
    WHERE farm_id = _farm_id
      AND status = 'pending'
      AND type = 'polling'
      AND created_at < now() - interval '30 seconds'
    RETURNING 1
  )
  SELECT count(*) INTO v_stale_pending FROM stale;

  RETURN COALESCE(v_count, 0) + COALESCE(v_stale_pending, 0) + COALESCE(v_reset_count, 0) + COALESCE(v_expired_reset_count, 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_pump_telemetry(_farm_id uuid, _tsnn text, _payload text, _signal_bars smallint DEFAULT NULL::smallint, _command_id uuid DEFAULT NULL::uuid, _raw_response text DEFAULT NULL::text, _origin text DEFAULT NULL::text)
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
  v_recent_safety_expiry boolean := false;
  v_clear_pending boolean := false;
  v_fail_pending boolean := false;
  v_enqueue_safety_off boolean := false;
  v_next_desired_running boolean := NULL;

  v_explicit_origin text := NULL;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

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
    WHERE id = _command_id
      AND farm_id = _farm_id
    LIMIT 1;

    v_command_is_manual := COALESCE(v_command_is_manual, false);
    IF v_cmd_frame IS NOT NULL THEN
      v_cmd_payload := substring(v_cmd_frame from '\{([01]{1,6})\}');
    END IF;
  END IF;

  IF _payload IS NULL OR _payload = '' THEN
    v_payload_saida := NULL;
    v_payload_bit := NULL;
  ELSIF _payload ~ '^[01]{6}$' THEN
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
    SELECT id, name, COALESCE(saida, 1) AS saida, pending_command_id, last_outputs_state, desired_running, last_actuation_origin, safety_expired_at
    FROM public.equipments
    WHERE farm_id = _farm_id
      AND substring(hw_id from 1 for 4) = _tsnn
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
    v_recent_safety_expiry := COALESCE(v_eq.safety_expired_at > now() - interval '30 seconds', false);
    v_clear_pending := false;
    v_fail_pending := false;
    v_enqueue_safety_off := false;
    v_next_desired_running := NULL;
    v_new_running := NULL;
    v_old_running := NULL;
    v_payload_to_store := NULL;

    IF v_eq.last_outputs_state ~ '^[01]{6}$' THEN
      v_base_state := v_eq.last_outputs_state;
    ELSE
      v_base_state := '000000';
    END IF;

    IF v_is_full_bitfield THEN
      v_payload_to_store := _payload;
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
      WHERE id = v_eq.pending_command_id
        AND farm_id = _farm_id
      LIMIT 1;
    END IF;

    IF (NOT v_pending_is_manual OR v_pending_frame IS NULL) AND _command_id IS NOT NULL
       AND v_cmd_equipment_id = v_eq.id THEN
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

    IF v_pending_is_manual AND v_received_bit IS NOT NULL AND v_pending_frame IS NOT NULL THEN
      v_pending_payload := substring(v_pending_frame from '\{([01]{1,6})\}');

      IF v_pending_payload ~ '^[01]$' THEN
        v_pending_expected_bit := v_pending_payload;
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
                                       AND NOT v_pending_is_protective_reset;

      v_pending_reset_still_waiting := v_pending_expected_bit IS NOT NULL
                                       AND v_received_bit <> v_pending_expected_bit
                                       AND v_pending_started_at IS NOT NULL
                                       AND v_pending_started_at > now() - interval '60 seconds'
                                       AND v_pending_is_protective_reset;
    END IF;

    IF v_pending_confirms_expected AND NOT v_pending_is_protective_reset THEN
      v_origin := 'remote';
    ELSIF v_explicit_origin = 'local' AND NOT v_recent_safety_expiry THEN
      v_origin := 'local';
      v_blocked_until := now() + interval '30 seconds';
    ELSIF COALESCE(v_eq.last_actuation_origin, '') = 'local' THEN
      v_origin := NULL;
    ELSIF v_explicit_origin = 'remote' THEN
      v_origin := 'remote';
    ELSE
      v_origin := NULL;
    END IF;

    IF v_received_bit IN ('0', '1') THEN
      IF v_pending_confirms_expected THEN
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
      ELSIF v_recent_safety_expiry THEN
        v_next_desired_running := NULL;
        v_clear_pending := false;
        v_fail_pending := false;
        v_enqueue_safety_off := false;
        v_blocked_until := COALESCE(v_blocked_until, now() + interval '30 seconds');
      ELSIF v_pending_is_manual AND v_pending_expected_bit IS NOT NULL
            AND v_received_bit <> v_pending_expected_bit THEN
        v_next_desired_running := false;
        v_clear_pending := true;
        v_fail_pending := COALESCE(v_pending_status, 'pending') <> 'executed';
        v_enqueue_safety_off := NOT v_pending_is_protective_reset;
        v_blocked_until := now() + interval '30 seconds';
      ELSE
        v_next_desired_running := v_received_bit = '1';
      END IF;
    END IF;

    UPDATE public.equipments e
    SET
      last_outputs_state = COALESCE(v_payload_to_store, e.last_outputs_state),
      last_communication = now(),
      last_signal_bars = COALESCE(_signal_bars, e.last_signal_bars),
      desired_running = COALESCE(v_next_desired_running, e.desired_running),
      last_actuation_origin = CASE
                                WHEN v_enqueue_safety_off THEN 'local'
                                ELSE COALESCE(v_origin, e.last_actuation_origin)
                              END,
      command_blocked_until = COALESCE(v_blocked_until, e.command_blocked_until),
      pending_command_id = CASE WHEN v_clear_pending THEN NULL ELSE e.pending_command_id END,
      updated_at = now()
    WHERE e.id = v_eq.id;

    IF v_fail_pending AND v_eq.pending_command_id IS NOT NULL THEN
      UPDATE public.commands
      SET status = 'error',
          error_message = COALESCE(
            error_message,
            CASE
              WHEN v_pending_is_protective_reset THEN 'TX 0 de seguranca enviado, mas a bomba ainda respondeu ligada apos 60s'
              ELSE 'Bomba não obedeceu a ordem dentro da janela de 60s — TX 0 enfileirado por segurança'
            END
          ),
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

    IF v_enqueue_safety_off THEN
      PERFORM public.enqueue_reset_pump_command(_farm_id, v_eq.id, 'manual_60s_timeout');
    END IF;

  END LOOP;

  RETURN v_first_eq_id;
END;
$function$;