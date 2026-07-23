ALTER TABLE public.commands DROP CONSTRAINT IF EXISTS commands_priority_chk;

ALTER TABLE public.commands
ADD CONSTRAINT commands_priority_chk
CHECK (priority >= 0 AND priority <= 10);