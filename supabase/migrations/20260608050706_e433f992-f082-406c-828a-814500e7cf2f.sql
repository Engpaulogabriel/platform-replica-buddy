-- Fix platform_settings SELECT: restrict from 'true' (all authenticated) to is_platform_admin only.
-- platform_settings has no farm_id, so only platform admins should read platform-wide config.
DROP POLICY IF EXISTS "platform_settings_select_all" ON public.platform_settings;

CREATE POLICY "platform_settings_select_admin"
  ON public.platform_settings
  FOR SELECT
  TO authenticated
  USING (is_platform_admin(auth.uid()));

-- Fix service_mode_locks SELECT: remove overly broad is_platform_staff policy;
-- keep only farm-scoped has_farm_access plus the existing platform_admin ALL policy.
DROP POLICY IF EXISTS "service_mode_locks_select_platform_staff" ON public.service_mode_locks;

-- Ensure the farm-scoped SELECT policy exists with the correct expression
DROP POLICY IF EXISTS "service_mode_locks_select_members" ON public.service_mode_locks;

CREATE POLICY "service_mode_locks_select_members"
  ON public.service_mode_locks
  FOR SELECT
  TO authenticated
  USING (has_farm_access(auth.uid(), farm_id));