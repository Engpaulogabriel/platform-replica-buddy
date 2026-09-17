-- 1) Fix mutable search_path on functions
CREATE OR REPLACE FUNCTION public.cleanup_audit_is_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public
AS $function$
BEGIN
  RAISE EXCEPTION 'automation_cleanup_audit é append-only: % não é permitido', TG_OP;
END; $function$;

CREATE OR REPLACE FUNCTION public.is_workday(d date)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path = public
AS $function$
  SELECT EXTRACT(DOW FROM d) NOT IN (0, 6);
$function$;

-- 2) daily_consumption: scope policies to authenticated
DROP POLICY IF EXISTS daily_consumption_select_members ON public.daily_consumption;
CREATE POLICY daily_consumption_select_members ON public.daily_consumption
  FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));

DROP POLICY IF EXISTS daily_consumption_write_writers ON public.daily_consumption;
CREATE POLICY daily_consumption_write_writers ON public.daily_consumption
  FOR ALL TO authenticated
  USING (can_write_farm(auth.uid(), farm_id) OR is_platform_staff(auth.uid()))
  WITH CHECK (can_write_farm(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));

-- 3) flow_history: scope policies to authenticated
DROP POLICY IF EXISTS flow_history_select_members ON public.flow_history;
CREATE POLICY flow_history_select_members ON public.flow_history
  FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id));

DROP POLICY IF EXISTS flow_history_select_platform_staff ON public.flow_history;
CREATE POLICY flow_history_select_platform_staff ON public.flow_history
  FOR SELECT TO authenticated
  USING (is_platform_staff(auth.uid()));

DROP POLICY IF EXISTS flow_history_insert_writers ON public.flow_history;
CREATE POLICY flow_history_insert_writers ON public.flow_history
  FOR INSERT TO authenticated
  WITH CHECK (can_write_farm(auth.uid(), farm_id));

-- 4) watchdog_alerts_state: explicit service_role scoping
DROP POLICY IF EXISTS "watchdog state — service role only" ON public.watchdog_alerts_state;
CREATE POLICY "watchdog state service role only" ON public.watchdog_alerts_state
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 5) whatsapp_broadcasts: scope to authenticated platform admins
DROP POLICY IF EXISTS "platform admins can manage broadcasts" ON public.whatsapp_broadcasts;
CREATE POLICY "platform admins can manage broadcasts" ON public.whatsapp_broadcasts
  FOR ALL TO authenticated
  USING (is_platform_admin(auth.uid()))
  WITH CHECK (is_platform_admin(auth.uid()));
GRANT ALL ON public.whatsapp_broadcasts TO service_role;

-- 6) agent_config: supervisors may no longer DELETE
DROP POLICY IF EXISTS agent_config_delete_scoped ON public.agent_config;
CREATE POLICY agent_config_delete_scoped ON public.agent_config
  FOR DELETE TO authenticated
  USING (
    is_platform_admin(auth.uid())
    OR has_farm_role(auth.uid(), farm_id, 'admin'::app_role)
    OR has_farm_role(auth.uid(), farm_id, 'owner'::app_role)
  );
