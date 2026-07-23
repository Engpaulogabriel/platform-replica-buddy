REVOKE ALL ON FUNCTION public.farm_backup_create(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.farm_backup_create(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.farm_backup_create(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.farm_backup_create(uuid, text, text) TO service_role;