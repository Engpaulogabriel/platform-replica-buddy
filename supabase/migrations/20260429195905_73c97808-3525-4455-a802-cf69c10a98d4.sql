TRUNCATE TABLE public.agent_logs;
DELETE FROM public.commands WHERE status IN ('executed', 'timeout', 'cancelled', 'error');
ANALYZE public.agent_logs;
ANALYZE public.commands;