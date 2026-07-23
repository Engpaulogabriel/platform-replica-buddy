
CREATE TABLE IF NOT EXISTS public.command_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id UUID REFERENCES public.equipments(id) ON DELETE CASCADE,
  equipment_name TEXT,
  expected_state TEXT NOT NULL CHECK (expected_state IN ('on','off')),
  command_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  result TEXT CHECK (result IN ('success','failed','pending')) DEFAULT 'pending',
  operator_phone TEXT,
  farm_id UUID REFERENCES public.farms(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_command_verifications_pending
  ON public.command_verifications (command_sent_at)
  WHERE verified_at IS NULL;

GRANT ALL ON public.command_verifications TO service_role;
ALTER TABLE public.command_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON public.command_verifications
  FOR ALL TO service_role USING (true) WITH CHECK (true);
