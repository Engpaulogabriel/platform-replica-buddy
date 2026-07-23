-- Ajusta ciclo de polling de 8s -> 13s
CREATE OR REPLACE FUNCTION public.enqueue_polling_for_due_equipments_internal(_farm_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_grp RECORD;
  v_payload text;
  v_frame text;
  v_i integer;
  v_bit text;
  v_intent_bit text;
BEGIN
  DELETE FROM public.commands
  WHERE farm_id = _farm_id
    AND status = 'pending'
    AND type = 'polling'
    AND created_at < now() - interval '30 seconds';

  UPDATE public.commands
  SET status = 'timeout',
      responded_at = now(),
      error_message = 'Sem resposta dentro do timeout'
  WHERE farm_id = _farm_id
    AND status = 'sent'
    AND type = 'polling'
    AND sent_at < now() - (GREATEST(timeout_ms, 13000) || ' milliseconds')::interval;

  IF EXISTS (
    SELECT 1
    FROM public.commands c
    WHERE c.farm_id = _farm_id
      AND c.type = 'polling'
      AND c.source_device = 'platform-scheduler'
      AND c.created_at > now() - interval '12.5 seconds'
  ) THEN
    RETURN 0;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.commands c
    WHERE c.farm_id = _farm_id
      AND c.status IN ('pending', 'sent')
      AND c.type = 'polling'
  ) THEN
    RETURN 0;
  END IF;

  WITH equipment_plcs AS (
    SELECT
      e.id,
      e.updated_at,
      COALESCE(e.saida, 1) AS saida,
      COALESCE(e.last_polling_at, 'epoch'::timestamptz) AS last_polling_at,
      COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id
      AND e.active = true
      AND e.type IN ('poco', 'bombeamento')
  ),
  plc_groups_due AS (
    SELECT
      tsnn,
      (array_agg(id ORDER BY saida, id))[1] AS rep_equipment_id,
      array_agg(id ORDER BY saida, id) AS equipment_ids,
      MIN(last_polling_at) AS oldest_polling
    FROM equipment_plcs
    WHERE tsnn IS NOT NULL
      AND tsnn ~ '^\d{4}$'
    GROUP BY tsnn
  )
  SELECT *
    INTO v_grp
  FROM plc_groups_due
  ORDER BY oldest_polling ASC, tsnn ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

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
  VALUES (_farm_id, v_grp.rep_equipment_id, v_grp.tsnn, 'polling', 5, v_frame, 13000, 'platform-scheduler');

  UPDATE public.equipments
  SET last_polling_at = now()
  WHERE id = ANY(v_grp.equipment_ids);

  RETURN 1;
END;
$function$;