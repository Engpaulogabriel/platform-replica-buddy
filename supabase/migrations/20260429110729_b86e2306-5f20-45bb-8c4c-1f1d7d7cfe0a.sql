CREATE INDEX IF NOT EXISTS idx_commands_pending_poll 
ON public.commands (farm_id, status, priority ASC, created_at ASC) 
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_commands_created_at 
ON public.commands (created_at);

CREATE INDEX IF NOT EXISTS idx_agent_logs_created_at 
ON public.agent_logs (created_at);

ANALYZE public.commands;
ANALYZE public.agent_logs;