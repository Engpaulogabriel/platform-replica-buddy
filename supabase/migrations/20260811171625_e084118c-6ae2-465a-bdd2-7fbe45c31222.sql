DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'agent_cmd_kind' AND e.enumlabel = 'update_bridge'
  ) THEN
    ALTER TYPE public.agent_cmd_kind ADD VALUE 'update_bridge';
  END IF;
END $$;