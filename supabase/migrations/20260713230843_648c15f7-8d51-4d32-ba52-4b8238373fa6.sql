CREATE OR REPLACE FUNCTION public.debug_alert_system()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_build_object(
    'triggers_on_equipments', (
      SELECT json_agg(json_build_object('name', tgname, 'enabled', tgenabled))
      FROM pg_trigger WHERE tgrelid = 'public.equipments'::regclass AND NOT tgisinternal
    ),
    'triggers_on_commands', (
      SELECT json_agg(json_build_object('name', tgname, 'enabled', tgenabled))
      FROM pg_trigger WHERE tgrelid = 'public.commands'::regclass AND NOT tgisinternal
    ),
    'cron_jobs', (
      SELECT json_agg(json_build_object('jobname', jobname, 'schedule', schedule, 'active', active))
      FROM cron.job
    ),
    'notify_function_exists', (
      SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'notify_equipment_state_change')
    ),
    'check_unresponsive_exists', (
      SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'check_unresponsive_commands')
    )
  ) INTO result;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.debug_alert_system() TO authenticated;
GRANT EXECUTE ON FUNCTION public.debug_alert_system() TO anon;