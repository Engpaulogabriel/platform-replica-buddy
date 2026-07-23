DROP TRIGGER IF EXISTS trg_log_manual_command ON public.commands;
DROP FUNCTION IF EXISTS public.log_manual_command_to_automation_log() CASCADE;