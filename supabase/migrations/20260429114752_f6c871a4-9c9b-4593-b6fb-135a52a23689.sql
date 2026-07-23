-- Índices
CREATE INDEX IF NOT EXISTS idx_commands_pending_poll 
ON commands (farm_id, status, priority ASC, created_at ASC) 
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_commands_created_at 
ON commands (created_at);

CREATE INDEX IF NOT EXISTS idx_agent_logs_created_at 
ON agent_logs (created_at);

CREATE INDEX IF NOT EXISTS idx_commands_status_created 
ON commands (status, created_at) 
WHERE status IN ('executed', 'timeout', 'cancelled', 'error');

-- Função de limpeza automática
CREATE OR REPLACE FUNCTION public.cleanup_stale_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  _deleted_cmds integer := 0;
  _deleted_logs integer := 0;
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

  RETURN jsonb_build_object(
    'deleted_commands', _deleted_cmds,
    'deleted_logs', _deleted_logs,
    'ran_at', NOW()
  );
END;
$function$;

ANALYZE commands;
ANALYZE agent_logs;