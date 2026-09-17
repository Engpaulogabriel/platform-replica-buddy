DROP POLICY IF EXISTS water_permit_wells_update ON public.water_permit_wells;

CREATE POLICY water_permit_wells_update ON public.water_permit_wells
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.water_permits wp
       WHERE wp.id = water_permit_wells.permit_id
         AND (
           public.has_farm_access(auth.uid(), wp.farm_id)
           OR public.is_platform_admin(auth.uid())
         )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM public.water_permits wp
       WHERE wp.id = water_permit_wells.permit_id
         AND (
           public.has_farm_access(auth.uid(), wp.farm_id)
           OR public.is_platform_admin(auth.uid())
         )
    )
  );