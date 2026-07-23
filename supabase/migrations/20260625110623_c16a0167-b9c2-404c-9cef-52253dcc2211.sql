ALTER TABLE public.automation_execution_log
  ADD COLUMN IF NOT EXISTS failure_reason text;