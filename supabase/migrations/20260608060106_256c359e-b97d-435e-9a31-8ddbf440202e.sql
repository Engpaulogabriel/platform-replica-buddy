-- Rollback 1-clique support
ALTER TABLE public.farms ADD COLUMN IF NOT EXISTS agent_previous_version text;

ALTER TABLE public.agent_update_status ADD COLUMN IF NOT EXISTS auto_rollback_detected boolean NOT NULL DEFAULT false;

-- Add 'force_rollback' to agent_cmd_kind enum if not present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'agent_cmd_kind' AND e.enumlabel = 'force_rollback'
  ) THEN
    ALTER TYPE public.agent_cmd_kind ADD VALUE 'force_rollback';
  END IF;
END$$;