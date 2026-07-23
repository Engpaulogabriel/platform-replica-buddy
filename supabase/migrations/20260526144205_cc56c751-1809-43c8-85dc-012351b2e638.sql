
-- ============================================================
-- CORREÇÃO 1: Remover purge_on_commands_for_offline_pumps
-- Esta função zerava desired_running automaticamente — proibido.
-- ============================================================
DROP FUNCTION IF EXISTS public.purge_on_commands_for_offline_pumps();

-- ============================================================
-- CORREÇÃO 2: Reescrever enqueue_protective_off_for_offline_pumps
--  • Threshold: 30 minutos (era 15)
--  • Envia TX OFF de segurança pela serial
--  • NÃO altera desired_running (permanece true; agente religa via polling)
--  • NÃO insere em automation_log (não é ação de usuário)
--  • Mantém log em agent_logs (técnico) para rastreabilidade
--  • Só "fecha" o ciclo quando o agente confirmar RX (lógica natural já existente)
-- ============================================================
CREATE OR REPLACE FUNCTION public.enqueue_protective_off_for_offline_pumps()
 RETURNS TABLE(farm_id uuid, equipment_id uuid, equipment_name text, command_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_eq RECORD;
  v_offline_threshold interval := interval '30 minutes';
  v_tsnn text;
  v_frame text;
  v_payload text;
  v_total int;
  v_cmd_id uuid;
  v_state text;
  v_idx int;
  v_was_on boolean;
  v_existing uuid;
BEGIN
  FOR v_eq IN
    SELECT
      e.id, e.farm_id, e.name, e.hw_id, e.saida, e.last_outputs_state,
      e.last_communication, e.desired_running,
      p.hw_id AS plc_hw_id,
      COALESCE(p.output_count, 1) AS plc_total
    FROM public.equipments e
    LEFT JOIN public.plc_groups p ON p.id = e.plc_group_id
    WHERE e.active = true
      AND e.type IN ('poco', 'bombeamento')
      AND (e.last_communication IS NULL OR e.last_communication < now() - v_offline_threshold)
  LOOP
    v_state := COALESCE(v_eq.last_outputs_state, '');
    v_idx := COALESCE(v_eq.saida, 1) - 1;
    v_was_on := false;

    IF v_state ~ '^[01]{6}$' AND v_idx >= 0 AND v_idx < 6 THEN
      v_was_on := substring(v_state from v_idx + 1 for 1) = '1';
    ELSIF v_state ~ '^[01]$' THEN
      v_was_on := v_state = '1';
    END IF;

    -- Só age se o último estado conhecido era LIGADA
    IF NOT v_was_on THEN
      CONTINUE;
    END IF;

    v_tsnn := COALESCE(v_eq.plc_hw_id, substring(v_eq.hw_id from 1 for 4));
    IF v_tsnn IS NULL OR length(v_tsnn) = 0 THEN CONTINUE; END IF;

    -- Idempotência: se já tem OFF de proteção pendente, não duplica
    SELECT c.id INTO v_existing
    FROM public.commands c
    WHERE c.farm_id = v_eq.farm_id
      AND c.equipment_id = v_eq.id
      AND c.status IN ('pending', 'sent')
      AND c.source_device = 'cloud-protective-off'
    LIMIT 1;
    IF v_existing IS NOT NULL THEN CONTINUE; END IF;

    v_total := GREATEST(v_eq.plc_total, COALESCE(v_eq.saida, 1));
    v_payload := public.renov_combined_payload(
      v_eq.last_outputs_state, COALESCE(v_eq.saida, 1), false, v_total
    );
    v_frame := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';

    INSERT INTO public.commands (
      farm_id, equipment_id, plc_hw_id, type, priority, frame,
      timeout_ms, source_device, status
    ) VALUES (
      v_eq.farm_id, v_eq.id, v_tsnn, 'manual', 0, v_frame,
      7200000, 'cloud-protective-off', 'pending'
    )
    RETURNING id INTO v_cmd_id;

    -- IMPORTANTE: NÃO alteramos desired_running aqui.
    -- O agente envia o TX OFF; quando o RX confirmar bomba desligada,
    -- e se desired_running ainda for true, o agente religará no próximo
    -- ciclo (comportamento desejado pelo usuário/automação).

    INSERT INTO public.agent_logs (farm_id, level, category, message)
    VALUES (
      v_eq.farm_id, 'warn', 'safety',
      format('[PROTEÇÃO] Bomba %s offline > 30 min com último estado=LIGADA — TX OFF de segurança enfileirado (cmd %s). desired_running preservado.',
             v_eq.name, v_cmd_id)
    );

    farm_id := v_eq.farm_id; equipment_id := v_eq.id;
    equipment_name := v_eq.name; command_id := v_cmd_id;
    RETURN NEXT;
  END LOOP;
  RETURN;
END;
$function$;

-- ============================================================
-- CORREÇÃO 3: Trigger BEFORE INSERT em automation_log
-- Regra: origin='remote' SEMPRE requer user_id real, exceto
-- automações da nuvem (source_device LIKE 'cloud-%').
-- Qualquer outro insert remote+sem user_id é DESCARTADO.
-- "Sistema" só é válido com origin='local'.
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_automation_log_actor_rule()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Permite explicitamente automações da nuvem (têm origem identificada e auditada).
  IF NEW.source_device IS NOT NULL AND NEW.source_device LIKE 'cloud-%' THEN
    RETURN NEW;
  END IF;

  -- Bloqueia remote sem user_id real → comando fantasma/bug.
  IF NEW.origin = 'remote'::public.event_origin AND NEW.user_id IS NULL THEN
    -- Se veio do agente serial, reclassifica como acionamento local
    -- (PLC reportou mudança de estado sem comando humano = local).
    IF NEW.source_device IS NOT NULL AND NEW.source_device LIKE 'serial-bridge%' THEN
      NEW.origin := 'local'::public.event_origin;
      RETURN NEW;
    END IF;
    -- Caso contrário, descarta o insert silenciosamente.
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_automation_log_actor ON public.automation_log;
CREATE TRIGGER trg_enforce_automation_log_actor
  BEFORE INSERT ON public.automation_log
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_automation_log_actor_rule();
