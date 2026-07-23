-- Atualiza a função de criação de fazenda para gerar licença com 32 chars hex
CREATE OR REPLACE FUNCTION public.platform_create_farm(
  _name text,
  _city text DEFAULT NULL,
  _state text DEFAULT NULL,
  _timezone text DEFAULT 'America/Sao_Paulo',
  _plan text DEFAULT 'lite',
  _owner_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_farm_id uuid;
  v_license text;
  v_owner_id uuid;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_license := 'RNV-' || upper(
    substring(replace(gen_random_uuid()::text,'-','') from 1 for 16) ||
    substring(replace(gen_random_uuid()::text,'-','') from 1 for 16)
  );

  INSERT INTO public.farms (name, city, state, timezone, plan, license_key)
  VALUES (_name, _city, _state, _timezone, _plan, v_license)
  RETURNING id INTO v_farm_id;

  IF _owner_email IS NOT NULL THEN
    SELECT id INTO v_owner_id FROM public.profiles WHERE lower(email) = lower(_owner_email) LIMIT 1;
    IF v_owner_id IS NOT NULL THEN
      INSERT INTO public.user_roles (user_id, farm_id, role)
      VALUES (v_owner_id, v_farm_id, 'owner')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  RETURN jsonb_build_object('farm_id', v_farm_id, 'license_key', v_license);
END;
$function$;

-- Atualiza a função de regeneração de licença
CREATE OR REPLACE FUNCTION public.platform_regen_license(_farm_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_license text;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_license := 'RNV-' || upper(
    substring(replace(gen_random_uuid()::text,'-','') from 1 for 16) ||
    substring(replace(gen_random_uuid()::text,'-','') from 1 for 16)
  );
  UPDATE public.farms SET license_key = v_license, updated_at = now() WHERE id = _farm_id;
  RETURN v_license;
END;
$function$;

-- Atualiza a função de toggle suspend (que também gera quando reativa)
CREATE OR REPLACE FUNCTION public.platform_toggle_suspend(_farm_id uuid, _suspend boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF _suspend THEN
    UPDATE public.farms SET license_key = NULL, updated_at = now() WHERE id = _farm_id;
  ELSE
    UPDATE public.farms
       SET license_key = COALESCE(license_key,
            'RNV-' || upper(
              substring(replace(gen_random_uuid()::text,'-','') from 1 for 16) ||
              substring(replace(gen_random_uuid()::text,'-','') from 1 for 16)
            )),
           updated_at = now()
     WHERE id = _farm_id;
  END IF;
END;
$function$;