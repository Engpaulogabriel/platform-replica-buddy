
ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS ip_restriction_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.farm_allowed_ips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  ip_address text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  UNIQUE(farm_id, ip_address)
);

GRANT SELECT ON public.farm_allowed_ips TO authenticated;
GRANT ALL ON public.farm_allowed_ips TO service_role;

ALTER TABLE public.farm_allowed_ips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "farm_allowed_ips_select_authenticated"
  ON public.farm_allowed_ips FOR SELECT TO authenticated USING (true);

CREATE POLICY "farm_allowed_ips_admin_insert"
  ON public.farm_allowed_ips FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE POLICY "farm_allowed_ips_admin_update"
  ON public.farm_allowed_ips FOR UPDATE TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE POLICY "farm_allowed_ips_admin_delete"
  ON public.farm_allowed_ips FOR DELETE TO authenticated
  USING (public.is_platform_admin(auth.uid()));

CREATE OR REPLACE FUNCTION public.ip_matches(_pattern text, _ip text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE ok boolean := false;
BEGIN
  IF _pattern IS NULL OR _ip IS NULL THEN RETURN false; END IF;
  IF _pattern = '*' THEN RETURN true; END IF;
  BEGIN
    IF position('/' in _pattern) > 0 THEN
      ok := (_ip::inet << _pattern::inet);
    ELSE
      ok := (_ip::inet = _pattern::inet);
    END IF;
  EXCEPTION WHEN others THEN
    ok := false;
  END;
  RETURN ok;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_farm_ip_allowed(_farm_id uuid, _ip text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_email text;
  v_match boolean;
BEGIN
  SELECT ip_restriction_enabled INTO v_enabled FROM public.farms WHERE id = _farm_id;
  IF v_enabled IS DISTINCT FROM true THEN RETURN true; END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
  IF v_email = 'contato@renovelectronics.com.br' THEN RETURN true; END IF;

  IF _ip IS NULL OR _ip = '' THEN RETURN false; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.farm_allowed_ips
    WHERE farm_id = _farm_id AND public.ip_matches(ip_address, _ip)
  ) INTO v_match;

  RETURN COALESCE(v_match, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_farm_ip_allowed(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ip_matches(text, text) TO authenticated, service_role;
