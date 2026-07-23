CREATE TABLE IF NOT EXISTS public.whatsapp_groups (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id text NOT NULL UNIQUE,
  group_name text,
  farm_id uuid REFERENCES public.farms(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  alerts_enabled boolean NOT NULL DEFAULT true,
  commands_enabled boolean NOT NULL DEFAULT true,
  muted_until timestamptz,
  registered_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_groups TO authenticated;
GRANT ALL ON public.whatsapp_groups TO service_role;

CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_farm ON public.whatsapp_groups(farm_id);

ALTER TABLE public.whatsapp_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wa_groups_select_authenticated" ON public.whatsapp_groups;
CREATE POLICY "wa_groups_select_authenticated"
  ON public.whatsapp_groups FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "wa_groups_modify_authenticated" ON public.whatsapp_groups;
CREATE POLICY "wa_groups_modify_authenticated"
  ON public.whatsapp_groups FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS update_whatsapp_groups_updated_at ON public.whatsapp_groups;
CREATE TRIGGER update_whatsapp_groups_updated_at
  BEFORE UPDATE ON public.whatsapp_groups
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.whatsapp_message_log ADD COLUMN IF NOT EXISTS group_id text;
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_log_group ON public.whatsapp_message_log(group_id);