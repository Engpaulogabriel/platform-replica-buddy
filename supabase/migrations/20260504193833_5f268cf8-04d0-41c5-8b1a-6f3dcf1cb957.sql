CREATE OR REPLACE FUNCTION public.enqueue_polling_for_due_equipments_internal(_farm_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_plc RECORD;
  v_eq RECORD;
  v_payload text;
  v_pos int;
  v_max_saida int;
  v_intent_bit text;
  v_last_payload text;
  v_desired_on boolean;
  v_frame text;
  v_first_eq_id uuid;
BEGIN
  DELETE FROM public.commands
  WHERE farm_id = _farm_id
    AND status = 'pending'
    AND type = 'polling'
    AND created_at < now() - interval '30 seconds';

  UPDATE public.commands
  SET status = 'timeout',
      responded_at = now(),
      error_message = 'Sem resposta dentro do timeout'
  WHERE farm_id = _farm_id
    AND status = 'sent'
    AND type = 'polling'
    AND sent_at < now() - (GREATEST(timeout_ms, 13000) || ' milliseconds')::interval;

  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.farm_id = _farm_id
      AND c.type = 'polling'
      AND c.source_device = 'platform-scheduler'
      AND c.created_at > now() - interval '12.5 seconds'
  ) THEN
    RETURN 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.farm_id = _farm_id
      AND c.status IN ('pending', 'sent')
      AND c.type = 'polling'
  ) THEN
    RETURN 0;
  END IF;

  SELECT
    COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn,
    MIN(COALESCE(e.last_polling_at, 'epoch'::timestamptz)) AS oldest_polling_at
  INTO v_plc
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.farm_id = _farm_id
    AND e.active = true
    AND e.type IN ('poco', 'bombeamento')
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) IS NOT NULL
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) ~ '^\d{4}$'
  GROUP BY 1
  ORDER BY oldest_polling_at ASC, tsnn ASC
  LIMIT 1;

  IF v_plc.tsnn IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(MAX(COALESCE(e.saida, 1)), 0)
  INTO v_max_saida
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.farm_id = _farm_id
    AND e.active = true
    AND e.type IN ('poco', 'bombeamento')
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn;

  IF v_max_saida < 1 THEN
    RETURN 0;
  END IF;
  IF v_max_saida > 6 THEN
    v_max_saida := 6;
  END IF;

  v_payload := '';
  v_first_eq_id := NULL;

  FOR v_pos IN 1..v_max_saida LOOP
    v_intent_bit := NULL;
    v_last_payload := NULL;
    v_desired_on := false;

    SELECT
      e.id,
      COALESCE(e.desired_running, false) AS desired_running,
      COALESCE(e.last_actuation_origin, '') AS origin,
      e.command_blocked_until
    INTO v_eq
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id
      AND e.active = true
      AND e.type IN ('poco', 'bombeamento')
      AND COALESCE(e.saida, 1) = v_pos
      AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn
    LIMIT 1;

    IF FOUND THEN
      IF v_eq.origin = 'local' OR v_eq.command_blocked_until > now() THEN
        v_desired_on := v_eq.desired_running;
      ELSE
        SELECT substring(c.frame from '\{([01]{1,6})\}')
        INTO v_last_payload
        FROM public.commands c
        WHERE c.farm_id = _farm_id
          AND c.equipment_id = v_eq.id
          AND c.type = 'manual'
          AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
          AND substring(c.frame from '\{([01]{1,6})\}') IS NOT NULL
        ORDER BY COALESCE(c.sent_at, c.created_at) DESC
        LIMIT 1;

        IF v_last_payload IS NOT NULL THEN
          IF length(v_last_payload) >= v_pos THEN
            v_intent_bit := substring(v_last_payload from v_pos for 1);
          ELSE
            v_intent_bit := right(v_last_payload, 1);
          END IF;
        END IF;

        IF v_intent_bit IN ('0', '1') THEN
          v_desired_on := v_intent_bit = '1';
        ELSE
          v_desired_on := v_eq.desired_running;
        END IF;
      END IF;

      v_payload := v_payload || (CASE WHEN v_desired_on THEN '1' ELSE '0' END);

      IF v_first_eq_id IS NULL THEN
        v_first_eq_id := v_eq.id;
      END IF;
    ELSE
      v_payload := v_payload || '0';
    END IF;
  END LOOP;

  v_frame := '[' || v_plc.tsnn || '_1_]{' || v_payload || '}[' || v_plc.tsnn || '_ETX_]' || E'\r';

  INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
  VALUES (_farm_id, v_first_eq_id, v_plc.tsnn, 'polling', 5, v_frame, 13000, 'platform-scheduler');

  UPDATE public.equipments e
  SET last_polling_at = now()
  WHERE e.farm_id = _farm_id
    AND e.active = true
    AND e.type IN ('poco', 'bombeamento')
    AND COALESCE(
          (SELECT pg.hw_id FROM public.plc_groups pg WHERE pg.id = e.plc_group_id),
          substring(e.hw_id from 1 for 4)
        ) = v_plc.tsnn;

  RETURN 1;
