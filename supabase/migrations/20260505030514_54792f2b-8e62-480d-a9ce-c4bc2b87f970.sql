
CREATE POLICY "commands_insert_service_test_platform_admin"
ON public.commands FOR INSERT TO authenticated
WITH CHECK (
  type = 'service_test'
  AND public.is_platform_admin(auth.uid())
  AND ((created_by IS NULL) OR (created_by = auth.uid()))
);
