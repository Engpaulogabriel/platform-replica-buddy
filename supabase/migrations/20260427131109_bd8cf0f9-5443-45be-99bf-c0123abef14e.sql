CREATE OR REPLACE FUNCTION public.enqueue_polling_for_due_equipments(_farm_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
  v_grp RECORD;
  v_frame text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  -- Polling deve ser somente leitura. Qualquer comando pendente antigo de polling
  -- com payload {0}/{1}/{XXXXXX} pode acionar/desligar relé no firmware e por isso
  -- é cancelado antes de criar novas leituras.
  UPDATE public.commands
  SET status = 'cancelled',
      responded_at = now(),
      error_message = 'Polling antigo cancelado: payload de acionamento removido para evitar TX 0/TX 1 oculto'
  WHERE farm_id = _farm_id
    AND status = 'pending'
    AND type = 'polling'
    AND source_device = 'platform-scheduler'
    AND frame ~ '\{[01]{1,6}\}';

  FOR v_grp IN
    WITH due AS (
      SELECT e.id,
             COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn
      FROM public.equipments e
      LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
      WHERE e.farm_id = _farm_id
        AND e.active = true
        AND e.type IN ('poco', 'bombeamento')
        AND (
          e.last_polling_at IS NULL
          OR e.last_polling_at < now() - (e.polling_interval_seconds || ' seconds')::interval
        )
    )
    SELECT
      due.tsnn,
      array_agg(due.id) AS equipment_ids,
      (array_agg(due.id))[1] AS rep_equipment_id
    FROM due
    GROUP BY due.tsnn
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.commands cp
      WHERE cp.farm_id = _farm_id
        AND cp.status = 'pending'
        AND cp.type = 'polling'
        AND cp.plc_hw_id = v_grp.tsnn
    ) THEN
      CONTINUE;
    END IF;

    -- Payload vazio = consulta/leitura. Não altera saída física.
    v_frame := '[' || v_grp.tsnn || '_1_]{}[' || v_grp.tsnn || '_ETX_]' || E'\r';

    INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
    VALUES (_farm_id, v_grp.rep_equipment_id, v_grp.tsnn, 'polling', 5, v_frame, 8000, 'platform-scheduler');

    UPDATE public.equipments
    SET last_polling_at = now()
    WHERE id = ANY(v_grp.equipment_ids);

    v_count := v_count + 1;
  END LOOP;

  IF v_count > 0 THEN
    INSERT INTO public.agent_logs (farm_id, level, category, message)
    VALUES (
      _farm_id,
      'info',
      'polling',
      format('Polling seguro enfileirado: %s consulta(s) com payload vazio, sem comando de ligar/desligar.', v_count)
    );
  END IF;

  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_polling_for_due_equipments(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_polling_for_due_equipments(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.enqueue_polling_for_due_equipments(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_polling_for_due_equipments(uuid) TO service_role;