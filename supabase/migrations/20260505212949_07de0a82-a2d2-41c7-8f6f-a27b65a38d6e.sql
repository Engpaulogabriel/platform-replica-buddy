-- Configurações globais da plataforma (singleton: key/value)
CREATE TABLE IF NOT EXISTS public.platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- Qualquer usuário autenticado pode LER (necessário para o gate de login funcionar)
DROP POLICY IF EXISTS platform_settings_select_all ON public.platform_settings;
CREATE POLICY platform_settings_select_all
  ON public.platform_settings FOR SELECT
  TO authenticated USING (true);

-- Apenas platform_admin pode escrever
DROP POLICY IF EXISTS platform_settings_insert_admin ON public.platform_settings;
CREATE POLICY platform_settings_insert_admin
  ON public.platform_settings FOR INSERT
  TO authenticated WITH CHECK (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS platform_settings_update_admin ON public.platform_settings;
CREATE POLICY platform_settings_update_admin
  ON public.platform_settings FOR UPDATE
  TO authenticated USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- Seed: por padrão a autorização por dispositivo continua ATIVA (preserva comportamento atual)
INSERT INTO public.platform_settings (key, value)
VALUES ('device_auth', jsonb_build_object('enabled', true))
ON CONFLICT (key) DO NOTHING;