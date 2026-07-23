REVOKE ALL ON FUNCTION public.enqueue_polling_for_due_equipments_internal(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_protective_off_for_offline_pumps() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_automation_tick() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_polling_for_due_equipments(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.enqueue_reset_pump_command(uuid, uuid, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.enqueue_polling_for_due_equipments(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_reset_pump_command(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_polling_for_due_equipments_internal(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_protective_off_for_offline_pumps() TO service_role;
GRANT EXECUTE ON FUNCTION public.run_automation_tick() TO service_role;