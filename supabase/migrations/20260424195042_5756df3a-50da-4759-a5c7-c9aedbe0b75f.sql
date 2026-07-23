CREATE OR REPLACE FUNCTION public.enqueue_reset_pump_command(_farm_id uuid, _equipment_id uuid, _reason text DEFAULT 'manual_reset'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_eq RECORD;
  v_tsnn text;
  v_radio text := 'R1';
  v_via_rep boolean := false;
  v_lora text;
  v_frame text;
  v_command_id uuid;
  v_timeout_ms integer := 120000;
  v_reason text := COALESCE(NULLIF(_reason, ''), 'manual_reset');
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  SELECT e.id, e.farm_id, e.hw_id, e.plc_group_id, e.type
    INTO v_eq
  FROM public.equipments e
  WHERE e.id = _equipment_id
    AND e.farm_id = _farm_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Equipamento nao encontrado';
  END IF;

  IF v_eq.type NOT IN ('poco', 'bombeamento') THEN
    RAISE EXCEPTION 'Equipamento % nao aceita reset', v_eq.type;
  END IF;

  IF v_eq.plc_group_id IS NOT NULL THEN
    SELECT pg.hw_id
      INTO v_tsnn
    FROM public.plc_groups pg
    WHERE pg.id = v_eq.plc_group_id
    LIMIT 1;
  END IF;

  v_tsnn := COALESCE(NULLIF(v_tsnn, ''), substring(v_eq.hw_id from 1 for 4));

  SELECT COALESCE(r.radio, 'R1'), COALESCE(r.via_repetidor, false)
    INTO v_radio, v_via_rep
  FROM public.rf_routing r
  WHERE r.farm_id = _farm_id
  LIMIT 1;

  v_lora := '[' || v_tsnn || '_1_]{0}[' || v_tsnn || '_ETX_]' || E'\r';
  v_frame := CASE
    WHEN COALESCE(v_via_rep, false) THEN 'REP:R3:TX:' || COALESCE(v_radio, 'R1') || ':' || v_lora
    ELSE v_lora
  END;

  INSERT INTO public.commands (
    farm_id,
    equipment_id,
    plc_hw_id,
    type,
    priority,
    frame,
    timeout_ms,
    created_by,
    client_event_id,
    source_device
  )
  VALUES (
    _farm_id,
    _equipment_id,
    v_tsnn,
    'manual',
    0,
    v_frame,
    v_timeout_ms,
    auth.uid(),
    gen_random_uuid(),
    left('backend-reset:' || v_reason, 80)
  )
  RETURNING id INTO v_command_id;

  UPDATE public.commands
  SET status = 'cancelled',
      responded_at = now(),
      error_message = CASE
        WHEN v_reason = 'turn_on_timeout'
          THEN 'Cancelado por seguranca: comando 0 enfileirado apos falha ao ligar'
        ELSE 'Cancelado por RESET de emergencia'
      END
  WHERE farm_id = _farm_id
    AND id <> v_command_id
    AND status IN ('pending', 'sent')
    AND (
      equipment_id = _equipment_id
      OR (
        plc_hw_id = v_tsnn
        AND type = 'polling'
      )
    );

  UPDATE public.equipments
  SET pending_command_id = v_command_id,
      command_blocked_until = NULL,
      desired_running = false,
      updated_at = now()
  WHERE id = _equipment_id
    AND farm_id = _farm_id;

  RETURN v_command_id;
END;
$function$;