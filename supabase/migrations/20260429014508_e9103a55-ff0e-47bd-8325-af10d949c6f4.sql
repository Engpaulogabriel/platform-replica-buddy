CREATE OR REPLACE FUNCTION public.enqueue_polling_for_due_equipments(_farm_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
  v_grp record;
  v_frame text;
  v_payload text;
  v_bit text;
  v_intent_bit text;
  v_i integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  UPDATE public.commands
  SET status = 'cancelled',
      responded_at = now(),
      error_message = 'Polling vazio cancelado: protocolo exige payload de 6 saidas'
  WHERE farm_id = _farm_id
    AND status = 'pending'
    AND type = 'polling'
    AND frame ~ '\{\}';

  FOR v_grp IN
    WITH plc_groups_due AS (
      SELECT
        COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn,
        MIN(e.id) AS rep_equipment_id,
        array_agg(e.id ORDER BY COALESCE(e.saida, 1), e.id) AS equipment_ids,
        MIN(COALESCE(e.last_polling_at, 'epoch'::timestamptz)) AS oldest_polling
      FROM public.equipments e
      LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
      WHERE e.farm_id = _farm_id
        AND e.active = true
        AND e.type IN ('poco', 'bombeamento')
      GROUP BY 1
      HAVING COALESCE(NULLIF(pg.hw_id, ''), substring(MIN(e.hw_id) from 1 for 4)) IS NOT NULL
    ),
    eligible AS (
      SELECT g.*
      FROM plc_groups_due g
      WHERE g.tsnn ~ '^\d{4}$'
        AND (
          g.oldest_polling = 'epoch'::timestamptz
          OR g.oldest_polling <= now() - interval '8 seconds'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.commands cp
          WHERE cp.farm_id = _farm_id
            AND cp.type = 'polling'
            AND cp.plc_hw_id = g.tsnn
            AND cp.status IN ('pending', 'sent')
        )
    )
    SELECT *
    FROM eligible
    ORDER BY oldest_polling ASC, tsnn ASC
    LIMIT 1
  LOOP
    v_payload := '000000';

    FOR v_i IN 1..6 LOOP
      SELECT
        CASE
          WHEN e.last_outputs_state ~ '^[01]{6}$' AND COALESCE(e.saida, 1) BETWEEN 1 AND 6
            THEN substring(e.last_outputs_state from COALESCE(e.saida, 1)::int for 1)
          WHEN e.last_outputs_state ~ '^[01]$'
            THEN e.last_outputs_state
          ELSE NULL
        END
      INTO v_bit
      FROM public.equipments e
      LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
      WHERE e.farm_id = _farm_id
        AND e.active = true
        AND e.type IN ('poco', 'bombeamento')
        AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_grp.tsnn
        AND COALESCE(e.saida, 1) = v_i
      ORDER BY e.updated_at DESC NULLS LAST
      LIMIT 1;

      SELECT
        CASE
          WHEN c.frame ~ '\{[01]\}' THEN substring(c.frame from '\{([01])\}')
          WHEN c.frame ~ '\{[01]{2,6}\}' AND length(substring(c.frame from '\{([01]{2,6})\}')) >= v_i
            THEN substring(substring(c.frame from '\{([01]{2,6})\}') from v_i for 1)
          ELSE NULL
        END
      INTO v_intent_bit
      FROM public.commands c
      JOIN public.equipments e2 ON e2.id = c.equipment_id
      WHERE c.farm_id = _farm_id
        AND c.type = 'manual'
        AND c.plc_hw_id = v_grp.tsnn
        AND COALESCE(e2.saida, 1) = v_i
        AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
        AND COALESCE(c.sent_at, c.created_at) > now() - interval '120 seconds'
      ORDER BY COALESCE(c.sent_at, c.created_at) DESC
      LIMIT 1;

      IF v_intent_bit IN ('0', '1') THEN
        v_bit := v_intent_bit;
      END IF;

      IF v_bit IN ('0', '1') THEN
        v_payload := overlay(v_payload placing v_bit from v_i for 1);
      END IF;
    END LOOP;

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