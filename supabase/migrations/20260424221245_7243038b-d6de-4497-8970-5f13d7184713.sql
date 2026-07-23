-- Atualiza apply_pump_telemetry: aumenta janela "pending start" de 60s para 180s
-- Motivo: bombas com partida suave/contator demoram 5-30s para confirmar via telemetria.
-- Antes 60s era curto; em redes lentas o {0} chegava antes do {1} real e disparava
-- proteção indevida. 180s acomoda partida lenta sem comprometer segurança real.

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
    SELECT id, name, COALESCE(saida, 1) AS saida, pending_command_id, last_outputs_state, desired_running
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
      SELECT frame, type = 'manual', status, COALESCE(sent_at, created_at)
        INTO v_pending_frame, v_pending_is_manual, v_pending_status, v_pending_started_at
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

        -- AUMENTADO de 60s para 180s: dá tempo da bomba acionar fisicamente
        v_pending_within_start_window := v_pending_expected_bit = '1'
                                         AND v_received_bit = '0'
                                         AND v_pending_started_at IS NOT NULL
                                         AND v_pending_started_at > now() - interval '180 seconds';
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
          AND c.sent_at > now() - interval '180 seconds'
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
      IF v_pending_confirms_expected THEN
        v_origin := 'remote';
      END IF;

      -- AUMENTADO de 60s para 180s
      IF v_pending_is_manual
         AND v_pending_expected_bit = '1'
         AND v_received_bit = '0'
         AND v_pending_started_at IS NOT NULL
         AND v_pending_started_at <= now() - interval '180 seconds' THEN
        v_origin := 'local';
        v_blocked_until := now() + interval '30 seconds';
      END IF;

      IF COALESCE(v_eq.desired_running, false) = true
         AND v_new_running = false
         AND NOT v_pending_within_start_window
         AND COALESCE(v_pending_expected_bit, '') <> '0' THEN
        -- Só força OFF se já passou da janela de partida
        IF v_pending_started_at IS NULL OR v_pending_started_at <= now() - interval '180 seconds' THEN
          v_should_force_off := true;
        END IF;
      END IF;
    END IF;

    IF v_received_bit IN ('0', '1') THEN
      IF v_pending_within_start_window THEN
        v_next_desired_running := true;
        v_clear_pending := false;
        v_fail_pending := false;
      ELSIF v_pending_is_manual AND v_pending_expected_bit = '1' AND v_received_bit = '0' THEN
        v_next_desired_running := false;
        v_clear_pending := true;
        v_fail_pending := COALESCE(v_pending_status, 'pending') <> 'executed';
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
       AND v_received_bit = '0'
       AND NOT v_pending_within_start_window THEN
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

    IF v_should_force_off THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.commands c
        WHERE c.farm_id = _farm_id
          AND c.equipment_id = v_eq.id
          AND c.source_device = 'backend-reset:local_shutdown_detected'
          AND c.status IN ('pending', 'sent')
          AND c.created_at > now() - interval '15 seconds'
      ) THEN
        PERFORM public.enqueue_reset_pump_command(_farm_id, v_eq.id, 'local_shutdown_detected');

        INSERT INTO public.agent_logs (farm_id, level, category, message)
        VALUES (
          _farm_id, 'warn', 'safety',
          format('Bomba %s (%s) desligou localmente enquanto deveria permanecer ligada — TX 0 enfileirado com prioridade maxima para travar rele.', v_eq.id, v_eq.name)
        );
      END IF;
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

