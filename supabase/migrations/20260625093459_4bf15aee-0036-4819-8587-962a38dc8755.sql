
CREATE TABLE IF NOT EXISTS public.whatsapp_manager_registration_state (
  super_admin_phone text PRIMARY KEY,
  step int NOT NULL DEFAULT 1,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  farm_id uuid REFERENCES public.farms(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.whatsapp_manager_registration_state TO service_role;

ALTER TABLE public.whatsapp_manager_registration_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON public.whatsapp_manager_registration_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);
