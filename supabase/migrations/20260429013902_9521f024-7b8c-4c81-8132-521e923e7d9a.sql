REVOKE EXECUTE ON FUNCTION public.enqueue_turn_on_timeout_resets(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enqueue_turn_on_timeout_resets(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.enqueue_turn_on_timeout_resets(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_turn_on_timeout_resets(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.mark_commands_timeout(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_commands_timeout(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_commands_timeout(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_commands_timeout(uuid) TO service_role;