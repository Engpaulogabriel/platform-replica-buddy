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
  v_payload_bits text[];
  v_bit text;
  v_frame text;
  v_payload text;
  v_saida_idx int;
  i int;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

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
    ),
    plc_size AS (
      SELECT
        COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn,
        GREATEST(COALESCE(MAX(e.saida), 1), 1) AS max_saida
      FROM public.equipments e
      LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
      WHERE e.farm_id = _farm_id
        AND e.active = true
        AND e.type IN ('poco', 'bombeamento')
      GROUP BY 1
    )
    SELECT
      due.tsnn,
      array_agg(due.id) AS equipment_ids,
      (array_agg(due.id ORDER BY due.saida NULLS LAST))[1] AS rep_equipment_id,
      LEAST(GREATEST(ps.max_saida, 1), 6) AS payload_size
    FROM due
    JOIN plc_size ps ON ps.tsnn = due.tsnn
    GROUP BY due.tsnn, ps.max_saida
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.commands cp
      WHERE cp.farm_id = _farm_id
        AND cp.status = 'pending'
        AND cp.type = 'polling'
        AND cp.plc_hw_id = v_grp.tsnn
    ) THEN
      CONTINUE;
    END IF;

    v_payload_bits := ARRAY[]::text[];
    FOR i IN 1..v_grp.payload_size LOOP
      v_payload_bits := array_append(v_payload_bits, '0');
    END LOOP;

    FOR v_eq IN
      SELECT e.id,
             COALESCE(e.saida, 1) AS saida_idx,
             COALESCE(e.last_outputs_state, '') AS last_outputs_state
      FROM public.equipments e
      WHERE e.id = ANY(v_grp.equipment_ids)
    LOOP
      v_saida_idx := v_eq.saida_idx;
      IF v_saida_idx < 1 OR v_saida_idx > v_grp.payload_size THEN
        CONTINUE;
      END IF;

      v_bit := NULL;
      IF v_eq.last_outputs_state ~ '^[01]{1,6}$' THEN
        IF length(v_eq.last_outputs_state) >= v_saida_idx THEN
          v_bit := substring(v_eq.last_outputs_state from v_saida_idx for 1);
        ELSIF length(v_eq.last_outputs_state) = 1 THEN
          v_bit := substring(v_eq.last_outputs_state from 1 for 1);
        END IF;
      END IF;

      IF v_bit IN ('0', '1') THEN
        v_payload_bits[v_saida_idx] := v_bit;
      ELSE
        v_payload_bits[v_saida_idx] := '0';
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