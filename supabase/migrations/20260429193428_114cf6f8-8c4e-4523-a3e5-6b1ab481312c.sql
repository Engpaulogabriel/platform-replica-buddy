-- ============================================================================
-- Aumentar janela de tolerancia para evitar TX 0 automatico falso-positivo
-- ============================================================================
-- Problema: Pocos 02/05/07/17 estavam sendo desligados pelo backend-reset
-- (source_device='local_shutdown_detected' / 'turn_on_timeout') porque as
-- janelas de protecao eram curtas demais para o tempo real de partida
-- da bomba e propagacao RF/polling.
--
-- Mudancas:
-- 1) enqueue_reset_pump_command: olha 180s atras (era 60s) procurando comando
--    remoto recente de LIGAR para BLOQUEAR o reset automatico.
-- 2) guard_unexpected_pump_shutdown:
--    - olha 180s atras (era 60s) buscando comando remoto recente
--    - estende janela do pending_command_id para 300s (era 180s)
--    - exige DUAS leituras consecutivas de '0' (last + previous polling)
--      antes de disparar local_shutdown_detected. Uma unica leitura '0'
--      isolada nao basta.
-- ============================================================================

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

  -- *** AUMENTADO: 60s -> 180s ***
  -- Bombas demoram para ligar fisicamente; uma janela curta gerava TX 0 falso.
  IF v_is_protective_auto THEN
    SELECT c.id, c.status, substring(c.frame from '\{([01]{1,6})\}')
      INTO v_recent_command_id, v_recent_command_status, v_recent_payload
    FROM public.commands c
    WHERE c.farm_id = _farm_id
      AND c.equipment_id = _equipment_id
      AND c.type = 'manual'
      AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
      AND COALESCE(c.sent_at, c.created_at) > now() - interval '180 seconds'
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
          'Reset automatico (%s) BLOQUEADO: existe comando remoto de LIGAR enviado ha menos de 180s para a bomba %s. Aguardando confirmacao espontanea sem interferir.',
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

  UPDATE public.commands
  SET status = 'error',
      responded_at = COALESCE(responded_at, now()),
      error_message = COALESCE(error_message, 'TX 0 de seguranca sem confirmacao apos 120s')
  WHERE farm_id = _farm_id
    AND equipment_id = _equipment_id
    AND type = 'manual'
    AND priority = 0
    AND status IN ('pending', 'sent')
    AND COALESCE(source_device, '') LIKE 'backend-reset:%'
    AND COALESCE(sent_at, created_at) <= now() - interval '120 seconds';

  SELECT c.id
    INTO v_existing_reset_id
  FROM public.commands c
  WHERE c.farm_id = _farm_id
    AND c.equipment_id = _equipment_id
    AND c.type = 'manual'
    AND c.priority = 0
    AND c.status IN ('pending', 'sent')
    AND COALESCE(c.source_device, '') LIKE 'backend-reset:%'
    AND COALESCE(c.sent_at, c.created_at) > now() - interval '120 seconds'
  ORDER BY COALESCE(c.sent_at, c.created_at) DESC
  LIMIT 1;

  IF v_existing_reset_id IS NOT NULL THEN
    RETURN v_existing_reset_id;
  END IF;

  SELECT COALESCE(rr.radio, 'R1'), COALESCE(rr.via_repetidor, false)
    INTO v_radio, v_via_rep
  FROM public.rf_routing rr
  WHERE rr.farm_id = _farm_id
  LIMIT 1;

  v_lora := format('[%s_1_]{0}[%s_ETX_]', v_tsnn, v_tsnn);
  IF v_via_rep THEN
    v_frame := format('REP:%s:TX:Rx:%s', v_radio, v_lora);
  ELSE
    v_frame := format('%s:%s', v_radio, v_lora);
    -- direct mode: keep existing protocol shape; reuse loRa frame
    v_frame := v_lora;
  END IF;

  INSERT INTO public.commands (
    farm_id, equipment_id, plc_hw_id, type, priority, frame,
    timeout_ms, source_device, created_by
  ) VALUES (
    _farm_id, _equipment_id, v_tsnn, 'manual', 0, v_lora,
    v_timeout_ms, format('backend-reset:%s', v_reason),
    CASE WHEN COALESCE(auth.role(), '') = 'service_role' THEN NULL ELSE auth.uid() END
  )
  RETURNING id INTO v_command_id;

  UPDATE public.equipments
  SET pending_command_id = v_command_id,
      desired_running = false,
      command_blocked_until = NULL,
      updated_at = now()
  WHERE id = _equipment_id
    AND farm_id = _farm_id;

  RETURN v_command_id;
