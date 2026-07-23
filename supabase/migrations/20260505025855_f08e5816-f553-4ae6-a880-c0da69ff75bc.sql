
CREATE TABLE IF NOT EXISTS public.dashboard_layouts (
  farm_id uuid PRIMARY KEY REFERENCES public.farms(id) ON DELETE CASCADE,
  layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.dashboard_layouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dashboard_layouts_select_members"
ON public.dashboard_layouts FOR SELECT TO authenticated
USING (public.has_farm_access(auth.uid(), farm_id));

CREATE POLICY "dashboard_layouts_insert_writers"
ON public.dashboard_layouts FOR INSERT TO authenticated
WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

CREATE POLICY "dashboard_layouts_update_writers"
ON public.dashboard_layouts FOR UPDATE TO authenticated
USING (public.can_write_farm(auth.uid(), farm_id));

CREATE POLICY "dashboard_layouts_delete_admins"
ON public.dashboard_layouts FOR DELETE TO authenticated
USING (public.is_farm_admin(auth.uid(), farm_id));

ALTER PUBLICATION supabase_realtime ADD TABLE public.dashboard_layouts;
