ALTER TABLE public.agent_logs DROP CONSTRAINT agent_logs_category_check;

ALTER TABLE public.agent_logs ADD CONSTRAINT agent_logs_category_check
  CHECK (category = ANY (ARRAY['tx'::text, 'rx'::text, 'serial'::text, 'cloud'::text, 'system'::text, 'timeout'::text, 'safety'::text]));