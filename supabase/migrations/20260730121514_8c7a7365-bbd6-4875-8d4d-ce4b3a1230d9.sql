CREATE OR REPLACE FUNCTION public.protect_profile_super_admin_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_super_admin IS DISTINCT FROM OLD.is_super_admin
     AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'is_super_admin cannot be changed by application users';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_profile_super_admin_flag() FROM PUBLIC, anon, authenticated;