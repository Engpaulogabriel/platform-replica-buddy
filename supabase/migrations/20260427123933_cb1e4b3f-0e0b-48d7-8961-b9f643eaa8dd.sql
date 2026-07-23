REVOKE ALL ON FUNCTION public.enqueue_reset_pump_command(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_reset_pump_command(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.enqueue_reset_pump_command(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_reset_pump_command(uuid, uuid, text) TO service_role;