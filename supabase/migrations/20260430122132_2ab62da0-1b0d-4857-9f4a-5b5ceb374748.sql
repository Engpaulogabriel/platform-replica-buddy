-- Função de sweep: limpa pending_command_id vencido
CREATE OR REPLACE FUNCTION public.sweep_stuck_pump_commands()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count int;
BEGIN
  -- Limpa equipamentos cujo bloqueio já venceu (sem resposta dentro de ~120s)
  UPDATE public.equipments
  SET pending_command_id = NULL,
      command_blocked_until = NULL
  WHERE pending_command_id IS NOT NULL
    AND (command_blocked_until IS NULL OR command_blocked_until < now());

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Como segurança extra, marca como timeout qualquer command em sent/pending
  -- há mais de 3 minutos (sweep paralelo)
  UPDATE public.commands
  SET status = 'timeout'::public.command_status,
      responded_at = now(),
      error_message = COALESCE(error_message, 'Timeout (sweep automático)')
  WHERE status IN ('pending'::public.command_status, 'sent'::public.command_status)
    AND created_at < now() - interval '3 minutes';

  RETURN v_count;
END;
$$;

-- Garante extensões
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Remove agendamento antigo se existir
DO $$
BEGIN
  PERFORM cron.unschedule('sweep-stuck-pump-commands');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Agenda sweep a cada minuto
SELECT cron.schedule(
  'sweep-stuck-pump-commands',
  '* * * * *',
  $$ SELECT public.sweep_stuck_pump_commands(); $$
);