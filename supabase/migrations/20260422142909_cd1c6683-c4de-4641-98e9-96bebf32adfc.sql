CREATE OR REPLACE FUNCTION public.apply_pump_telemetry(
  _farm_id uuid,
  _tsnn text,
  _payload text,
  _signal_bars smallint DEFAULT NULL::smallint,
  _command_id uuid DEFAULT NULL::uuid,
  _raw_response text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_eq_id uuid;
  v_eq_saida smallint;
  v_payload_safe text;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  -- Localiza o equipamento alvo por prefixo de hw_id (TSNN = 4 primeiros digitos)
  SELECT id, COALESCE(saida, 1)
    INTO v_eq_id, v_eq_saida
  FROM public.equipments
  WHERE farm_id = _farm_id
    AND substring(hw_id from 1 for 4) = _tsnn
  LIMIT 1;

  -- Sanitiza/normaliza payload
  IF _payload IS NULL THEN
    v_payload_safe := NULL;
  ELSIF _payload ~ '^[01]{6}$' THEN
    -- Bombeamento: payload completo das 6 saidas
    v_payload_safe := _payload;
  ELSIF _payload ~ '^[01]$' AND v_eq_saida BETWEEN 1 AND 6 THEN
    -- Poco (1 digito): expande para 6 colocando o bit na posicao da saida cadastrada
    v_payload_safe := overlay('000000' placing _payload from v_eq_saida::int for 1);
  ELSE
    v_payload_safe := NULL; -- formato desconhecido, nao atualizar
  END IF;

  UPDATE public.equipments
  SET
    last_communication = now(),
    last_signal_bars = COALESCE(_signal_bars, last_signal_bars),
    last_outputs_state = COALESCE(v_payload_safe, last_outputs_state),
    updated_at = now()
  WHERE id = v_eq_id
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