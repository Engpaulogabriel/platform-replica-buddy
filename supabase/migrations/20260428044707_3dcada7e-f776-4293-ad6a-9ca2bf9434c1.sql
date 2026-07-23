REVOKE EXECUTE ON FUNCTION public.mark_automation_command_failures() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.mark_automation_command_failures() TO service_role;