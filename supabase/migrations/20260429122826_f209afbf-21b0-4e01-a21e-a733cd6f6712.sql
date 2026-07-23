CREATE OR REPLACE FUNCTION public.cleanup_stale_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  _deleted_cmds integer := 0;
  _deleted_logs integer := 0;
  _deleted_automation integer := 0;
BEGIN
  WITH deleted AS (
    DELETE FROM commands
    WHERE status IN ('executed', 'timeout', 'cancelled', 'error')
      AND created_at < NOW() - INTERVAL '48 hours'
    RETURNING 1
  )
  SELECT count(*) INTO _deleted_cmds FROM deleted;

  WITH deleted AS (
    DELETE FROM agent_logs
    WHERE created_at < NOW() - INTERVAL '7 days'
    RETURNING 1
  )
  SELECT count(*) INTO _deleted_logs FROM deleted;

  WITH deleted AS (
    DELETE FROM automation_log
    WHERE created_at < NOW() - INTERVAL '45 days'
    RETURNING 1
  )
  SELECT count(*) INTO _deleted_automation FROM deleted;

  RETURN jsonb_build_object(
    'deleted_commands', _deleted_cmds,
    'deleted_logs', _deleted_logs,
    'deleted_automation', _deleted_automation,
    'ran_at', NOW()
  );
END;
$function$;