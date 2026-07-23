
CREATE TABLE public.maintenance_visits (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  farm_id UUID NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  equipment_ids UUID[] NOT NULL DEFAULT '{}',
  scheduled_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  notified_operators TEXT[] NOT NULL DEFAULT '{}',
  created_by_phone TEXT,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX maintenance_visits_farm_status_idx ON public.maintenance_visits (farm_id, status);
CREATE INDEX maintenance_visits_equipment_ids_idx ON public.maintenance_visits USING GIN (equipment_ids);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.maintenance_visits TO authenticated;
GRANT ALL ON public.maintenance_visits TO service_role;

ALTER TABLE public.maintenance_visits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "maintenance_visits_select_own_farm"
ON public.maintenance_visits FOR SELECT TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.default_farm_id = maintenance_visits.farm_id)
  OR public.is_platform_admin(auth.uid())
);

CREATE POLICY "maintenance_visits_modify_own_farm"
ON public.maintenance_visits FOR ALL TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.default_farm_id = maintenance_visits.farm_id)
  OR public.is_platform_admin(auth.uid())
)
WITH CHECK (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.default_farm_id = maintenance_visits.farm_id)
  OR public.is_platform_admin(auth.uid())
);

CREATE TRIGGER update_maintenance_visits_updated_at
BEFORE UPDATE ON public.maintenance_visits
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
