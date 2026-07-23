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
  v_last_manual_payload text;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  FOR v_eq IN
    SELECT e.id, e.hw_id, e.type, e.saida, e.last_outputs_state,
           e.polling_interval_seconds, e.last_polling_at,
           e.pending_command_id,
           pg.hw_id AS plc_hw_id
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
      AND NOT EXISTS (
        SELECT 1 FROM public.commands c
        WHERE c.equipment_id = e.id
          AND c.status = 'pending'
          AND c.type = 'polling'
      )
  LOOP
    v_tsnn := COALESCE(NULLIF(v_eq.plc_hw_id, ''), substring(v_eq.hw_id from 1 for 4));
    v_saida_idx := COALESCE(v_eq.saida, 1);

    -- PRIORIDADE 1: Pega o payload do ULTIMO COMANDO MANUAL desta bomba
    -- (intencao do usuario), independente do que a placa leu por ultimo.
    -- Isso garante que se o usuario mandou ligar, todo polling subsequente
    -- envia "1" ate que ele mande desligar.
    SELECT CASE
             WHEN c.frame ~ '\{[01]{6}\}' THEN substring(substring(c.frame from '\{([01]{6})\}') from v_saida_idx for 1)
             WHEN c.frame ~ '\{[01]\}' THEN substring(c.frame from '\{([01])\}')
             ELSE NULL
           END
      INTO v_last_manual_payload
    FROM public.commands c
    WHERE c.equipment_id = v_eq.id
      AND c.type = 'manual'
      AND c.status IN ('sent', 'executed', 'delivered')
    ORDER BY COALESCE(c.responded_at, c.sent_at, c.created_at) DESC
    LIMIT 1;

    IF v_last_manual_payload IN ('0', '1') THEN
      v_payload := v_last_manual_payload;
    ELSIF v_eq.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
      v_payload := substring(v_eq.last_outputs_state from v_saida_idx for 1);
    ELSIF v_eq.last_outputs_state ~ '^[01]$' THEN
      v_payload := v_eq.last_outputs_state;
    ELSE
      v_payload := '0';
    END IF;

    v_frame := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';

    INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
    VALUES (_farm_id, v_eq.id, v_tsnn, 'polling', 5, v_frame, 8000, 'platform-scheduler');

    UPDATE public.equipments SET last_polling_at = now() WHERE id = v_eq.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;