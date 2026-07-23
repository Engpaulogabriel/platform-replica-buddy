CREATE OR REPLACE FUNCTION public.enqueue_polling_for_due_equipments(_farm_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
  v_grp RECORD;
  v_eq RECORD;
  v_payload_bits text[] := ARRAY['0','0','0','0','0','0'];
  v_bit text;
  v_frame text;
  v_payload text;
  v_saida_idx int;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  -- Agrupa por PLC: 1 polling por PLC, payload de 6 saidas refletindo a
  -- intencao atual de CADA saida (ultimo comando manual daquele equipamento).
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
      (array_agg(id ORDER BY saida NULLS LAST))[1] AS rep_equipment_id
    FROM due
    GROUP BY tsnn
  LOOP
    -- Pula se ja existe polling pending para esse PLC
    IF EXISTS (
      SELECT 1 FROM public.commands cp
      WHERE cp.farm_id = _farm_id
        AND cp.status = 'pending'
        AND cp.type = 'polling'
        AND cp.plc_hw_id = v_grp.tsnn
    ) THEN
      CONTINUE;
    END IF;

    -- Reseta payload bits para esta PLC
    v_payload_bits := ARRAY['0','0','0','0','0','0'];

    -- Pega a intencao atual (ultimo manual) de cada equipamento desta PLC
    -- e monta o payload de 6 saidas.
    FOR v_eq IN
      SELECT e.id, COALESCE(e.saida, 1) AS saida_idx
      FROM public.equipments e
      WHERE e.id = ANY(v_grp.equipment_ids)
    LOOP
      v_saida_idx := v_eq.saida_idx;
      IF v_saida_idx < 1 OR v_saida_idx > 6 THEN
        CONTINUE;
      END IF;

      SELECT CASE
               WHEN c.frame ~ '\{[01]{6}\}' THEN
                 substring(substring(c.frame from '\{([01]{6})\}') from v_saida_idx for 1)
               WHEN c.frame ~ '\{[01]\}' THEN substring(c.frame from '\{([01])\}')
               ELSE NULL
             END
        INTO v_bit
      FROM public.commands c
      WHERE c.farm_id = _farm_id
        AND c.type = 'manual'
        AND c.equipment_id = v_eq.id
      ORDER BY c.created_at DESC
      LIMIT 1;

      IF v_bit IN ('0','1') THEN
        v_payload_bits[v_saida_idx] := v_bit;
      END IF;
    END LOOP;

    v_payload := array_to_string(v_payload_bits, '');
    v_frame := '[' || v_grp.tsnn || '_1_]{' || v_payload || '}[' || v_grp.tsnn || '_ETX_]' || E'\r';

    INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
    VALUES (_farm_id, v_grp.rep_equipment_id, v_grp.tsnn, 'polling', 5, v_frame, 8000, 'platform-scheduler');

    UPDATE public.equipments
    SET last_polling_at = now()
    WHERE id = ANY(v_grp.equipment_ids);

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;