CREATE OR REPLACE FUNCTION public.enqueue_polling_for_due_equipments(_farm_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
  v_eq RECORD;
  v_tsnn text;
  v_payload text;
  v_frame text;
  v_saida_idx int;
  v_pending_cmd_payload text;
  v_recent_manual_payload text;
  v_current_output_payload text;
  v_currently_running boolean := false;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  FOR v_eq IN
    SELECT e.id,
           e.hw_id,
           e.type,
           e.saida,
           e.last_outputs_state,
           e.polling_interval_seconds,
           e.last_polling_at,
           e.pending_command_id,
           pg.hw_id AS plc_hw_id,
           c.type AS pending_command_type,
           c.status AS pending_command_status,
           c.frame AS pending_command_frame,
           c.created_at AS pending_command_created_at
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    LEFT JOIN public.commands c ON c.id = e.pending_command_id AND c.farm_id = e.farm_id
    WHERE e.farm_id = _farm_id
      AND e.active = true
      AND e.type IN ('poco', 'bombeamento')
      AND (
        e.last_polling_at IS NULL
        OR e.last_polling_at < now() - (e.polling_interval_seconds || ' seconds')::interval
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.commands cp
        WHERE cp.equipment_id = e.id
          AND cp.status = 'pending'
          AND cp.type = 'polling'
      )
  LOOP
    v_tsnn := COALESCE(NULLIF(v_eq.plc_hw_id, ''), substring(v_eq.hw_id from 1 for 4));
    v_saida_idx := COALESCE(v_eq.saida, 1);
    v_pending_cmd_payload := NULL;
    v_recent_manual_payload := NULL;

    IF v_eq.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
      v_current_output_payload := substring(v_eq.last_outputs_state from v_saida_idx for 1);
      v_currently_running := v_current_output_payload = '1';
    ELSIF v_eq.last_outputs_state ~ '^[01]$' THEN
      v_current_output_payload := v_eq.last_outputs_state;
      v_currently_running := v_current_output_payload = '1';
    ELSE
      v_current_output_payload := '0';
      v_currently_running := false;
    END IF;

    IF v_eq.pending_command_id IS NOT NULL
       AND v_eq.pending_command_type = 'manual'
       AND v_eq.pending_command_status NOT IN ('cancelled', 'error', 'timeout')
    THEN
      v_pending_cmd_payload := CASE
        WHEN v_eq.pending_command_frame ~ '\{[01]{6}\}' THEN substring(substring(v_eq.pending_command_frame from '\{([01]{6})\}') from v_saida_idx for 1)
        WHEN v_eq.pending_command_frame ~ '\{[01]\}' THEN substring(v_eq.pending_command_frame from '\{([01])\}')
        ELSE NULL
      END;

      IF v_pending_cmd_payload = '1'
         AND NOT v_currently_running
         AND v_eq.pending_command_created_at IS NOT NULL
         AND v_eq.pending_command_created_at < now() - interval '60 seconds'
      THEN
        UPDATE public.commands
        SET status = 'timeout',
            responded_at = now(),
            error_message = 'Bomba nao ligou em ate 60s — comando revertido automaticamente para desligado'
        WHERE id = v_eq.pending_command_id
          AND farm_id = _farm_id
          AND type = 'manual'
          AND status NOT IN ('cancelled', 'error', 'timeout');

        UPDATE public.equipments
        SET pending_command_id = NULL,
            updated_at = now()
        WHERE id = v_eq.id
          AND farm_id = _farm_id;

        v_pending_cmd_payload := NULL;
      END IF;
    END IF;

    IF v_pending_cmd_payload IS NULL THEN
      SELECT CASE
               WHEN c2.frame ~ '\{[01]{6}\}' THEN substring(substring(c2.frame from '\{([01]{6})\}') from v_saida_idx for 1)
               WHEN c2.frame ~ '\{[01]\}' THEN substring(c2.frame from '\{([01])\}')
               ELSE NULL
             END
      INTO v_recent_manual_payload
      FROM public.commands c2
      WHERE c2.equipment_id = v_eq.id
        AND c2.farm_id = _farm_id
        AND c2.type = 'manual'
        AND c2.status NOT IN ('cancelled', 'error', 'timeout')
        AND c2.created_at >= now() - interval '60 seconds'
      ORDER BY c2.created_at DESC
      LIMIT 1;
    END IF;

    IF v_pending_cmd_payload IN ('0', '1') THEN
      v_payload := v_pending_cmd_payload;
    ELSIF v_recent_manual_payload IN ('0', '1') AND v_recent_manual_payload <> v_current_output_payload THEN
      v_payload := v_recent_manual_payload;
    ELSE
      v_payload := v_current_output_payload;
    END IF;

    v_frame := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';

    INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
    VALUES (_farm_id, v_eq.id, v_tsnn, 'polling', 5, v_frame, 8000, 'platform-scheduler');

    UPDATE public.equipments
    SET last_polling_at = now()
    WHERE id = v_eq.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;