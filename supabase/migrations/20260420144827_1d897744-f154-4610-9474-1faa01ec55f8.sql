CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_farm_unique
  ON public.user_roles (user_id, farm_id);