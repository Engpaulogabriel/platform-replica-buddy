CREATE TABLE IF NOT EXISTS public.water_permits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  permit_number text NOT NULL,
  permit_date date NOT NULL,
  process_number text NOT NULL,
  holder_name text NOT NULL,
  holder_cpf_cnpj text,
  validity_start date NOT NULL,
  validity_end date NOT NULL,
  municipality text DEFAULT 'São Desidério',
  basin text,
  purpose text DEFAULT 'Irrigação por pivô central',
  irrigated_area_ha numeric,
  regime_hours_per_day integer DEFAULT 18,
  status text DEFAULT 'vigente',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.water_permit_wells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id uuid NOT NULL REFERENCES public.water_permits(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES public.equipments(id) ON DELETE SET NULL,
  well_name text NOT NULL,
  latitude text,
  longitude text,
  flow_rate_m3_day numeric NOT NULL,
  datum text DEFAULT 'Sirgas 2000',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.water_permit_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id uuid NOT NULL REFERENCES public.water_permits(id) ON DELETE CASCADE,
  condition_number integer,
  description text NOT NULL,
  deadline_days integer,
  is_critical boolean DEFAULT false,
  status text DEFAULT 'pendente',
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.water_permits TO authenticated;
GRANT ALL ON public.water_permits TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.water_permit_wells TO authenticated;
GRANT ALL ON public.water_permit_wells TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.water_permit_conditions TO authenticated;
GRANT ALL ON public.water_permit_conditions TO service_role;

ALTER TABLE public.water_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_permit_wells ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_permit_conditions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "water_permits_select" ON public.water_permits FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));
CREATE POLICY "water_permits_write" ON public.water_permits FOR INSERT TO authenticated WITH CHECK (public.can_write_farm(auth.uid(), farm_id));
CREATE POLICY "water_permits_update" ON public.water_permits FOR UPDATE TO authenticated USING (public.can_write_farm(auth.uid(), farm_id)) WITH CHECK (public.can_write_farm(auth.uid(), farm_id));
CREATE POLICY "water_permits_delete" ON public.water_permits FOR DELETE TO authenticated USING (public.is_farm_admin(auth.uid(), farm_id));

CREATE POLICY "water_permit_wells_select" ON public.water_permit_wells FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.water_permits p WHERE p.id = permit_id AND public.has_farm_access(auth.uid(), p.farm_id)));
CREATE POLICY "water_permit_wells_insert" ON public.water_permit_wells FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.water_permits p WHERE p.id = permit_id AND public.can_write_farm(auth.uid(), p.farm_id)));
CREATE POLICY "water_permit_wells_update" ON public.water_permit_wells FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM public.water_permits p WHERE p.id = permit_id AND public.can_write_farm(auth.uid(), p.farm_id))) WITH CHECK (EXISTS (SELECT 1 FROM public.water_permits p WHERE p.id = permit_id AND public.can_write_farm(auth.uid(), p.farm_id)));
CREATE POLICY "water_permit_wells_delete" ON public.water_permit_wells FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM public.water_permits p WHERE p.id = permit_id AND public.is_farm_admin(auth.uid(), p.farm_id)));

CREATE POLICY "water_permit_conditions_select" ON public.water_permit_conditions FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.water_permits p WHERE p.id = permit_id AND public.has_farm_access(auth.uid(), p.farm_id)));
CREATE POLICY "water_permit_conditions_insert" ON public.water_permit_conditions FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.water_permits p WHERE p.id = permit_id AND public.can_write_farm(auth.uid(), p.farm_id)));
CREATE POLICY "water_permit_conditions_update" ON public.water_permit_conditions FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM public.water_permits p WHERE p.id = permit_id AND public.can_write_farm(auth.uid(), p.farm_id))) WITH CHECK (EXISTS (SELECT 1 FROM public.water_permits p WHERE p.id = permit_id AND public.can_write_farm(auth.uid(), p.farm_id)));
CREATE POLICY "water_permit_conditions_delete" ON public.water_permit_conditions FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM public.water_permits p WHERE p.id = permit_id AND public.is_farm_admin(auth.uid(), p.farm_id)));

CREATE INDEX IF NOT EXISTS idx_water_permits_farm ON public.water_permits(farm_id);
CREATE INDEX IF NOT EXISTS idx_water_permit_wells_permit ON public.water_permit_wells(permit_id);
CREATE INDEX IF NOT EXISTS idx_water_permit_conditions_permit ON public.water_permit_conditions(permit_id);

CREATE TRIGGER update_water_permits_updated_at BEFORE UPDATE ON public.water_permits FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();