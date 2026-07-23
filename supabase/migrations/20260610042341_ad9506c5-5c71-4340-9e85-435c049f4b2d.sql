CREATE OR REPLACE FUNCTION public.close_orphan_offline_cycles()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_count integer := 0;
BEGIN
  -- Último evento de comunicação por (farm_id, equipment_name).
  -- Os eventos vindos do agente não preenchem equipment_id, só equipment_name.
  WITH last_evt AS (
    SELECT DISTINCT ON (al.farm_id, al.equipment_name)
      al.farm_id,
      al.equipment_name,
      al.occurred_at,
      al.details->>'tipo_evento' AS tipo_evento
    FROM automation_log al
    WHERE al.action::text = 'status_read'
      AND al.details->>'tipo_evento' IN ('equipamento_offline','equipamento_online')
    ORDER BY al.farm_id, al.equipment_name, al.occurred_at DESC
  ),
  orphans AS (
    SELECT le.farm_id, le.equipment_name, e.id AS equipment_id,
           COALESCE(e.last_communication, now()) AS close_at
    FROM last_evt le
    JOIN equipments e
      ON e.farm_id = le.farm_id
     AND e.name = le.equipment_name
    WHERE le.tipo_evento = 'equipamento_offline'
      AND e.communication_status = 'online'
      AND e.active = true
      AND COALESCE(e.last_communication, now()) > le.occurred_at
  ),
  ins AS (
    INSERT INTO automation_log (
      farm_id, equipment_id, equipment_name, occurred_at,
      origin, action, result, details
    )
    SELECT
      o.farm_id, o.equipment_id, o.equipment_name, o.close_at,
      'system'::event_origin,
      'status_read'::event_action,
      'success'::event_result,
      jsonb_build_object(
        'tipo_evento', 'equipamento_online',
        'auto_closed', true,
        'reason', 'orphan_cycle_closed'
      )
    FROM orphans o
    RETURNING 1
  )
  SELECT count(*) INTO inserted_count FROM ins;

  RETURN inserted_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.close_orphan_offline_cycles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_orphan_offline_cycles() TO service_role;