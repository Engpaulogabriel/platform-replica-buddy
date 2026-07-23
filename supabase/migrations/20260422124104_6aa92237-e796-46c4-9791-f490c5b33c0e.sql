-- Endurece o polling: payload sempre 6 chars [01]
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
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissão para fazenda %', _farm_id;
  END IF;

  FOR v_eq IN
    SELECT e.id, e.hw_id, e.last_outputs_state, e.polling_interval_seconds, e.last_polling_at, pg.hw_id AS plc_hw_id
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

    -- Payload SEMPRE 6 chars [01]. Se inválido/vazio/null → '000000'.
    v_payload := COALESCE(NULLIF(v_eq.last_outputs_state, ''), '000000');
    IF v_payload !~ '^[01]{6}$' THEN
      v_payload := '000000';
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

-- Telemetria: ignora payload vazio/inválido vindo da bomba
CREATE OR REPLACE FUNCTION public.apply_pump_telemetry(_farm_id uuid, _tsnn text, _payload text, _signal_bars smallint DEFAULT NULL::smallint, _command_id uuid DEFAULT NULL::uuid, _raw_response text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_eq_id uuid;
  v_payload_safe text;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissão para fazenda %', _farm_id;
  END IF;

  -- Sanitiza payload: só aceita 6 chars [01]; caso contrário preserva o atual
  IF _payload IS NOT NULL AND _payload ~ '^[01]{6}$' THEN
    v_payload_safe := _payload;
  ELSE
    v_payload_safe := NULL; -- sinaliza "não atualizar"
  END IF;

  UPDATE public.equipments
  SET
    last_communication = now(),
    last_signal_bars = COALESCE(_signal_bars, last_signal_bars),
    last_outputs_state = COALESCE(v_payload_safe, last_outputs_state),
    updated_at = now()
  WHERE farm_id = _farm_id
    AND substring(hw_id from 1 for 4) = _tsnn
  RETURNING id INTO v_eq_id;

  IF _command_id IS NOT NULL THEN
    UPDATE public.commands
    SET status = 'executed',
        responded_at = now(),
        response = COALESCE(_raw_response, response)
    WHERE id = _command_id AND farm_id = _farm_id;
  END IF;

  RETURN v_eq_id;
END;
$function$;

-- Limpa registros existentes inválidos por segurança
UPDATE public.equipments
SET last_outputs_state = '000000'
WHERE last_outputs_state IS NULL
   OR last_outputs_state = ''
   OR last_outputs_state !~ '^[01]{6}$';

-- Cancela comandos pending que ainda foram montados com {} vazio
UPDATE public.commands
SET status = 'cancelled',
    error_message = 'Frame com payload vazio — recriado pelo scheduler'
WHERE status = 'pending'
  AND frame LIKE '%{}%';