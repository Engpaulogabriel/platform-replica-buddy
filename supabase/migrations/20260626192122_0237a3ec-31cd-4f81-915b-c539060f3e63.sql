
CREATE OR REPLACE FUNCTION public.is_whatsapp_super_admin(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.whatsapp_operators WHERE user_id = _uid AND role = 'super_admin' AND is_active = true)
$$;

CREATE OR REPLACE FUNCTION public.is_whatsapp_register_admin(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.whatsapp_operators WHERE user_id = _uid AND is_active = true
    AND (role = 'super_admin' OR (role = 'admin' AND can_register = true)))
$$;

CREATE OR REPLACE FUNCTION public.is_whatsapp_approve_admin(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.whatsapp_operators WHERE user_id = _uid AND is_active = true
    AND (role = 'super_admin' OR (role = 'admin' AND can_approve = true)))
$$;

CREATE OR REPLACE FUNCTION public.current_operator_phone(_uid uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT phone FROM public.whatsapp_operators WHERE user_id = _uid LIMIT 1
$$;

-- whatsapp_message_log
DROP POLICY IF EXISTS "auth read message log" ON public.whatsapp_message_log;
DROP POLICY IF EXISTS "authenticated read message log" ON public.whatsapp_message_log;
DROP POLICY IF EXISTS "auth manage message log" ON public.whatsapp_message_log;
DROP POLICY IF EXISTS "Service inserts message log" ON public.whatsapp_message_log;
CREATE POLICY "super_admin or own phone reads message log" ON public.whatsapp_message_log
  FOR SELECT TO authenticated USING (
    public.is_whatsapp_super_admin(auth.uid()) OR phone = public.current_operator_phone(auth.uid())
  );
CREATE POLICY "service role manages message log" ON public.whatsapp_message_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- whatsapp_audit_log
DROP POLICY IF EXISTS "auth read audit" ON public.whatsapp_audit_log;
DROP POLICY IF EXISTS "auth manage audit" ON public.whatsapp_audit_log;
CREATE POLICY "super_admin reads audit log" ON public.whatsapp_audit_log
  FOR SELECT TO authenticated USING (public.is_whatsapp_super_admin(auth.uid()));
CREATE POLICY "service role manages audit log" ON public.whatsapp_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- whatsapp_alerts_log (no farm_id column)
DROP POLICY IF EXISTS "authenticated read alert log" ON public.whatsapp_alerts_log;
DROP POLICY IF EXISTS "auth read alert log" ON public.whatsapp_alerts_log;
DROP POLICY IF EXISTS "auth manage alert log" ON public.whatsapp_alerts_log;
CREATE POLICY "super_admin reads alert log" ON public.whatsapp_alerts_log
  FOR SELECT TO authenticated USING (public.is_whatsapp_super_admin(auth.uid()));
CREATE POLICY "service role manages alert log" ON public.whatsapp_alerts_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- whatsapp_blocked_groups
DROP POLICY IF EXISTS "auth manage blocked groups" ON public.whatsapp_blocked_groups;
DROP POLICY IF EXISTS "auth read blocked groups" ON public.whatsapp_blocked_groups;
CREATE POLICY "super_admin manages blocked groups" ON public.whatsapp_blocked_groups
  FOR ALL TO authenticated
  USING (public.is_whatsapp_super_admin(auth.uid()))
  WITH CHECK (public.is_whatsapp_super_admin(auth.uid()));
CREATE POLICY "service role manages blocked groups" ON public.whatsapp_blocked_groups
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- whatsapp_failed_attempts
DROP POLICY IF EXISTS "auth read failed" ON public.whatsapp_failed_attempts;
DROP POLICY IF EXISTS "auth manage failed" ON public.whatsapp_failed_attempts;
CREATE POLICY "super_admin reads failed attempts" ON public.whatsapp_failed_attempts
  FOR SELECT TO authenticated USING (public.is_whatsapp_super_admin(auth.uid()));
CREATE POLICY "service role manages failed attempts" ON public.whatsapp_failed_attempts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- whatsapp_invite_codes
DROP POLICY IF EXISTS "auth manage invite codes" ON public.whatsapp_invite_codes;
DROP POLICY IF EXISTS "auth read invite codes" ON public.whatsapp_invite_codes;
CREATE POLICY "register admins manage invite codes" ON public.whatsapp_invite_codes
  FOR ALL TO authenticated
  USING (public.is_whatsapp_register_admin(auth.uid()))
  WITH CHECK (public.is_whatsapp_register_admin(auth.uid()));
CREATE POLICY "service role manages invite codes" ON public.whatsapp_invite_codes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- whatsapp_registration_requests
DROP POLICY IF EXISTS "auth manage reg req" ON public.whatsapp_registration_requests;
DROP POLICY IF EXISTS "auth read reg req" ON public.whatsapp_registration_requests;
CREATE POLICY "approve admins read registration requests" ON public.whatsapp_registration_requests
  FOR SELECT TO authenticated USING (public.is_whatsapp_approve_admin(auth.uid()));
CREATE POLICY "approve admins update registration requests" ON public.whatsapp_registration_requests
  FOR UPDATE TO authenticated
  USING (public.is_whatsapp_approve_admin(auth.uid()))
  WITH CHECK (public.is_whatsapp_approve_admin(auth.uid()));
CREATE POLICY "service role manages registration requests" ON public.whatsapp_registration_requests
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- whatsapp_groups
DROP POLICY IF EXISTS "wa_groups_modify_authenticated" ON public.whatsapp_groups;
DROP POLICY IF EXISTS "wa_groups_read_authenticated" ON public.whatsapp_groups;
CREATE POLICY "farm members read whatsapp groups" ON public.whatsapp_groups
  FOR SELECT TO authenticated USING (
    public.is_whatsapp_super_admin(auth.uid())
    OR (farm_id IS NOT NULL AND public.has_farm_access(auth.uid(), farm_id))
  );
CREATE POLICY "farm members write whatsapp groups" ON public.whatsapp_groups
  FOR INSERT TO authenticated
  WITH CHECK (farm_id IS NOT NULL AND public.has_farm_access(auth.uid(), farm_id));
CREATE POLICY "farm members update whatsapp groups" ON public.whatsapp_groups
  FOR UPDATE TO authenticated
  USING (farm_id IS NOT NULL AND public.has_farm_access(auth.uid(), farm_id))
  WITH CHECK (farm_id IS NOT NULL AND public.has_farm_access(auth.uid(), farm_id));
CREATE POLICY "farm members delete whatsapp groups" ON public.whatsapp_groups
  FOR DELETE TO authenticated
  USING (farm_id IS NOT NULL AND public.has_farm_access(auth.uid(), farm_id));
CREATE POLICY "service role manages whatsapp groups" ON public.whatsapp_groups
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- automation_audit_log
DROP POLICY IF EXISTS "Users view audit of their farm" ON public.automation_audit_log;
DROP POLICY IF EXISTS "Users insert audit for their farm" ON public.automation_audit_log;
CREATE POLICY "Farm members view automation audit" ON public.automation_audit_log
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));
CREATE POLICY "Farm members insert automation audit" ON public.automation_audit_log
  FOR INSERT TO authenticated WITH CHECK (public.has_farm_access(auth.uid(), farm_id));
