
CREATE OR REPLACE FUNCTION public.enqueue_protective_off_for_offline_pumps()
RETURNS TABLE(farm_id uuid, equipment_id uuid, equipment_name text, command_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_eq RECORD;
  v_offline_threshold interval := interval '15 minutes';
  v_tsnn text;
  v_frame text;
  v_cmd_id uuid;
  v_state text;
  v_idx int;
  v_was_on boolean;
  v_existing uuid;
BEGIN
  FOR v_eq IN
    SELECT
      e.id,
      e.farm_id,
      e.name,
      e.hw_id,
      e.saida,
      e.last_outputs_state,
      e.last_communication,
      e.desired_running,
      p.hw_id AS plc_hw_id
    FROM public.equipments e
    LEFT JOIN public.plc_groups p ON p.id = e.plc_group_id
    WHERE e.active = true
      AND e.type IN ('poco', 'bombeamento')
      AND (
        e.last_communication IS NULL
        OR e.last_communication < now() - v_offline_threshold
      )
  LOOP
    -- Determina se o último estado conhecido era LIGADO para esta saída
    v_state := COALESCE(v_eq.last_outputs_state, '');
    v_idx := COALESCE(v_eq.saida, 1) - 1;
    v_was_on := false;

    IF v_state ~ '^[01]{6}$' AND v_idx >= 0 AND v_idx < 6 THEN
      v_was_on := substring(v_state from v_idx + 1 for 1) = '1';
    ELSIF v_state ~ '^[01]$' THEN
      v_was_on := v_state = '1';
    END IF;

    -- Também protege caso desired_running esteja true (intenção pendente)
    IF NOT v_was_on AND NOT COALESCE(v_eq.desired_running, false) THEN
      CONTINUE;
    END IF;

    -- TSNN: usa hw_id do PLC se houver, senão primeiros 4 chars do hw_id do equipamento
    v_tsnn := COALESCE(v_eq.plc_hw_id, substring(v_eq.hw_id from 1 for 4));
    IF v_tsnn IS NULL OR length(v_tsnn) = 0 THEN
      CONTINUE;
    END IF;

    -- Evita duplicar: já existe um OFF pendente/enviado para esta bomba?
    SELECT c.id INTO v_existing
    FROM public.commands c
    WHERE c.farm_id = v_eq.farm_id
      AND c.equipment_id = v_eq.id
      AND c.status IN ('pending', 'sent')
      AND c.frame ~ '\{0+\}'
      AND c.frame !~ '\{[01]*1[01]*\}'
    LIMIT 1;

    IF v_existing IS NOT NULL THEN
      CONTINUE;
    END IF;

    -- Cancela qualquer comando ON pendente que ainda esteja na fila para esta bomba
    UPDATE public.commands c
    SET status = 'cancelled',
        responded_at = now(),
        error_message = 'Cancelado por proteção offline — substituido por OFF de segurança'
    WHERE c.farm_id = v_eq.farm_id
      AND c.equipment_id = v_eq.id
      AND c.status IN ('pending', 'sent')
      AND c.type = 'manual'
      AND c.frame ~ '\{[01]*1[01]*\}';

    -- Frame OFF: payload {0} (1 dígito) — agente expande pela saida cadastrada
    v_frame := '[' || v_tsnn || '_1_]{0}[' || v_tsnn || '_ETX_]' || E'\r';

    -- Enfileira OFF com timeout longo (2 horas) — espera bomba voltar
    INSERT INTO public.commands (
      farm_id, equipment_id, plc_hw_id, type, priority, frame,
      timeout_ms, source_device, status
    ) VALUES (
      v_eq.farm_id, v_eq.id, v_tsnn, 'manual', 0, v_frame,
      7200000, 'cloud-protective-off', 'pending'
    )
    RETURNING id INTO v_cmd_id;

    -- Zera intenção e atualiza pending_command_id
    UPDATE public.equipments
    SET desired_running = false,
        pending_command_id = v_cmd_id,
        updated_at = now()
    WHERE id = v_eq.id
      AND farm_id = v_eq.farm_id;

    INSERT INTO public.agent_logs (farm_id, level, category, message)
    VALUES (
      v_eq.farm_id,
      'warn',
      'safety',
      format(
        'Bomba %s offline > 15 min com último estado=LIGADA — enfileirado TX OFF de segurança (cmd %s). Será entregue assim que a bomba voltar a se comunicar, evitando que continue ligada sem comando.',
        v_eq.name, v_cmd_id
      )
    );

    farm_id := v_eq.farm_id;
    equipment_id := v_eq.id;
    equipment_name := v_eq.name;
    command_id := v_cmd_id;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$function$;