-- Atualiza guard_unexpected_pump_shutdown: aumenta janela de "comando ligar
-- recente" de 60s para 180s, mesma lógica
CREATE OR REPLACE FUNCTION public.guard_unexpected_pump_shutdown()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_running boolean := false;
  v_new_running boolean := false;
  v_pending_frame text := NULL;
  v_pending_status public.command_status := NULL;
  v_pending_started_at timestamptz := NULL;
  v_pending_expected_bit text := NULL;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NEW.type NOT IN ('poco', 'bombeamento') THEN
    RETURN NEW;
  END IF;

  IF NEW.last_outputs_state ~ '^[01]{6}$' AND COALESCE(NEW.saida, 1) BETWEEN 1 AND 6 THEN
    v_new_running := substring(NEW.last_outputs_state from COALESCE(NEW.saida, 1)::int for 1) = '1';
  ELSIF NEW.last_outputs_state ~ '^[01]$' THEN
    v_new_running := NEW.last_outputs_state = '1';
  END IF;

  IF OLD.last_outputs_state ~ '^[01]{6}$' AND COALESCE(OLD.saida, 1) BETWEEN 1 AND 6 THEN
    v_old_running := substring(OLD.last_outputs_state from COALESCE(OLD.saida, 1)::int for 1) = '1';
  ELSIF OLD.last_outputs_state ~ '^[01]$' THEN
    v_old_running := OLD.last_outputs_state = '1';
  END IF;

  IF v_new_running THEN
    RETURN NEW;
  END IF;

  IF NOT COALESCE(NEW.desired_running, false) THEN
    RETURN NEW;
  END IF;

  IF NOT (v_old_running OR COALESCE(OLD.desired_running, false)) THEN
    RETURN NEW;
  END IF;

  IF NEW.pending_command_id IS NOT NULL THEN
    SELECT frame, status, COALESCE(sent_at, created_at)
      INTO v_pending_frame, v_pending_status, v_pending_started_at
    FROM public.commands
    WHERE id = NEW.pending_command_id
      AND farm_id = NEW.farm_id
      AND type = 'manual'
    LIMIT 1;

    IF v_pending_frame IS NOT NULL THEN
      IF v_pending_frame ~ '\{[01]\}' THEN
        v_pending_expected_bit := substring(v_pending_frame from '\{([01])\}');
      ELSIF v_pending_frame ~ '\{[01]{2,6}\}'
            AND length(substring(v_pending_frame from '\{([01]{2,6})\}')) >= COALESCE(NEW.saida, 1) THEN
        v_pending_expected_bit := substring(substring(v_pending_frame from '\{([01]{2,6})\}') from COALESCE(NEW.saida, 1)::int for 1);
      END IF;
    END IF;

    IF v_pending_expected_bit = '0' THEN
      RETURN NEW;
    END IF;

    -- AUMENTADO de 60s para 180s: bomba pode levar até 3 min para confirmar via telemetria
    IF v_pending_expected_bit = '1'
       AND v_pending_status IN ('pending', 'sent')
       AND v_pending_started_at > now() - interval '180 seconds' THEN
      RETURN NEW;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.commands c
    WHERE c.farm_id = NEW.farm_id
      AND c.equipment_id = NEW.id
      AND c.source_device = 'backend-reset:local_shutdown_detected'
      AND c.status IN ('pending', 'sent')
      AND c.created_at > now() - interval '15 seconds'
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM public.enqueue_reset_pump_command(NEW.farm_id, NEW.id, 'local_shutdown_detected');

  INSERT INTO public.agent_logs (farm_id, level, category, message)
  VALUES (
    NEW.farm_id,
    'warn',
    'safety',
    format('Protecao de banco: bomba %s (%s) caiu para desligada sem comando remoto compativel — TX 0 enfileirado automaticamente.', NEW.id, NEW.name)
  );

  RETURN NEW;
END;
$function$;

-- Também aumenta a janela do enqueue_turn_on_timeout_resets para alinhar
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
      c.id AS command_id,
      c.frame
    FROM public.equipments e
    JOIN public.commands c
      ON c.id = e.pending_command_id
     AND c.farm_id = e.farm_id
    WHERE e.type IN ('poco', 'bombeamento')
      AND c.type = 'manual'
      AND c.status IN ('pending', 'sent', 'executed')
      -- AUMENTADO de 60s para 180s
      AND COALESCE(c.sent_at, c.created_at) <= now() - interval '180 seconds'
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

    PERFORM public.enqueue_reset_pump_command(v_item.farm_id, v_item.equipment_id, 'turn_on_timeout');

    UPDATE public.commands
    SET status = 'timeout',
        responded_at = now(),
        error_message = 'Bomba nao ligou em 180s — comando TX 0 enfileirado por seguranca'
    WHERE id = v_item.command_id
      AND status IN ('pending', 'sent', 'executed');

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;