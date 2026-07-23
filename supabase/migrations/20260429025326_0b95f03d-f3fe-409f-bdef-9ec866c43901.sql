REVOKE ALL ON FUNCTION public.enqueue_reset_pump_command(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_commands_timeout(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.enqueue_reset_pump_command(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_reset_pump_command(uuid, uuid, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.mark_commands_timeout(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_commands_timeout(uuid) TO service_role;