
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
  v_i integer;
  v_max_saida integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  -- Nunca deixar polling vazio sair para a serial.
  UPDATE public.commands
  SET status = 'cancelled',
      responded_at = now(),
      error_message = 'Polling vazio cancelado: protocolo exige payload'
  WHERE farm_id = _farm_id
    AND status = 'pending'
    AND type = 'polling'
    AND frame ~ '\{\}';

  FOR v_grp IN
    WITH due AS (
      SELECT e.id,
             e.hw_id,
             e.saida,
             e.last_outputs_state,
             COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn
      FROM public.equipments e
      LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
      WHERE e.farm_id = _farm_id
        AND e.active = true
        AND e.type IN ('poco', 'bombeamento')
        AND e.pending_command_id IS NULL
        AND (
          e.last_polling_at IS NULL
          OR e.last_polling_at < now() - (e.polling_interval_seconds || ' seconds')::interval
        )
    ),
    -- Para cada TSNN, descobre a MAIOR saída cadastrada ativa (define tamanho do payload).
    -- Ex: PLC com saídas 1 e 3 → max=3 → payload {XXX} (3 dígitos).
    tsnn_size AS (
      SELECT
        COALESCE(NULLIF(pg2.hw_id, ''), substring(e2.hw_id from 1 for 4)) AS tsnn,
        GREATEST(MAX(COALESCE(e2.saida, 1)), 1) AS max_saida
      FROM public.equipments e2
      LEFT JOIN public.plc_groups pg2 ON pg2.id = e2.plc_group_id
      WHERE e2.farm_id = _farm_id
        AND e2.active = true
        AND e2.type IN ('poco', 'bombeamento')
      GROUP BY 1
    )
    SELECT
      due.tsnn,
      array_agg(due.id) AS equipment_ids,
      (array_agg(due.id))[1] AS rep_equipment_id,
      LEAST(GREATEST(COALESCE(ts.max_saida, 1), 1), 6) AS max_saida
    FROM due
    LEFT JOIN tsnn_size ts ON ts.tsnn = due.tsnn
    WHERE due.tsnn IS NOT NULL AND due.tsnn ~ '^\d{4}$'
    GROUP BY due.tsnn, ts.max_saida
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

    v_max_saida := COALESCE(v_grp.max_saida, 1);
    IF v_max_saida < 1 THEN v_max_saida := 1; END IF;
    IF v_max_saida > 6 THEN v_max_saida := 6; END IF;

    -- Monta payload com EXATAMENTE v_max_saida dígitos, espelhando estado conhecido por saída.
    v_payload := repeat('0', v_max_saida);

    FOR v_i IN 1..v_max_saida LOOP
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

-- Cancela polling antigo no formato anterior, força regeneração imediata
UPDATE public.commands
SET status = 'cancelled',
    responded_at = now(),
    error_message = 'Cancelado: regerar com payload de tamanho dinâmico (N saídas = N dígitos)'
WHERE status IN ('pending', 'sent')
  AND type = 'polling';

UPDATE public.equipments
SET last_polling_at = NULL
WHERE active = true
  AND type IN ('poco', 'bombeamento');
