
-- 1. whatsapp_operators new columns
ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'operator';
ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS is_approver boolean NOT NULL DEFAULT false;
ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS approved_by_phone text;
ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS registration_lat numeric;
ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS registration_lng numeric;
ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS registration_location_text text;
ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS deactivated_by text;
ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS deactivation_reason text;

-- 2. Invite codes
CREATE TABLE IF NOT EXISTS public.whatsapp_invite_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  created_by text,
  expires_at timestamptz,
  max_uses integer NOT NULL DEFAULT 50,
  current_uses integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_invite_codes TO authenticated;
GRANT ALL ON public.whatsapp_invite_codes TO service_role;
ALTER TABLE public.whatsapp_invite_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read invite codes" ON public.whatsapp_invite_codes FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth manage invite codes" ON public.whatsapp_invite_codes FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "service all invite codes" ON public.whatsapp_invite_codes FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_invite_codes_farm ON public.whatsapp_invite_codes(farm_id);
CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON public.whatsapp_invite_codes(code);

-- 3. Registration requests
CREATE TABLE IF NOT EXISTS public.whatsapp_registration_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  name text,
  farm_id uuid REFERENCES public.farms(id) ON DELETE SET NULL,
  farm_name_provided text,
  role_provided text,
  invite_code_used text,
  status text NOT NULL DEFAULT 'pending_info',
  step integer NOT NULL DEFAULT 0,
  registration_lat numeric,
  registration_lng numeric,
  registration_location_text text,
  location_skipped boolean NOT NULL DEFAULT false,
  consent_given boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text,
  reviewed_at timestamptz,
  rejection_reason text
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_registration_requests TO authenticated;
GRANT ALL ON public.whatsapp_registration_requests TO service_role;
ALTER TABLE public.whatsapp_registration_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read reg req" ON public.whatsapp_registration_requests FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth manage reg req" ON public.whatsapp_registration_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "service all reg req" ON public.whatsapp_registration_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_reg_req_phone ON public.whatsapp_registration_requests(phone);
CREATE INDEX IF NOT EXISTS idx_reg_req_status ON public.whatsapp_registration_requests(status);

-- 4. Audit log
CREATE TABLE IF NOT EXISTS public.whatsapp_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  actor_phone text,
  actor_name text,
  target_phone text,
  target_name text,
  farm_id uuid,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_audit_log TO authenticated;
GRANT ALL ON public.whatsapp_audit_log TO service_role;
ALTER TABLE public.whatsapp_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read audit" ON public.whatsapp_audit_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "service all audit" ON public.whatsapp_audit_log FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON public.whatsapp_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event ON public.whatsapp_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_farm ON public.whatsapp_audit_log(farm_id);

-- 5. Failed attempts
CREATE TABLE IF NOT EXISTS public.whatsapp_failed_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  attempt_type text NOT NULL DEFAULT 'invite_code',
  attempted_value text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_failed_attempts TO authenticated;
GRANT ALL ON public.whatsapp_failed_attempts TO service_role;
ALTER TABLE public.whatsapp_failed_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read failed" ON public.whatsapp_failed_attempts FOR SELECT TO authenticated USING (true);
CREATE POLICY "service all failed" ON public.whatsapp_failed_attempts FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_failed_phone ON public.whatsapp_failed_attempts(phone, created_at DESC);

-- 6. Promote Gabriel Carneiro to super_admin
UPDATE public.whatsapp_operators SET role = 'super_admin', is_approver = true WHERE phone LIKE '%99608294';

-- 7. Seed default invite code for Terra Norte
INSERT INTO public.whatsapp_invite_codes (farm_id, code, created_by, expires_at, max_uses)
SELECT id, 'TERRANORTE2026', 'system', now() + interval '90 days', 50
FROM public.farms WHERE name ILIKE '%terra norte%' LIMIT 1
ON CONFLICT (code) DO NOTHING;
