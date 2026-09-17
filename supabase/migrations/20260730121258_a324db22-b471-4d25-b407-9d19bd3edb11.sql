ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_super_admin boolean NOT NULL DEFAULT false;

UPDATE public.profiles
SET is_super_admin = (lower(email) = lower('paulogabriel@renovtecnologia.com.br'));

CREATE UNIQUE INDEX IF NOT EXISTS profiles_single_super_admin_idx
  ON public.profiles ((is_super_admin))
  WHERE is_super_admin = true;

CREATE OR REPLACE FUNCTION public.protect_profile_super_admin_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_super_admin IS DISTINCT FROM OLD.is_super_admin
     AND current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'is_super_admin cannot be changed by application users';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_super_admin_flag ON public.profiles;
CREATE TRIGGER protect_profile_super_admin_flag
BEFORE UPDATE OF is_super_admin ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.protect_profile_super_admin_flag();