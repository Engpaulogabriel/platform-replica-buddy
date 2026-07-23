DROP POLICY IF EXISTS "auth users read own or admin" ON public.farm_access_requests;
DROP POLICY IF EXISTS "admin update requests" ON public.farm_access_requests;
DROP POLICY IF EXISTS "admin delete requests" ON public.farm_access_requests;

CREATE POLICY "read own or admin/master"
  ON public.farm_access_requests FOR SELECT
  USING (
    user_id = auth.uid()
    OR public.is_platform_admin(auth.uid())
    OR public.is_master_manager(auth.uid())
  );

CREATE POLICY "admin/master update requests"
  ON public.farm_access_requests FOR UPDATE
  USING (
    public.is_platform_admin(auth.uid())
    OR public.is_master_manager(auth.uid())
  );

CREATE POLICY "admin/master delete requests"
  ON public.farm_access_requests FOR DELETE
  USING (
    public.is_platform_admin(auth.uid())
    OR public.is_master_manager(auth.uid())
  );

-- Also ensure approved devices are visible/manageable by master managers
DROP POLICY IF EXISTS "admin read approved devices" ON public.farm_approved_devices;
DROP POLICY IF EXISTS "admin insert approved devices" ON public.farm_approved_devices;
DROP POLICY IF EXISTS "admin update approved devices" ON public.farm_approved_devices;
DROP POLICY IF EXISTS "admin delete approved devices" ON public.farm_approved_devices;

CREATE POLICY "read approved devices"
  ON public.farm_approved_devices FOR SELECT
  USING (
    public.is_platform_admin(auth.uid())
    OR public.is_master_manager(auth.uid())
  );

CREATE POLICY "admin/master insert approved devices"
  ON public.farm_approved_devices FOR INSERT
  WITH CHECK (
    public.is_platform_admin(auth.uid())
    OR public.is_master_manager(auth.uid())
  );

CREATE POLICY "admin/master update approved devices"
  ON public.farm_approved_devices FOR UPDATE
  USING (
    public.is_platform_admin(auth.uid())
    OR public.is_master_manager(auth.uid())
  );

CREATE POLICY "admin/master delete approved devices"
  ON public.farm_approved_devices FOR DELETE
  USING (
    public.is_platform_admin(auth.uid())
    OR public.is_master_manager(auth.uid())
  );