-- Substitui a policy "always true" de INSERT em device_audit_log por uma checagem real.
DROP POLICY IF EXISTS device_audit_insert_authenticated ON public.device_audit_log;

CREATE POLICY device_audit_insert_self
ON public.device_audit_log
FOR INSERT
TO authenticated
WITH CHECK (
  actor_id = auth.uid()
  OR is_platform_staff(auth.uid())
);
