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
  v_clear RECORD;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissão para fazenda %', _farm_id;
  END IF;

  v_reset_count := public.enqueue_turn_on_timeout_resets(_farm_id);

  FOR v_clear IN
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
    )
    SELECT farm_id, tsnn FROM clear_equipment
  LOOP
    PERFORM public.cancel_pending_pollings_for_plc(
      v_clear.farm_id,
      v_clear.tsnn,
      'Polling cancelado: safety reset expirou e desired_running=false'
    );
    v_expired_reset_count := v_expired_reset_count + 1;
  END LOOP;

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