
REVOKE EXECUTE ON FUNCTION public.is_whatsapp_super_admin(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_whatsapp_register_admin(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_whatsapp_approve_admin(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.current_operator_phone(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_whatsapp_super_admin(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_whatsapp_register_admin(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_whatsapp_approve_admin(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_operator_phone(uuid) TO authenticated, service_role;
