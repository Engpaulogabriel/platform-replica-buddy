-- 1. enqueue_polling_for_due_equipments: SEMPRE envia o ultimo estado desejado (0/1)
--    no polling, nunca mais colchetes vazios. Remove a janela de carencia de 15s.
CREATE OR REPLACE FUNCTION public.enqueue_polling_for_due_equipments(_farm_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
  v_eq RECORD;
  v_tsnn text;
  v_payload text;
  v_frame text;
  v_saida_idx int;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  FOR v_eq IN
    SELECT e.id, e.hw_id, e.type, e.saida, e.last_outputs_state,
           e.polling_interval_seconds, e.last_polling_at,
           e.pending_command_id,
           pg.hw_id AS plc_hw_id
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id
      AND e.active = true
      AND e.type IN ('poco', 'bombeamento')
      AND e.pending_command_id IS NULL
      AND (
        e.last_polling_at IS NULL
        OR e.last_polling_at < now() - (e.polling_interval_seconds || ' seconds')::interval
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.commands c
        WHERE c.equipment_id = e.id
          AND c.status = 'pending'
          AND c.type = 'polling'
      )
  LOOP
    v_tsnn := COALESCE(NULLIF(v_eq.plc_hw_id, ''), substring(v_eq.hw_id from 1 for 4));
    v_saida_idx := COALESCE(v_eq.saida, 1);

    -- SEMPRE envia o ultimo estado desejado da saida (0 ou 1).
    -- Nunca mais envia colchetes vazios (a placa cortava o comando).
    IF v_eq.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
      v_payload := substring(v_eq.last_outputs_state from v_saida_idx for 1);
    ELSIF v_eq.last_outputs_state ~ '^[01]$' THEN
      v_payload := v_eq.last_outputs_state;
    ELSE
      v_payload := '0';
    END IF;

    v_frame := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';

    INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
    VALUES (_farm_id, v_eq.id, v_tsnn, 'polling', 5, v_frame, 8000, 'platform-scheduler');

    UPDATE public.equipments SET last_polling_at = now() WHERE id = v_eq.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- 2. apply_pump_telemetry: remove a janela de carencia de 15s.
--    Comparacao direta com o ultimo comando manual decide remoto vs local.
CREATE OR REPLACE FUNCTION public.apply_pump_telemetry(_farm_id uuid, _tsnn text, _payload text, _signal_bars smallint DEFAULT NULL::smallint, _command_id uuid DEFAULT NULL::uuid, _raw_response text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_eq_id uuid;
  v_eq_saida smallint;
  v_eq_pending uuid;
  v_old_state text;
  v_new_running boolean;
  v_old_running boolean;
  v_payload_safe text;
  v_origin text;
  v_blocked_until timestamptz;
  v_state_changed boolean;
  v_recent_remote_command_at timestamptz;
  v_pending_frame text;
  v_pending_payload text;
  v_pending_is_manual boolean := false;
  v_pending_confirms_expected boolean := false;
  v_command_is_manual boolean := false;
  v_recent_manual_expected_running boolean;
  v_recent_manual_expected_known boolean := false;
  v_clear_pending boolean := false;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  SELECT id, COALESCE(saida, 1), pending_command_id, last_outputs_state
    INTO v_eq_id, v_eq_saida, v_eq_pending, v_old_state
  FROM public.equipments
  WHERE farm_id = _farm_id
    AND substring(hw_id from 1 for 4) = _tsnn
  LIMIT 1;

  IF v_eq_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF _payload IS NULL THEN
    v_payload_safe := NULL;
  ELSIF _payload ~ '^[01]{6}$' THEN
    v_payload_safe := _payload;
  ELSIF _payload ~ '^[01]$' AND v_eq_saida BETWEEN 1 AND 6 THEN
    v_payload_safe := overlay('000000' placing _payload from v_eq_saida::int for 1);
  ELSIF _payload = '' THEN
    v_payload_safe := NULL;
  ELSE
    v_payload_safe := NULL;
  END IF;

  v_state_changed := false;
  v_origin := NULL;
  v_blocked_until := NULL;

  IF v_payload_safe IS NOT NULL AND v_old_state IS NOT NULL
     AND v_old_state ~ '^[01]{6}$' THEN
    BEGIN
      v_new_running := substring(v_payload_safe from v_eq_saida::int for 1) = '1';
      v_old_running := substring(v_old_state from v_eq_saida::int for 1) = '1';
      v_state_changed := v_new_running IS DISTINCT FROM v_old_running;
    EXCEPTION WHEN OTHERS THEN
      v_state_changed := false;
    END;
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

  IF v_eq_pending IS NOT NULL THEN
    SELECT frame, type = 'manual'
      INTO v_pending_frame, v_pending_is_manual
    FROM public.commands
    WHERE id = v_eq_pending
      AND farm_id = _farm_id
    LIMIT 1;

    IF v_pending_is_manual AND v_payload_safe IS NOT NULL AND v_pending_frame IS NOT NULL THEN
      v_pending_payload := substring(v_pending_frame from '\{([01]{1,6})\}');
      IF v_pending_payload ~ '^[01]$' THEN
        v_pending_confirms_expected := substring(v_payload_safe from v_eq_saida::int for 1) = v_pending_payload;
      ELSIF v_pending_payload ~ '^[01]{6}$' THEN
        v_pending_confirms_expected := substring(v_payload_safe from v_eq_saida::int for 1) = substring(v_pending_payload from v_eq_saida::int for 1);
      END IF;
    END IF;
  END IF;

  IF v_state_changed THEN
    IF v_pending_confirms_expected THEN
      v_origin := 'remote';
    ELSIF v_command_is_manual THEN
      SELECT CASE
               WHEN frame ~ '\{[01]{6}\}' THEN substring(substring(frame from '\{([01]{6})\}') from v_eq_saida::int for 1) = '1'
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
               WHEN c.frame ~ '\{[01]{6}\}' THEN substring(substring(c.frame from '\{([01]{6})\}') from v_eq_saida::int for 1) = '1'
               WHEN c.frame ~ '\{[01]\}' THEN substring(c.frame from '\{([01])\}') = '1'
               ELSE NULL
             END
      INTO v_recent_remote_command_at, v_recent_manual_expected_running
      FROM public.commands c
      WHERE c.equipment_id = v_eq_id
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
                    OR (_command_id IS NOT NULL AND _command_id = v_eq_pending);

  UPDATE public.equipments
  SET
    last_communication = now(),
    last_signal_bars = COALESCE(_signal_bars, last_signal_bars),
    last_outputs_state = COALESCE(v_payload_safe, last_outputs_state),
    last_actuation_origin = COALESCE(v_origin, last_actuation_origin),
    command_blocked_until = COALESCE(v_blocked_until, command_blocked_until),
    pending_command_id = CASE WHEN v_clear_pending THEN NULL ELSE pending_command_id END,
    updated_at = now()
  WHERE id = v_eq_id;

  IF _command_id IS NOT NULL THEN
    UPDATE public.commands
    SET status = 'executed',
        responded_at = now(),
        response = COALESCE(_raw_response, response)
    WHERE id = _command_id AND farm_id = _farm_id;
  END IF;

  RETURN v_eq_id;
END;
$function$;