END;
$function$;

-- ============================================================================
-- guard_unexpected_pump_shutdown: exige 2 leituras consecutivas '0' e amplia
-- janelas de protecao (60s->180s para comando manual recente; 180s->300s para
-- pending_command_id).
-- ============================================================================
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

  -- *** REGRA NOVA: exige que o estado anterior TAMBEM ja fosse '0' (desligado)
  -- visto pelo polling. Se OLD.last_outputs_state mostrava a saida ligada
  -- (v_old_running=true), essa eh a PRIMEIRA leitura '0' apos um estado ligado:
  -- pode ser ruido ou inicio de partida que falhou. NAO disparar TX 0 ainda.
  -- Esperamos a proxima leitura confirmar (ai OLD ja sera '0' e pulamos
  -- direto para o early-return abaixo, indicando shutdown sustentado).
  -- Entao: so disparamos TX 0 quando OLD desligada AND desired_running TRUE,
  -- ou seja, ja ficou um ciclo inteiro desligada apesar da web querer ligada.
  IF v_old_running THEN
    -- primeira leitura '0' apos estado ligado — apenas registra, sem TX 0
    INSERT INTO public.agent_logs (farm_id, level, category, message)
    VALUES (
      NEW.farm_id,
      'info',
      'safety',
      format('Bomba %s reportou primeira leitura desligada (saida=%s). Aguardando confirmacao no proximo polling antes de qualquer acao.', NEW.id, NEW.saida)
    );
    RETURN NEW;
  END IF;

  -- *** AUMENTADO: 60s -> 180s ***
  SELECT c.frame, c.status, COALESCE(c.sent_at, c.created_at)
    INTO v_pending_frame, v_pending_status, v_pending_started_at
  FROM public.commands c
  WHERE c.farm_id = NEW.farm_id
    AND c.equipment_id = NEW.id
    AND c.type = 'manual'
    AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
    AND COALESCE(c.sent_at, c.created_at) > now() - interval '180 seconds'
  ORDER BY COALESCE(c.sent_at, c.created_at) DESC
  LIMIT 1;

  IF v_pending_frame IS NOT NULL THEN
    IF v_pending_frame ~ '\{[01]\}' THEN
      v_pending_expected_bit := substring(v_pending_frame from '\{([01])\}');
    ELSIF v_pending_frame ~ '\{[01]{2,6}\}'
          AND length(substring(v_pending_frame from '\{([01]{2,6})\}')) >= COALESCE(NEW.saida, 1) THEN
      v_pending_expected_bit := substring(substring(v_pending_frame from '\{([01]{2,6})\}') from COALESCE(NEW.saida, 1)::int for 1);
    END IF;

    IF v_pending_expected_bit = '1' THEN
      RETURN NEW;
    END IF;
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

    -- *** AUMENTADO: 180s -> 300s ***
    IF v_pending_expected_bit = '1'
       AND v_pending_status IN ('pending', 'sent', 'executed')
       AND v_pending_started_at > now() - interval '300 seconds' THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NOT (v_old_running OR COALESCE(OLD.desired_running, false)) THEN
    RETURN NEW;
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