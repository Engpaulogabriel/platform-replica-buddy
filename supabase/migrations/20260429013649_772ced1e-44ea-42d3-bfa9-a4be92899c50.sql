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
      AND c.status IN ('pending', 'sent', 'executed', 'timeout')
      AND COALESCE(c.sent_at, c.created_at) <= now() - interval '120 seconds'
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
        error_message = 'Bomba nao ligou em 120s — comando TX 0 enfileirado por seguranca e alerta local ativado'
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
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissão para fazenda %', _farm_id;
  END IF;

  v_reset_count := public.enqueue_turn_on_timeout_resets(_farm_id);

  -- Timeout curto é falha de comunicação da tentativa TX, não falha física da bomba.
  -- Comando manual só vira falha definitiva pela janela de 120s acima.
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

  RETURN COALESCE(v_count, 0) + COALESCE(v_reset_count, 0) + COALESCE(v_stale_pending, 0);
END;
$function$;