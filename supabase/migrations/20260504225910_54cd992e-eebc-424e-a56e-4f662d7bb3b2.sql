REVOKE EXECUTE ON FUNCTION public.cancel_pending_pollings_for_plc(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cancel_pending_pollings_for_plc(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cancel_pending_pollings_for_plc(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_pending_pollings_for_plc(uuid, text, text) TO service_role;