END;
$function$;

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
  v_lora text;
  v_frame text;
  v_command_id uuid;
  v_timeout_ms integer := 60000;
  v_reason text := COALESCE(NULLIF(_reason, ''), 'manual_reset');
  v_recent_command_id uuid := NULL;
  v_recent_command_status public.command_status := NULL;
  v_recent_payload text := NULL;
  v_recent_expected_bit text := NULL;
  v_is_protective_auto boolean := false;
  v_payload text;
  v_saida int;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  SELECT e.id, e.farm_id, e.hw_id, e.plc_group_id, e.type, COALESCE(e.saida, 1) AS saida
    INTO v_eq
  FROM public.equipments e
  WHERE e.id = _equipment_id
    AND e.farm_id = _farm_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Equipamento nao encontrado';
  END IF;

  IF v_eq.type NOT IN ('poco', 'bombeamento') THEN
    RAISE EXCEPTION 'Equipamento % nao aceita reset', v_eq.type;
  END IF;

  v_saida := GREATEST(1, LEAST(6, v_eq.saida));

  v_is_protective_auto := v_reason IN (
    'local_startup_detected',
    'local_shutdown_detected',
    'turn_on_timeout'
  );

  IF v_is_protective_auto THEN
    SELECT c.id, c.status, substring(c.frame from '\{([01]{1,6})\}')
      INTO v_recent_command_id, v_recent_command_status, v_recent_payload
    FROM public.commands c
    WHERE c.farm_id = _farm_id
      AND c.equipment_id = _equipment_id
      AND c.type = 'manual'
      AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
      AND COALESCE(c.sent_at, c.created_at) > now() - interval '60 seconds'
    ORDER BY COALESCE(c.sent_at, c.created_at) DESC
    LIMIT 1;

    IF v_recent_payload ~ '^[01]$' THEN
      v_recent_expected_bit := v_recent_payload;
    ELSIF v_recent_payload ~ '^[01]{2,6}$' AND length(v_recent_payload) >= v_saida THEN
      v_recent_expected_bit := substring(v_recent_payload from v_saida::int for 1);
    END IF;

    IF v_recent_expected_bit = '1' THEN
      UPDATE public.equipments
      SET last_actuation_origin = COALESCE(last_actuation_origin, 'remote'),
          command_blocked_until = NULL,
          desired_running = true,
          pending_command_id = CASE
            WHEN v_recent_command_status IN ('pending', 'sent') THEN v_recent_command_id
            ELSE pending_command_id
          END,
          updated_at = now()
      WHERE id = _equipment_id
        AND farm_id = _farm_id;

      INSERT INTO public.agent_logs (farm_id, level, category, message)
      VALUES (
        _farm_id,
        'info',
        'safety',
        format(
          'Reset automatico (%s) BLOQUEADO: existe comando remoto de LIGAR enviado ha menos de 60s para a bomba %s. Aguardando confirmacao espontanea sem interferir.',
          v_reason, _equipment_id
        )
      );

      RETURN v_recent_command_id;
    END IF;
  END IF;

  IF v_eq.plc_group_id IS NOT NULL THEN
    SELECT pg.hw_id
      INTO v_tsnn
    FROM public.plc_groups pg
    WHERE pg.id = v_eq.plc_group_id
    LIMIT 1;
  END IF;

  v_tsnn := COALESCE(NULLIF(v_tsnn, ''), substring(v_eq.hw_id from 1 for 4));

  SELECT COALESCE(r.radio, 'R1'), COALESCE(r.via_repetidor, false)
    INTO v_radio, v_via_rep
  FROM public.rf_routing r
  WHERE r.farm_id = _farm_id
  LIMIT 1;

  v_payload := repeat('0', v_saida);

  v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
  v_frame := CASE
    WHEN COALESCE(v_via_rep, false) THEN 'REP:R3:TX:' || COALESCE(v_radio, 'R1') || ':' || v_lora
    ELSE v_lora
  END;

  INSERT INTO public.commands (
    farm_id,
    equipment_id,
    plc_hw_id,
    type,
    priority,
    frame,
    timeout_ms,
    created_by,
    client_event_id,
    source_device
  )
  VALUES (
    _farm_id,
    _equipment_id,
    v_tsnn,
    'manual',
    0,
    v_frame,
    v_timeout_ms,
    auth.uid(),
    gen_random_uuid(),
    left('backend-reset:' || v_reason, 80)
  )
  RETURNING id INTO v_command_id;

  UPDATE public.commands
  SET status = 'cancelled',
      responded_at = now(),
      error_message = CASE
        WHEN v_reason = 'turn_on_timeout'
          THEN 'Cancelado por seguranca: comando 0 enfileirado apos falha ao ligar'
        ELSE 'Cancelado por RESET de emergencia'
      END
  WHERE farm_id = _farm_id
    AND id <> v_command_id
    AND status IN ('pending', 'sent')
    AND (
      equipment_id = _equipment_id
      OR (
        plc_hw_id = v_tsnn
        AND type = 'polling'
      )
    );

  UPDATE public.equipments
  SET pending_command_id = v_command_id,
      command_blocked_until = NULL,
      desired_running = false,
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

  RETURN COALESCE(v_count, 0) + COALESCE(v_reset_count, 0) + COALESCE(v_stale_pending, 0) + COALESCE(v_expired_reset_count, 0);
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
    SELECT id, name, COALESCE(saida, 1) AS saida, pending_command_id, last_outputs_state, desired_running, last_actuation_origin
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
    ELSIF v_explicit_origin = 'local' THEN
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