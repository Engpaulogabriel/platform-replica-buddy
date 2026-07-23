CREATE OR REPLACE FUNCTION public.cancel_pending_pollings_for_plc(
  _farm_id uuid,
  _tsnn text,
  _reason text DEFAULT 'Polling cancelado: safety expirou e desired_running foi zerado'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
BEGIN
  IF _farm_id IS NULL OR _tsnn IS NULL OR _tsnn !~ '^\d{4}$' THEN
    RETURN 0;
  END IF;

  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  WITH cancelled AS (
    UPDATE public.commands c
    SET status = 'cancelled',
        responded_at = now(),
        error_message = COALESCE(NULLIF(_reason, ''), 'Polling cancelado: safety expirou e desired_running foi zerado')
    WHERE c.farm_id = _farm_id
      AND c.type = 'polling'
      AND c.status = 'pending'
      AND (
        c.plc_hw_id = _tsnn
        OR c.frame LIKE ('[' || _tsnn || '_1_]%')
        OR c.equipment_id IN (
          SELECT e.id
          FROM public.equipments e
          LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
          WHERE e.farm_id = _farm_id
            AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = _tsnn
        )
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM cancelled;

  RETURN COALESCE(v_count, 0);
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
      COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn,
      c.id AS command_id,
      c.frame
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
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

    PERFORM public.cancel_pending_pollings_for_plc(
      v_item.farm_id,
      v_item.tsnn,
      'Polling cancelado: safety SQL expirou e desired_running=false'
    );

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
    RETURNING e.farm_id, COALESCE((SELECT NULLIF(pg.hw_id, '') FROM public.plc_groups pg WHERE pg.id = e.plc_group_id), substring(e.hw_id from 1 for 4)) AS tsnn
  ), cancel_polling AS (
    SELECT public.cancel_pending_pollings_for_plc(
      ce.farm_id,
      ce.tsnn,
      'Polling cancelado: safety reset expirou e desired_running=false'
    ) AS cancelled_count
    FROM clear_equipment ce
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