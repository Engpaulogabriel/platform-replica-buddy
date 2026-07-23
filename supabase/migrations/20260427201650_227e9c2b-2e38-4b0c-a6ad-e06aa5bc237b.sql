REVOKE ALL ON FUNCTION public.reconcile_cfg_response_from_agent_log() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_cfg_response_from_agent_log() FROM anon;
GRANT EXECUTE ON FUNCTION public.reconcile_cfg_response_from_agent_log() TO authenticated;