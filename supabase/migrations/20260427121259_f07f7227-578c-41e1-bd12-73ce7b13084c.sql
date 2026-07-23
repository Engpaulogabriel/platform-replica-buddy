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
  v_frame text;
  v_payload text;
  v_saida_idx int;
  v_active_expected_bit text;
  v_desired_bit text;
  v_pending_payload text;
  i int;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.can_write_farm(auth.uid(), _farm_id) THEN
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
             e.last_outputs_state,
             e.desired_running,
             e.pending_command_id,
             COALESCE(c.type, latest_manual.type) AS pending_type,
             COALESCE(c.status, latest_manual.status) AS pending_status,
             COALESCE(c.frame, latest_manual.frame) AS pending_frame
      FROM public.equipments e
      LEFT JOIN public.commands c
        ON c.id = e.pending_command_id
       AND c.farm_id = e.farm_id
      LEFT JOIN LATERAL (
        SELECT cm.type, cm.status, cm.frame
        FROM public.commands cm
        WHERE cm.farm_id = e.farm_id
          AND cm.equipment_id = e.id
          AND cm.type = 'manual'
          AND cm.status IN ('pending', 'sent')
        ORDER BY cm.created_at DESC
        LIMIT 1
      ) latest_manual ON true
      WHERE e.id = ANY(v_grp.equipment_ids)
    LOOP
      v_saida_idx := v_eq.saida_idx;
      IF v_saida_idx < 1 OR v_saida_idx > v_grp.payload_size THEN
        CONTINUE;
      END IF;

      v_active_expected_bit := NULL;
      v_desired_bit := NULL;
      v_pending_payload := NULL;

      -- Prioridade 1: comando manual pendente/enviado.
      -- Usa também o comando manual mais recente da fila para fechar a janela de corrida
      -- entre inserir o comando manual e gravar pending_command_id no equipamento.
      IF v_eq.pending_type = 'manual'
         AND v_eq.pending_status IN ('pending', 'sent')
         AND v_eq.pending_frame IS NOT NULL THEN
        v_pending_payload := substring(v_eq.pending_frame from '\{([01]{1,6})\}');

        IF v_pending_payload ~ '^[01]$' THEN
          v_active_expected_bit := v_pending_payload;
        ELSIF v_pending_payload ~ '^[01]{2,6}$'
              AND length(v_pending_payload) >= v_saida_idx THEN
          v_active_expected_bit := substring(v_pending_payload from v_saida_idx for 1);
        END IF;
      END IF;

      -- Prioridade 2: vontade do usuário (desired_running) — NÃO o estado físico.
      -- Isso garante que se a bomba foi ligada local mas o usuário quer ela desligada,
      -- o polling envia {0} e força o firmware a desligar.
      v_desired_bit := CASE WHEN COALESCE(v_eq.desired_running, false) THEN '1' ELSE '0' END;

      v_payload_bits[v_saida_idx] := COALESCE(v_active_expected_bit, v_desired_bit, '0');
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