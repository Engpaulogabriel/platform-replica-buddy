
-- Colunas de calibração + última leitura
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS level_last_raw integer,
  ADD COLUMN IF NOT EXISTS level_last_raw_at timestamptz,
  ADD COLUMN IF NOT EXISTS level_cal_raw_min integer,
  ADD COLUMN IF NOT EXISTS level_cal_meters_min numeric(8,3),
  ADD COLUMN IF NOT EXISTS level_cal_raw_max integer,
  ADD COLUMN IF NOT EXISTS level_cal_meters_max numeric(8,3),
  ADD COLUMN IF NOT EXISTS level_sensor_index smallint;

COMMENT ON COLUMN public.equipments.level_last_raw IS 'Última leitura digital N1/N2 (0-1023 ou similar) recebida do PLC para equipamentos tipo nivel';
COMMENT ON COLUMN public.equipments.level_sensor_index IS '1 = primeiro nível do PLC (recebe N1); 2 = segundo nível do PLC (recebe N2). NULL = não vinculado.';

-- RPC dedicada para gravar leitura de nível (separada da apply_pump_telemetry)
CREATE OR REPLACE FUNCTION public.apply_level_telemetry(
  _farm_id uuid,
  _plc_hw_id text,           -- 4 chars hex do PLC, ex 1313
  _sensor_index smallint,    -- 1 (N1) ou 2 (N2)
  _raw_value integer,
  _raw_response text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eq_id uuid;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  IF _sensor_index NOT IN (1, 2) THEN
    RAISE EXCEPTION 'sensor_index invalido: %', _sensor_index;
  END IF;

  -- Acha o N-ésimo equipamento de nível do PLC pelo hw_id começando com _plc_hw_id
  -- Ordem estável: por created_at ASC (mais antigo = N1; segundo = N2)
  SELECT e.id INTO v_eq_id
  FROM public.equipments e
  JOIN public.plc_groups p ON p.id = e.plc_group_id
  WHERE e.farm_id = _farm_id
    AND e.type = 'nivel'
    AND upper(p.hw_id) = upper(_plc_hw_id)
  ORDER BY e.created_at ASC
  OFFSET (_sensor_index - 1)
  LIMIT 1;

  IF v_eq_id IS NULL THEN
    -- Não há equipamento de nível cadastrado para esse PLC nessa posição.
    -- Não é erro — o PLC pode mandar N1/N2 mesmo sem cadastro.
    RETURN NULL;
  END IF;

  UPDATE public.equipments
     SET level_last_raw = _raw_value,
         level_last_raw_at = now(),
         level_sensor_index = _sensor_index,
         last_communication = now()
   WHERE id = v_eq_id;

  RETURN v_eq_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_level_telemetry(uuid, text, smallint, integer, text) TO authenticated;
