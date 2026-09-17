
-- 1) Fix always-true INSERT policy on farm_access_requests
DROP POLICY IF EXISTS "auth users insert own requests" ON public.farm_access_requests;
CREATE POLICY "auth users insert own requests"
  ON public.farm_access_requests
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- 2) Restrict farm_allowed_ips SELECT to farm members / platform staff
DROP POLICY IF EXISTS "farm_allowed_ips_select_authenticated" ON public.farm_allowed_ips;
CREATE POLICY "farm_allowed_ips_select_scoped"
  ON public.farm_allowed_ips
  FOR SELECT TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id) OR public.is_platform_staff(auth.uid()));

-- 3) Restrict farm_approved_devices open SELECT
DROP POLICY IF EXISTS "auth users read approved devices" ON public.farm_approved_devices;
CREATE POLICY "farm_approved_devices_select_scoped"
  ON public.farm_approved_devices
  FOR SELECT TO authenticated
  USING (
    public.has_farm_access(auth.uid(), farm_id)
    OR public.is_platform_admin(auth.uid())
    OR public.is_master_manager(auth.uid())
  );

-- 4) automations INSERT policy — use has_farm_access
DROP POLICY IF EXISTS "Users insert automations on their farm" ON public.automations;
CREATE POLICY "automations_insert_farm_access"
  ON public.automations
  FOR INSERT TO authenticated
  WITH CHECK (public.has_farm_access(auth.uid(), farm_id));

-- 5) maintenance_visits — use has_farm_access / can_write_farm
DROP POLICY IF EXISTS "maintenance_visits_select_own_farm" ON public.maintenance_visits;
DROP POLICY IF EXISTS "maintenance_visits_modify_own_farm" ON public.maintenance_visits;
CREATE POLICY "maintenance_visits_select_scoped"
  ON public.maintenance_visits
  FOR SELECT TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id) OR public.is_platform_admin(auth.uid()));
CREATE POLICY "maintenance_visits_modify_scoped"
  ON public.maintenance_visits
  FOR ALL TO authenticated
  USING (public.can_write_farm(auth.uid(), farm_id) OR public.is_platform_admin(auth.uid()))
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id) OR public.is_platform_admin(auth.uid()));

-- 6) agent_config DELETE — allow farm admins/supervisors (consistent with UPDATE)
DROP POLICY IF EXISTS "agent_config_delete_admin" ON public.agent_config;
CREATE POLICY "agent_config_delete_scoped"
  ON public.agent_config
  FOR DELETE TO authenticated
  USING (
    public.is_platform_admin(auth.uid())
    OR public.has_farm_role(auth.uid(), farm_id, 'supervisor'::app_role)
    OR public.has_farm_role(auth.uid(), farm_id, 'admin'::app_role)
  );

-- 7) Set search_path on set_updated_at_daily_consumption
ALTER FUNCTION public.set_updated_at_daily_consumption() SET search_path = public;

-- 8) Update trigger functions to send x-internal-secret header when calling
--    whatsapp-alerts / whatsapp-automation-notify so those functions can require
--    authentication without breaking DB-driven notifications.
DO $$
DECLARE
  fn text;
  def text;
  secret text := '13d2aa41e0cc421a57dc49dccaf7a46856d695302231f81b6af8a08b5e289f8b';
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'notify_equipment_state_change',
    'check_unresponsive_commands',
    'check_bridge_heartbeats',
    'notify_equipment_change'
  ]) LOOP
    SELECT pg_get_functiondef(p.oid) INTO def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = fn
     LIMIT 1;
    IF def IS NULL THEN CONTINUE; END IF;

    -- Inject header only if not already present.
    IF def LIKE '%x-internal-secret%' THEN CONTINUE; END IF;

    def := replace(def,
      '''Authorization'', ''Bearer '' || _auth_key',
      '''Authorization'', ''Bearer '' || _auth_key, ''x-internal-secret'', ''' || secret || '''');
    def := replace(def,
      '''Authorization'',''Bearer ''||v_anon_key',
      '''Authorization'',''Bearer ''||v_anon_key, ''x-internal-secret'', ''' || secret || '''');
    def := replace(def,
      '''Authorization'', ''Bearer '' || _anon',
      '''Authorization'', ''Bearer '' || _anon, ''x-internal-secret'', ''' || secret || '''');

    EXECUTE def;
  END LOOP;
END $$;
