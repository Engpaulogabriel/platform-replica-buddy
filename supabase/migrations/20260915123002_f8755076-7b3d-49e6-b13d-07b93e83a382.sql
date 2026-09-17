ALTER TYPE public.agent_cmd_kind ADD VALUE IF NOT EXISTS 'set_backend';
ALTER TYPE public.agent_cmd_kind ADD VALUE IF NOT EXISTS 'rollback_backend';