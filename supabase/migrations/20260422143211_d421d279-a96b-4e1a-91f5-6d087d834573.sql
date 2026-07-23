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
  v_bit char(1);
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  FOR v_eq IN
    SELECT e.id, e.hw_id, e.type, e.saida, e.last_outputs_state, e.polling_interval_seconds, e.last_polling_at, pg.hw_id AS plc_hw_id
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id
      AND e.active = true
      AND e.type IN ('poco', 'bombeamento')
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

    IF v_eq.type = 'poco' THEN
      -- Poco: payload de 1 digito refletindo a saida cadastrada (1..6)
      IF v_eq.saida BETWEEN 1 AND 6
         AND v_eq.last_outputs_state IS NOT NULL
         AND v_eq.last_outputs_state ~ '^[01]{6}$' THEN
        v_bit := substring(v_eq.last_outputs_state from v_eq.saida::int for 1);
      ELSE
        v_bit := '0';
      END IF;
      v_payload := v_bit;
    ELSE
      -- Bombeamento: payload SEMPRE 6 chars [01]. Se invalido/vazio/null, usa '000000'.
      v_payload := COALESCE(NULLIF(v_eq.last_outputs_state, ''), '000000');
      IF v_payload !~ '^[01]{6}$' THEN
        v_payload := '000000';
      END IF;
    END IF;

    v_frame := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';

    INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
    VALUES (_farm_id, v_eq.id, v_tsnn, 'polling', 5, v_frame, 10000, 'platform-scheduler');

    UPDATE public.equipments SET last_polling_at = now() WHERE id = v_eq.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;