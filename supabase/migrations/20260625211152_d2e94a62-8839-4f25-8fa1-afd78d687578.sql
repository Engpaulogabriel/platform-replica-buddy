
-- 1) registration_codes
CREATE TABLE IF NOT EXISTS public.registration_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  farm_id UUID NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  created_by_phone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by_phone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','expired','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_registration_codes_code ON public.registration_codes(code);
CREATE INDEX IF NOT EXISTS idx_registration_codes_status ON public.registration_codes(status);
CREATE INDEX IF NOT EXISTS idx_registration_codes_farm ON public.registration_codes(farm_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.registration_codes TO authenticated;
GRANT ALL ON public.registration_codes TO service_role;

ALTER TABLE public.registration_codes ENABLE ROW LEVEL SECURITY;

-- Apenas platform_admins podem ver/gerir via UI; edge functions usam service_role.
CREATE POLICY "platform_admins manage registration_codes"
  ON public.registration_codes
  FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()));


-- 2) registration_flow_state
CREATE TABLE IF NOT EXISTS public.registration_flow_state (
  phone TEXT PRIMARY KEY,
  step TEXT NOT NULL,                        -- 'await_code'|'await_name'|'await_cpf'|'await_location'|'await_confirm'
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  code TEXT,
  farm_id UUID REFERENCES public.farms(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_registration_flow_state_updated ON public.registration_flow_state(updated_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.registration_flow_state TO authenticated;
GRANT ALL ON public.registration_flow_state TO service_role;

ALTER TABLE public.registration_flow_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "platform_admins read registration_flow_state"
  ON public.registration_flow_state
  FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()));


-- 3) whatsapp_operators — novos campos
ALTER TABLE public.whatsapp_operators
  ADD COLUMN IF NOT EXISTS location TEXT,
  ADD COLUMN IF NOT EXISTS registered_via_code TEXT,
  ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ;
