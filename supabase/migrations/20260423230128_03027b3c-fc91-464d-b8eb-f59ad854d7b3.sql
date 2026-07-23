CREATE OR REPLACE FUNCTION public.enqueue_polling_for_due_equipments(_farm_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
  v_grp RECORD;
  v_payload text;
  v_frame text;
  v_last_manual_payload text;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  -- Agrupa por PLC: 1 polling por PLC (que responde as 6 saidas num so frame).
  -- Bombas sem PLC agrupada usam o proprio hw_id (4 primeiros chars) como TSNN.
  FOR v_grp IN
    WITH due AS (
      SELECT e.id, e.hw_id, e.saida, e.plc_group_id, e.last_polling_at,
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
      tsnn,
      array_agg(id) AS equipment_ids,
      -- Pega 1 equipamento "representante" para o equipment_id do comando
      (array_agg(id ORDER BY saida NULLS LAST))[1] AS rep_equipment_id
    FROM due
    GROUP BY tsnn
  LOOP
    -- Nao enfileira se ja existe polling pending para esse PLC
    IF EXISTS (
      SELECT 1 FROM public.commands cp
      WHERE cp.farm_id = _farm_id
        AND cp.status = 'pending'
        AND cp.type = 'polling'
        AND cp.plc_hw_id = v_grp.tsnn
    ) THEN
      CONTINUE;
    END IF;

    -- Pega o ultimo comando manual entre TODOS os equipamentos dessa PLC.
    -- Polling repete a intencao mais recente (1=ligar, 0=desligar).
    SELECT CASE
             WHEN c.frame ~ '\{[01]{6}\}' THEN
               -- Para frames de 6 saidas, usa a saida do equipamento alvo
               substring(
                 substring(c.frame from '\{([01]{6})\}')
                 from COALESCE(e2.saida, 1)::int for 1
               )
             WHEN c.frame ~ '\{[01]\}' THEN substring(c.frame from '\{([01])\}')
             ELSE NULL
           END
      INTO v_last_manual_payload
    FROM public.commands c
    JOIN public.equipments e2 ON e2.id = c.equipment_id
    WHERE c.farm_id = _farm_id
      AND c.type = 'manual'
      AND c.equipment_id = ANY(v_grp.equipment_ids)
    ORDER BY c.created_at DESC
    LIMIT 1;

    IF v_last_manual_payload IN ('0', '1') THEN
      v_payload := v_last_manual_payload;
    ELSE
      v_payload := '0';
    END IF;

    v_frame := '[' || v_grp.tsnn || '_1_]{' || v_payload || '}[' || v_grp.tsnn || '_ETX_]' || E'\r';

    INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
    VALUES (_farm_id, v_grp.rep_equipment_id, v_grp.tsnn, 'polling', 5, v_frame, 8000, 'platform-scheduler');

    -- Marca todos os equipamentos dessa PLC como pollados agora
    UPDATE public.equipments
    SET last_polling_at = now()
    WHERE id = ANY(v_grp.equipment_ids);

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;