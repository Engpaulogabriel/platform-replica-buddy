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
  v_existing_reset_id uuid := NULL;
  v_timeout_ms integer := 8000;
  v_reason text := COALESCE(NULLIF(_reason, ''), 'manual_reset');
  v_recent_command_id uuid := NULL;
  v_recent_command_status public.command_status := NULL;
  v_recent_payload text := NULL;
  v_recent_expected_bit text := NULL;
  v_is_protective_auto boolean := false;
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
    ELSIF v_recent_payload ~ '^[01]{2,6}$' AND length(v_recent_payload) >= v_eq.saida THEN
      v_recent_expected_bit := substring(v_recent_payload from v_eq.saida::int for 1);
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

  SELECT c.id
    INTO v_existing_reset_id
  FROM public.commands c
  WHERE c.farm_id = _farm_id
    AND c.equipment_id = _equipment_id
    AND c.type = 'manual'
    AND c.priority = 0
    AND c.status IN ('pending', 'sent')
    AND COALESCE(c.source_device, '') LIKE 'backend-reset:%'
  ORDER BY COALESCE(c.sent_at, c.created_at) DESC
  LIMIT 1;

  IF v_existing_reset_id IS NOT NULL THEN
    UPDATE public.equipments
    SET pending_command_id = v_existing_reset_id,
        command_blocked_until = NULL,
        desired_running = false,
        updated_at = now()
    WHERE id = _equipment_id
      AND farm_id = _farm_id;

    RETURN v_existing_reset_id;
  END IF;

  SELECT COALESCE(r.radio, 'R1'), COALESCE(r.via_repetidor, false)
    INTO v_radio, v_via_rep
  FROM public.rf_routing r
  WHERE r.farm_id = _farm_id
  LIMIT 1;

  v_lora := '[' || v_tsnn || '_1_]{0}[' || v_tsnn || '_ETX_]' || E'\r';
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
  v_pending_reset_still_waiting boolean := false;
  v_clear_pending boolean := false;
  v_fail_pending boolean := false;
  v_enqueue_safety_off boolean := false;
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
    v_pending_reset_still_waiting := false;
    v_clear_pending := false;
    v_fail_pending := false;
    v_enqueue_safety_off := false;
    v_next_desired_running := NULL;
    v_new_running := NULL;
    v_old_running := NULL;
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
        AND COALESCE(c.sent_at, c.created_at) > now() - interval '120 seconds'
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
                                       AND v_pending_started_at > now() - interval '120 seconds'
                                       AND NOT v_pending_is_protective_reset;

      v_pending_reset_still_waiting := v_pending_expected_bit IS NOT NULL
                                       AND v_received_bit IS NOT NULL
                                       AND v_received_bit <> v_pending_expected_bit
                                       AND v_pending_started_at IS NOT NULL
                                       AND v_pending_started_at > now() - interval '120 seconds'
                                       AND v_pending_is_protective_reset;
    END IF;

    IF v_state_changed THEN
      IF v_pending_confirms_expected AND NOT v_pending_is_protective_reset THEN
        v_origin := 'remote';
      ELSIF v_pending_within_start_window OR v_pending_reset_still_waiting THEN
        v_origin := COALESCE(v_eq.last_actuation_origin, NULL);
      ELSIF v_pending_is_manual AND v_pending_expected_bit IS NOT NULL
            AND v_received_bit = v_pending_expected_bit THEN
        v_origin := 'remote';
      ELSE
        v_origin := 'local';
        v_blocked_until := now() + interval '30 seconds';
      END IF;
    ELSE
      IF v_pending_confirms_expected AND NOT v_pending_is_protective_reset THEN
        v_origin := 'remote';
      END IF;
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
      last_actuation_origin = CASE WHEN v_enqueue_safety_off THEN 'local' ELSE COALESCE(v_origin, e.last_actuation_origin) END,
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
              WHEN v_pending_is_protective_reset THEN 'TX 0 de seguranca enviado, mas a bomba ainda respondeu ligada apos 120s'
              ELSE 'Bomba não obedeceu a ordem dentro da janela de 120s — TX 0 enfileirado por segurança'
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
      PERFORM public.enqueue_reset_pump_command(_farm_id, v_eq.id, 'manual_120s_timeout');
    END IF;

  END LOOP;

  RETURN v_first_eq_id;
END;
$function$;

WITH ranked_resets AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY farm_id, equipment_id
      ORDER BY COALESCE(sent_at, created_at) DESC, created_at DESC
    ) AS rn
  FROM public.commands
  WHERE type = 'manual'
    AND priority = 0
    AND status IN ('pending', 'sent')
    AND COALESCE(source_device, '') LIKE 'backend-reset:%'
    AND created_at > now() - interval '1 hour'
)
UPDATE public.commands c
SET status = 'cancelled',
    responded_at = now(),
    error_message = 'Reset duplicado cancelado para liberar o ciclo de comunicacao dos demais pocos'
FROM ranked_resets r
WHERE c.id = r.id
  AND r.rn > 1;

WITH latest_active_reset AS (
  SELECT DISTINCT ON (farm_id, equipment_id)
    farm_id,
    equipment_id,
    id
  FROM public.commands
  WHERE type = 'manual'
    AND priority = 0
    AND status IN ('pending', 'sent')
    AND COALESCE(source_device, '') LIKE 'backend-reset:%'
  ORDER BY farm_id, equipment_id, COALESCE(sent_at, created_at) DESC, created_at DESC
)
UPDATE public.equipments e
SET pending_command_id = l.id,
    desired_running = false,
    updated_at = now()
FROM latest_active_reset l
WHERE e.id = l.equipment_id
  AND e.farm_id = l.farm_id;

UPDATE public.commands
SET timeout_ms = 8000
WHERE status IN ('pending', 'sent')
  AND type = 'manual'
  AND priority = 0
  AND COALESCE(source_device, '') LIKE 'backend-reset:%'
  AND timeout_ms > 8000;