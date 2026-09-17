CREATE OR REPLACE FUNCTION public.master_manages_farm(_uid uuid, _farm_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.master_managers mm
    JOIN public.master_manager_farms mmf ON mmf.manager_id = mm.id
    WHERE mm.user_id = _uid AND mm.status = 'active' AND mmf.farm_id = _farm_id
  ) OR EXISTS (
    SELECT 1
    FROM public.master_managers mm
    JOIN public.master_manager_farms mmf ON mmf.manager_id = mm.user_id
    WHERE mm.user_id = _uid AND mm.status = 'active' AND mmf.farm_id = _farm_id
  );
$$;

DROP POLICY IF EXISTS "admin/master delete requests" ON public.farm_access_requests;
DROP POLICY IF EXISTS "admin/master update requests" ON public.farm_access_requests;
DROP POLICY IF EXISTS "read own or admin/master" ON public.farm_access_requests;

CREATE POLICY "farm_access_requests_select" ON public.farm_access_requests FOR SELECT TO authenticated
USING (user_id = auth.uid() OR is_platform_admin(auth.uid()) OR public.master_manages_farm(auth.uid(), farm_id));
CREATE POLICY "farm_access_requests_update" ON public.farm_access_requests FOR UPDATE TO authenticated
USING (is_platform_admin(auth.uid()) OR public.master_manages_farm(auth.uid(), farm_id))
WITH CHECK (is_platform_admin(auth.uid()) OR public.master_manages_farm(auth.uid(), farm_id));
CREATE POLICY "farm_access_requests_delete" ON public.farm_access_requests FOR DELETE TO authenticated
USING (is_platform_admin(auth.uid()) OR public.master_manages_farm(auth.uid(), farm_id));

DROP POLICY IF EXISTS "admin/master delete approved devices" ON public.farm_approved_devices;
DROP POLICY IF EXISTS "admin/master insert approved devices" ON public.farm_approved_devices;
DROP POLICY IF EXISTS "admin/master update approved devices" ON public.farm_approved_devices;
DROP POLICY IF EXISTS "read approved devices" ON public.farm_approved_devices;
DROP POLICY IF EXISTS "farm_approved_devices_select_scoped" ON public.farm_approved_devices;

CREATE POLICY "farm_approved_devices_select" ON public.farm_approved_devices FOR SELECT TO authenticated
USING (has_farm_access(auth.uid(), farm_id) OR is_platform_admin(auth.uid()) OR public.master_manages_farm(auth.uid(), farm_id));
CREATE POLICY "farm_approved_devices_insert" ON public.farm_approved_devices FOR INSERT TO authenticated
WITH CHECK (is_platform_admin(auth.uid()) OR public.master_manages_farm(auth.uid(), farm_id));
CREATE POLICY "farm_approved_devices_update" ON public.farm_approved_devices FOR UPDATE TO authenticated
USING (is_platform_admin(auth.uid()) OR public.master_manages_farm(auth.uid(), farm_id))
WITH CHECK (is_platform_admin(auth.uid()) OR public.master_manages_farm(auth.uid(), farm_id));
CREATE POLICY "farm_approved_devices_delete" ON public.farm_approved_devices FOR DELETE TO authenticated
USING (is_platform_admin(auth.uid()) OR public.master_manages_farm(auth.uid(), farm_id));