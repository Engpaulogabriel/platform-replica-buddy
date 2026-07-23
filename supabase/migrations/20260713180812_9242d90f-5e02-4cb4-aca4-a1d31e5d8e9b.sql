
CREATE OR REPLACE FUNCTION public.farm_set_modules(
  _farm_id uuid,
  _patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_current jsonb;
  v_clean jsonb := '{}'::jsonb;
  v_key text;
  v_allowed text[] := ARRAY['energia','vazao_consumo','niveis'];
BEGIN
  IF NOT (
    public.has_farm_role(auth.uid(), _farm_id, 'owner'::app_role)
    OR public.is_platform_admin(auth.uid())
  ) THEN
    RAISE EXCEPTION 'Somente o dono da fazenda pode alterar módulos';
  END IF;

  -- Filtra somente chaves permitidas e valores booleanos
  FOR v_key IN SELECT jsonb_object_keys(_patch) LOOP
    IF v_key = ANY(v_allowed) AND jsonb_typeof(_patch->v_key) = 'boolean' THEN
      v_clean := v_clean || jsonb_build_object(v_key, _patch->v_key);
    END IF;
  END LOOP;

  SELECT COALESCE(modules, '{}'::jsonb) INTO v_current
    FROM public.farms WHERE id = _farm_id;

  UPDATE public.farms
     SET modules = COALESCE(v_current, '{}'::jsonb) || v_clean,
         updated_at = now()
   WHERE id = _farm_id
   RETURNING modules INTO v_current;

  RETURN COALESCE(v_current, '{}'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.farm_set_modules(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_set_modules(uuid, jsonb) TO authenticated, service_role;