CREATE POLICY "Service manages automation audit" ON public.automation_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- automations + related
DROP POLICY IF EXISTS "Users delete automations of their farm" ON public.automations;
DROP POLICY IF EXISTS "Users update automations of their farm" ON public.automations;
DROP POLICY IF EXISTS "Users insert automations of their farm" ON public.automations;
DROP POLICY IF EXISTS "Users view automations of their farm" ON public.automations;
CREATE POLICY "Farm members manage automations" ON public.automations
  FOR ALL TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id))
  WITH CHECK (public.has_farm_access(auth.uid(), farm_id));

DROP POLICY IF EXISTS "Users manage actions of their automations" ON public.automation_actions;
CREATE POLICY "Farm members manage automation actions" ON public.automation_actions
  FOR ALL TO authenticated
  USING (automation_id IN (SELECT id FROM public.automations WHERE public.has_farm_access(auth.uid(), farm_id)))
  WITH CHECK (automation_id IN (SELECT id FROM public.automations WHERE public.has_farm_access(auth.uid(), farm_id)));

DROP POLICY IF EXISTS "Users manage triggers of their automations" ON public.automation_triggers;
CREATE POLICY "Farm members manage automation triggers" ON public.automation_triggers
  FOR ALL TO authenticated
  USING (automation_id IN (SELECT id FROM public.automations WHERE public.has_farm_access(auth.uid(), farm_id)))
  WITH CHECK (automation_id IN (SELECT id FROM public.automations WHERE public.has_farm_access(auth.uid(), farm_id)));

DROP POLICY IF EXISTS "Users view history of their automations" ON public.automation_execution_history;
DROP POLICY IF EXISTS "Service inserts history" ON public.automation_execution_history;
CREATE POLICY "Farm members view automation history" ON public.automation_execution_history
  FOR SELECT TO authenticated
  USING (automation_id IN (SELECT id FROM public.automations WHERE public.has_farm_access(auth.uid(), farm_id)));
CREATE POLICY "Service manages automation history" ON public.automation_execution_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);
