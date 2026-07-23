-- Função: detecta comandos do automático que não receberam resposta no prazo
-- e registra uma entrada de falha no automation_log automaticamente.
-- Roda como SECURITY DEFINER para ser invocada pelo edge function automation-tick (sem auth de usuário).
CREATE OR REPLACE FUNCTION public.mark_automation_command_failures()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_failed_count integer := 0;
  r record;
BEGIN
  -- 1) Marca como timeout os comandos do automático (source_device='cloud-automation')
  --    que estão "sent" há mais tempo que seu próprio timeout_ms.
  --    Retorna cada um para registrarmos a falha no automation_log.
  FOR r IN
    WITH expired AS (
      UPDATE public.commands c
      SET status = 'timeout',
          responded_at = now(),
          error_message = COALESCE(c.error_message, 'Sem resposta dentro do timeout (automático)')
      WHERE c.source_device = 'cloud-automation'
        AND c.status IN ('sent', 'pending')
        AND (
          (c.status = 'sent' AND c.sent_at < now() - (c.timeout_ms || ' milliseconds')::interval)
          OR (c.status = 'pending' AND c.created_at < now() - interval '10 minutes')
        )
      RETURNING c.id, c.farm_id, c.equipment_id, c.client_event_id, c.frame, c.created_at
    )
    SELECT
      e.id            AS command_id,
      e.farm_id,
      e.equipment_id,
      e.client_event_id,
      e.frame,
      e.created_at,
      eq.name         AS equipment_name
    FROM expired e
    LEFT JOIN public.equipments eq ON eq.id = e.equipment_id
  LOOP
    -- Idempotência: só insere se ainda não existe um log de falha para este client_event_id
    IF NOT EXISTS (
      SELECT 1
      FROM public.automation_log al
      WHERE al.client_event_id = r.client_event_id
    ) THEN
      INSERT INTO public.automation_log (
        client_event_id,
        farm_id,
        equipment_id,
        equipment_name,
        action,
        origin,
        result,
        occurred_at,
        source_device,
        details,
        user_email,
        user_id
      ) VALUES (
        r.client_event_id,
        r.farm_id,
        r.equipment_id,
        COALESCE(r.equipment_name, 'Bomba'),
        -- Heurística simples: se algum dígito do payload do frame indicava ligar (1),
        -- consideramos turn_on; senão turn_off. O frame tem o formato {XXXXXX}.
        CASE
          WHEN r.frame ~ '\{0*[1-9]' OR r.frame ~ '\{[0-9]*1' THEN 'turn_on'::event_action
          ELSE 'turn_off'::event_action
        END,
        'auto'::event_origin,
        'fail'::event_result,
        r.created_at,
        'cloud-automation',
        jsonb_build_object('reason', 'timeout', 'user_name', 'Sistema (Automático)'),
        NULL,
        NULL
      );
      v_failed_count := v_failed_count + 1;
    END IF;
  END LOOP;

  RETURN v_failed_count;
END;
$$;

-- Permite que o role anon/service_role chame (edge function usa service_role).
GRANT EXECUTE ON FUNCTION public.mark_automation_command_failures() TO anon, authenticated, service_role;