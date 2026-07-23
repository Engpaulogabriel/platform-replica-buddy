
-- Limite de dispositivos por fazenda
ALTER TABLE public.farms ADD COLUMN IF NOT EXISTS device_limit smallint NOT NULL DEFAULT 2;

-- Dispositivos autorizados
CREATE TABLE IF NOT EXISTS public.authorized_devices (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  device_fingerprint text NOT NULL,
  device_name text,
  device_type text,
  browser text,
  os text,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  registered_at timestamptz NOT NULL DEFAULT now(),
  registered_by uuid,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (user_id, device_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_authorized_devices_user ON public.authorized_devices(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_authorized_devices_farm ON public.authorized_devices(farm_id);

ALTER TABLE public.authorized_devices ENABLE ROW LEVEL SECURITY;

-- Cada usuário vê seus próprios dispositivos
CREATE POLICY "authorized_devices_select_own"
  ON public.authorized_devices FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Plataforma vê tudo
CREATE POLICY "authorized_devices_select_platform_staff"
  ON public.authorized_devices FOR SELECT TO authenticated
  USING (public.is_platform_staff(auth.uid()));

-- Cada usuário pode atualizar last_used_at do próprio dispositivo
CREATE POLICY "authorized_devices_update_own_lastseen"
  ON public.authorized_devices FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Plataforma admin gerencia tudo
CREATE POLICY "authorized_devices_admin_all"
  ON public.authorized_devices FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- Tentativas de acesso bloqueadas
CREATE TABLE IF NOT EXISTS public.device_access_attempts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  device_fingerprint text NOT NULL,
  device_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'blocked',
  reviewed_by uuid,
  reviewed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_device_attempts_status ON public.device_access_attempts(status, attempted_at DESC);

ALTER TABLE public.device_access_attempts ENABLE ROW LEVEL SECURITY;

-- Qualquer authenticated insere a própria tentativa (necessário para o bloqueio funcionar)
CREATE POLICY "device_attempts_insert_self"
  ON public.device_access_attempts FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Usuário vê suas próprias tentativas
CREATE POLICY "device_attempts_select_own"
  ON public.device_access_attempts FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Plataforma vê e gerencia tudo
CREATE POLICY "device_attempts_admin_all"
  ON public.device_access_attempts FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));
CREATE POLICY "device_attempts_select_platform_staff"
  ON public.device_access_attempts FOR SELECT TO authenticated
  USING (public.is_platform_staff(auth.uid()));

-- Auditoria
CREATE TABLE IF NOT EXISTS public.device_audit_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  action text NOT NULL,            -- 'authorize','remove','rename','deactivate','limit_change','attempt_blocked'
  actor_id uuid,
  target_user_id uuid,
  device_id uuid,
  farm_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_device_audit_created ON public.device_audit_log(created_at DESC);

ALTER TABLE public.device_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "device_audit_insert_authenticated"
  ON public.device_audit_log FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "device_audit_select_platform_staff"
  ON public.device_audit_log FOR SELECT TO authenticated
  USING (public.is_platform_staff(auth.uid()));

-- Links temporários para auto-registro (15 min)
CREATE TABLE IF NOT EXISTS public.device_register_links (
  token text PRIMARY KEY,
  target_user_id uuid NOT NULL,
  created_by uuid NOT NULL,
  device_name text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  consumed_at timestamptz,
  consumed_device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.device_register_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "device_links_admin_all"
  ON public.device_register_links FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));
CREATE POLICY "device_links_select_target"
  ON public.device_register_links FOR SELECT TO authenticated
  USING (target_user_id = auth.uid());
CREATE POLICY "device_links_update_target"
  ON public.device_register_links FOR UPDATE TO authenticated
  USING (target_user_id = auth.uid())
  WITH CHECK (target_user_id = auth.uid());

-- Função para desativar dispositivos inativos há 90 dias
CREATE OR REPLACE FUNCTION public.deactivate_stale_devices()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.authorized_devices
     SET is_active = false
   WHERE is_active = true
     AND last_used_at < now() - interval '90 days';
$$;
