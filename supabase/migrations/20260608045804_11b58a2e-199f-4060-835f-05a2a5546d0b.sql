-- farm_messages: allow farm writers (and platform admins) to insert messages for their farm
CREATE POLICY farm_messages_insert_writers
ON public.farm_messages
FOR INSERT
TO authenticated
WITH CHECK (
  can_write_farm(auth.uid(), farm_id)
  AND ((created_by IS NULL) OR (created_by = auth.uid()))
);

CREATE POLICY farm_messages_insert_platform_admin
ON public.farm_messages
FOR INSERT
TO authenticated
WITH CHECK (is_platform_admin(auth.uid()));

-- service_mode_locks: allow farm members to read lock state for their own farm
CREATE POLICY service_mode_locks_select_members
ON public.service_mode_locks
FOR SELECT
TO authenticated
USING (has_farm_access(auth.uid(), farm_id));