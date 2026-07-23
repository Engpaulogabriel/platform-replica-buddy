-- Solicitações pendentes de acesso por fazenda
CREATE TABLE IF NOT EXISTS public.farm_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  user_id uuid,
  user_email text NOT NULL,
  ip_address text NOT NULL,
  user_agent text,
  os text,
  browser text,
  platform text,
  status text DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.farm_access_requests TO authenticated;
GRANT ALL ON public.farm_access_requests TO service_role;
ALTER TABLE public.farm_access_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth users insert own requests" ON public.farm_access_requests
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth users read own or admin" ON public.farm_access_requests
  FOR SELECT TO authenticated USING (
    user_id = auth.uid() OR public.is_platform_admin(auth.uid())
  );
CREATE POLICY "admin update requests" ON public.farm_access_requests
  FOR UPDATE TO authenticated USING (public.is_platform_admin(auth.uid()));
CREATE POLICY "admin delete requests" ON public.farm_access_requests
  FOR DELETE TO authenticated USING (public.is_platform_admin(auth.uid()));

-- Dispositivos/IPs aprovados por fazenda
CREATE TABLE IF NOT EXISTS public.farm_approved_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  ip_address text NOT NULL,
  user_email text,
  user_agent text,
  os text,
  browser text,
  platform text,
  approved_at timestamptz DEFAULT now(),
  approved_by uuid,
  description text DEFAULT '',
  UNIQUE(farm_id, ip_address)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.farm_approved_devices TO authenticated;
GRANT ALL ON public.farm_approved_devices TO service_role;
ALTER TABLE public.farm_approved_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth users read approved devices" ON public.farm_approved_devices
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin manage approved devices ins" ON public.farm_approved_devices
  FOR INSERT TO authenticated WITH CHECK (public.is_platform_admin(auth.uid()));
CREATE POLICY "admin manage approved devices upd" ON public.farm_approved_devices
  FOR UPDATE TO authenticated USING (public.is_platform_admin(auth.uid()));
CREATE POLICY "admin manage approved devices del" ON public.farm_approved_devices
  FOR DELETE TO authenticated USING (public.is_platform_admin(auth.uid()));

-- Garante coluna na farms (idempotente)
ALTER TABLE public.farms ADD COLUMN IF NOT EXISTS ip_restriction_enabled boolean DEFAULT false;

-- Função para checar acesso: retorna 'allowed' | 'blocked'
CREATE OR REPLACE FUNCTION public.check_farm_device_access(
  _farm_id uuid, _ip text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT NOT ip_restriction_enabled FROM public.farms WHERE id = _farm_id),
    true
  ) OR EXISTS (
    SELECT 1 FROM public.farm_approved_devices
    WHERE farm_id = _farm_id AND ip_address = _ip
  ) OR EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = auth.uid() AND lower(u.email) = 'contato@renovelectronics.com.br'
  );
$$;
GRANT EXECUTE ON FUNCTION public.check_farm_device_access(uuid, text) TO authenticated;
