DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'agent_cmd_kind' AND e.enumlabel = 'agent_restart'
  ) THEN
    ALTER TYPE public.agent_cmd_kind ADD VALUE 'agent_restart';
  END IF;
END$$;