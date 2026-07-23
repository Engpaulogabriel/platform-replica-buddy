REVOKE ALL ON FUNCTION public.resolve_automation_actor_label(uuid, text, public.event_origin, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_automation_actor_label(uuid, text, public.event_origin, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.set_automation_actor_label() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_automation_actor_label() FROM anon;
REVOKE ALL ON FUNCTION public.log_manual_command_to_automation_log() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_manual_command_to_automation_log() FROM anon;