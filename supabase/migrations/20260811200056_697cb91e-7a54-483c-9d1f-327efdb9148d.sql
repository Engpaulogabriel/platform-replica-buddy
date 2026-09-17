DROP POLICY IF EXISTS water_permit_wells_update ON public.water_permit_wells;
CREATE POLICY water_permit_wells_update ON public.water_permit_wells
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);