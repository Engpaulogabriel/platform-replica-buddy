CREATE OR REPLACE FUNCTION public.get_platform_admin_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT user_id FROM public.platform_admins;
$$;

GRANT EXECUTE ON FUNCTION public.get_platform_admin_ids() TO authenticated;