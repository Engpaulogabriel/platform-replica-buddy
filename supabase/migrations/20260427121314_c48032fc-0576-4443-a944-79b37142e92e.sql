REVOKE EXECUTE ON FUNCTION public.enqueue_polling_for_due_equipments(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enqueue_polling_for_due_equipments(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.enqueue_polling_for_due_equipments(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_polling_for_due_equipments(uuid) TO service_role;