REVOKE ALL ON FUNCTION public.enqueue_reset_pump_command(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_pump_telemetry(uuid, text, text, smallint, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.enqueue_reset_pump_command(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_reset_pump_command(uuid, uuid, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.apply_pump_telemetry(uuid, text, text, smallint, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_pump_telemetry(uuid, text, text, smallint, uuid, text) TO service_role;