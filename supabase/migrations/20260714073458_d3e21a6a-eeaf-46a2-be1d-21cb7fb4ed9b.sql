
-- Helper: parses N2 (m³) and N3 (m³/h × 10) from a raw serial frame and updates the equipment.
CREATE OR REPLACE FUNCTION public.update_flow_from_telemetry(
  _farm_id uuid,
  _tsnn text,
  _raw text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tsnn_norm text;
  v_n2_txt text;
  v_n3_txt text;
  v_n2 numeric;
  v_n3 numeric;
  v_flow_total integer;
  v_flow_rate real;
  v_eq_id uuid;
BEGIN
  IF _raw IS NULL OR _raw = '' OR _tsnn IS NULL THEN
    RETURN;
  END IF;

  v_tsnn_norm := upper(_tsnn);

  -- Extract N2 (accumulated m³) and N3 (instantaneous flow × 10)
  v_n2_txt := (regexp_match(_raw, '_N2(\d+)N2_'))[1];
  v_n3_txt := (regexp_match(_raw, '_N3(\d+)N3_'))[1];

  IF v_n2_txt IS NULL AND v_n3_txt IS NULL THEN
    RETURN;
  END IF;

  IF v_n2_txt IS NOT NULL THEN
    v_n2 := v_n2_txt::numeric;
    v_flow_total := v_n2::integer;
  END IF;
  IF v_n3_txt IS NOT NULL THEN
    v_n3 := v_n3_txt::numeric;
    v_flow_rate := (v_n3 / 10.0)::real;
  END IF;

  -- Update all equipments on this TSNN with vazao_mode='real'
  UPDATE public.equipments
  SET
    flow_total_m3 = COALESCE(v_flow_total, flow_total_m3),
    flow_rate_m3h = COALESCE(v_flow_rate, flow_rate_m3h),
    updated_at = now()
  WHERE farm_id = _farm_id
    AND upper(substring(hw_id from 1 for 4)) = v_tsnn_norm
    AND vazao_mode = 'real'
  RETURNING id INTO v_eq_id;

  -- Log to flow_history so reports build daily aggregates
  IF v_eq_id IS NOT NULL AND v_flow_total IS NOT NULL THEN
    INSERT INTO public.flow_history (farm_id, equipment_id, ts, accum_m3, flow_rate_m3h)
    VALUES (_farm_id, v_eq_id, now(), v_flow_total, COALESCE(v_flow_rate, 0))
    ON CONFLICT DO NOTHING;
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- never break telemetry apply on flow parse issues
  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_flow_from_telemetry(uuid, text, text) TO authenticated, service_role;

-- Patch apply_pump_telemetry: inject a PERFORM call to update_flow_from_telemetry before RETURN.
DO $patch$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc WHERE proname = 'apply_pump_telemetry' LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'apply_pump_telemetry not found';
  END IF;

  IF position('update_flow_from_telemetry' in v_def) > 0 THEN
    RAISE NOTICE 'already patched';
    RETURN;
  END IF;

  v_new := replace(
    v_def,
    E'END LOOP;\n\n  RETURN v_first_eq_id;',
    E'END LOOP;\n\n  PERFORM public.update_flow_from_telemetry(_farm_id, _tsnn, _raw_response);\n\n  RETURN v_first_eq_id;'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'patch anchor not found in apply_pump_telemetry';
  END IF;

  EXECUTE v_new;
END;
$patch$;
