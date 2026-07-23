-- Função: cancela comandos "ligar" e força desired_running=false em bombas
-- que ficaram offline (sem comunicação > 5 min) enquanto o sistema esperava ligar.
-- Garante que ao voltar a comunicação, a bomba não religue sozinha por polling.
CREATE OR REPLACE FUNCTION public.purge_on_commands_for_offline_pumps()
RETURNS TABLE(farm_id uuid, equipment_id uuid, equipment_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_eq RECORD;
  v_offline_threshold interval := interval '5 minutes';
BEGIN
  FOR v_eq IN
    SELECT e.id, e.farm_id, e.name, e.last_communication, e.pending_command_id, e.desired_running
    FROM public.equipments e
    WHERE e.active = true
      AND e.type IN ('poco', 'bombeamento')
      AND COALESCE(e.desired_running, false) = true
      AND (
        e.last_communication IS NULL
        OR e.last_communication < now() - v_offline_threshold
      )
  LOOP
    -- Cancela comandos manuais de "ligar" pendentes/enviados para este equipamento
    UPDATE public.commands c
    SET status = 'cancelled',
        responded_at = now(),
        error_message = 'Bomba offline > 5 min — comando de ligar cancelado para evitar religamento automatico'
    WHERE c.farm_id = v_eq.farm_id
      AND c.equipment_id = v_eq.id
      AND c.status IN ('pending', 'sent')
      AND c.type = 'manual'
      AND c.frame ~ '\{[01]*1[01]*\}';

    -- Força desired_running=false e limpa pending para que polling envie {0}
    UPDATE public.equipments
    SET desired_running = false,
        pending_command_id = NULL,
        updated_at = now()
    WHERE id = v_eq.id
      AND farm_id = v_eq.farm_id;

    -- Log de seguranca
    INSERT INTO public.agent_logs (farm_id, level, category, message)
    VALUES (
      v_eq.farm_id,
      'warn',
      'safety',
      format('Bomba %s ficou offline > 5 min com comando de ligar ativo — comando cancelado e desired_running zerado. Sera necessario reenviar comando manual quando voltar a comunicacao.', v_eq.name)
    );

    farm_id := v_eq.farm_id;
    equipment_id := v_eq.id;
    equipment_name := v_eq.name;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$function$;