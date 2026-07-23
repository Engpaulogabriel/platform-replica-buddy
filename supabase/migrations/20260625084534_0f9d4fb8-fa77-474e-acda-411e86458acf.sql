
CREATE TABLE IF NOT EXISTS public.whatsapp_blocked_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id text NOT NULL UNIQUE,
  reason text,
  blocked_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_blocked_groups TO authenticated;
GRANT ALL ON public.whatsapp_blocked_groups TO service_role;

ALTER TABLE public.whatsapp_blocked_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read blocked groups" ON public.whatsapp_blocked_groups
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth manage blocked groups" ON public.whatsapp_blocked_groups
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Garante unicidade do group_id em whatsapp_groups
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_groups_group_id_key'
  ) THEN
    ALTER TABLE public.whatsapp_groups ADD CONSTRAINT whatsapp_groups_group_id_key UNIQUE (group_id);
  END IF;
END $$;
