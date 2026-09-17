CREATE OR REPLACE FUNCTION public.apply_level_telemetry(_farm_id uuid, _plc_hw_id text, _sensor_index smallint, _raw_value integer, _raw_response text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_eq_id uuid;
  v_plc   text := upper(left(coalesce(_plc_hw_id, ''), 4));
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  IF _sensor_index NOT IN (1, 2) THEN
    RAISE EXCEPTION 'sensor_index invalido: %', _sensor_index;
  END IF;

  -- 1) Match direto pelo level_sensor_index configurado no equipamento.
  --    PLC identificado via plc_groups OU, se plc_group_id for NULL, pelo
  --    proprio hw_id do equipamento (primeiros 4 chars).
  SELECT e.id INTO v_eq_id
  FROM public.equipments e
  LEFT JOIN public.plc_groups p ON p.id = e.plc_group_id
  WHERE e.farm_id = _farm_id
    AND e.type = 'nivel'
    AND (
      (e.plc_group_id IS NOT NULL AND upper(p.hw_id) = v_plc)
      OR upper(left(coalesce(e.hw_id, ''), 4)) = v_plc
    )
    AND e.level_sensor_index = _sensor_index
  ORDER BY e.created_at ASC
  LIMIT 1;

  -- 2) Fallback: nenhum equipamento com index definido -> ordem de cadastro
  IF v_eq_id IS NULL THEN
    SELECT e.id INTO v_eq_id
    FROM public.equipments e
    LEFT JOIN public.plc_groups p ON p.id = e.plc_group_id
    WHERE e.farm_id = _farm_id
      AND e.type = 'nivel'
      AND (
        (e.plc_group_id IS NOT NULL AND upper(p.hw_id) = v_plc)
        OR upper(left(coalesce(e.hw_id, ''), 4)) = v_plc
      )
      AND e.level_sensor_index IS NULL
    ORDER BY e.created_at ASC
    OFFSET (_sensor_index - 1)
    LIMIT 1;
  END IF;

  IF v_eq_id IS NULL THEN
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
$function$;