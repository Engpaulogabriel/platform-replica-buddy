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

  -- Comandos que foram enviados mas a bomba não respondeu dentro do timeout.
  WITH updated AS (
    UPDATE public.commands
    SET status = 'timeout',
        responded_at = now(),
        error_message = 'Sem resposta dentro do timeout'
    WHERE farm_id = _farm_id
      AND status = 'sent'
      AND sent_at < now() - (timeout_ms || ' milliseconds')::interval
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM updated;

  -- POLLINGS PENDING VELHOS: se o agente não pegou em 30s, descarta para
  -- não travar a fila por TSNN (cada PLC só permite 1 polling pending; se
  -- nunca for enviado, nenhum polling novo entra e o equipamento parece
  -- "sumir" do dashboard). Comandos manuais NÃO são afetados.
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