ALTER TYPE public.agent_cmd_kind ADD VALUE IF NOT EXISTS 'start_log_stream';
ALTER TYPE public.agent_cmd_kind ADD VALUE IF NOT EXISTS 'renew_log_stream';
ALTER TYPE public.agent_cmd_kind ADD VALUE IF NOT EXISTS 'stop_log_stream';