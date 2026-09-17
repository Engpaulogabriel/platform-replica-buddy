DROP POLICY IF EXISTS "Farm members can view whatsapp config" ON public.whatsapp_config;
CREATE POLICY "Farm admins can view whatsapp config"
ON public.whatsapp_config FOR SELECT TO authenticated
USING (
  is_platform_admin(auth.uid())
  OR EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.farm_id = whatsapp_config.farm_id
      AND ur.role = ANY (ARRAY['admin'::app_role, 'owner'::app_role])
  )
);