-- Vínculo poço↔equipamento (water_permit_wells.equipment_id) passa a ser editável
-- SOMENTE por platform_admin/super_admin (Setor Técnico). Substitui a policy
-- permissiva (USING true) criada em 20260811220000.
DROP POLICY IF EXISTS water_permit_wells_update ON public.water_permit_wells;
CREATE POLICY water_permit_wells_update ON public.water_permit_wells
  FOR UPDATE TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));
