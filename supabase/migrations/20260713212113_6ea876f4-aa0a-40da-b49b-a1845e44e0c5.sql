CREATE OR REPLACE FUNCTION public.get_command_result(p_command_id UUID)
RETURNS TABLE(status text, response text, error_message text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT status::text, response, error_message
  FROM public.commands
  WHERE id = p_command_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_command_result(UUID) TO authenticated;