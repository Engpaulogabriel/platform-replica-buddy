CREATE OR REPLACE FUNCTION public.get_command_result(p_command_id uuid)
RETURNS TABLE(status text, response text, error_message text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.status::text, c.response, c.error_message
  FROM public.commands c
  WHERE c.id = p_command_id
    AND (
      public.has_farm_access(auth.uid(), c.farm_id)
      OR public.is_platform_staff(auth.uid())
    );
$$;

REVOKE ALL ON FUNCTION public.get_command_result(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_command_result(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_command_result(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';