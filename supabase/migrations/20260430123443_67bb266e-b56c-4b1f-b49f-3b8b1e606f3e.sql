-- 1) Trigger de log de comandos manuais
CREATE OR REPLACE FUNCTION public.log_manual_command_to_automation_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_equipment_name text;
  v_action public.event_action;
  v_email text;
  v_details jsonb;
BEGIN
  IF NEW.type <> 'manual'::public.command_type
     OR NEW.status <> 'executed'::public.command_status
     OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF NEW.created_by IS NULL THEN
    RAISE EXCEPTION 'Comando manual remoto sem usuário não pode ser registrado no relatório de automação';
  END IF;

  SELECT name INTO v_equipment_name
  FROM public.equipments
  WHERE id = NEW.equipment_id;

  SELECT email INTO v_email
  FROM public.profiles
  WHERE id = NEW.created_by;

  v_action := CASE
    WHEN NEW.frame LIKE '%{1}%' OR NEW.frame LIKE '%{01}%' OR NEW.frame LIKE '%{001}%' OR NEW.frame LIKE '%{0001}%' OR NEW.frame LIKE '%{00001}%' OR NEW.frame LIKE '%{000001}%'
      THEN 'turn_on'::public.event_action
    ELSE 'turn_off'::public.event_action
  END;

  v_details := jsonb_build_object(
    'type', 'manual',
    'command_id', NEW.id,
    'frame', NEW.frame
  );

  INSERT INTO public.automation_log (
    farm_id,
    user_id,
    user_email,
    equipment_id,
    equipment_name,
    action,
    origin,
    result,
    occurred_at,
    source_device,
    details,
    client_event_id
  ) VALUES (
    NEW.farm_id,
    NEW.created_by,
    v_email,
    NEW.equipment_id,
    COALESCE(v_equipment_name, 'Equipamento'),
    v_action,
    'remote'::public.event_origin,
    CASE WHEN NEW.status IN ('error'::public.command_status, 'timeout'::public.command_status, 'cancelled'::public.command_status)
         THEN 'fail'::public.event_result
         ELSE 'success'::public.event_result END,
    COALESCE(NEW.responded_at, NEW.sent_at, NEW.created_at, now()),
    NEW.source_device,
    v_details,
    NEW.client_event_id
  )
  ON CONFLICT (farm_id, client_event_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- 2) Relatórios consolidados — remove 'failed' do filtro IN (já tem 'error' e 'timeout')
DROP FUNCTION IF EXISTS public.platform_reports_consolidated(timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.platform_reports_consolidated(_from timestamptz, _to timestamptz)
RETURNS TABLE(
  farm_id uuid, farm_name text, city text, state text, plan text,
  equipments_count integer, users_count integer, agent_online boolean,
  runtime_hours numeric, commands_total integer, commands_success integer,
  commands_failed integer, automations_fired integer, alerts_critical integer,
  alerts_warning integer, last_heartbeat timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    f.id AS farm_id,
    f.name AS farm_name,
    f.city,
    f.state,
    f.plan,
    COALESCE((SELECT COUNT(*)::int FROM public.equipments e WHERE e.farm_id = f.id), 0) AS equipments_count,
    COALESCE((SELECT COUNT(DISTINCT ur.user_id)::int FROM public.user_roles ur WHERE ur.farm_id = f.id), 0) AS users_count,
    COALESCE((SELECT sh.agent_status = 'online' FROM public.site_health sh WHERE sh.farm_id = f.id ORDER BY sh.last_heartbeat DESC LIMIT 1), false) AS agent_online,
    COALESCE((SELECT ROUND(SUM(pr.duration_seconds)::numeric / 3600, 2)
              FROM public.pump_runtime pr
              WHERE pr.farm_id = f.id
                AND pr.started_at >= _from
                AND pr.started_at < _to
                AND pr.duration_seconds IS NOT NULL), 0) AS runtime_hours,
    COALESCE((SELECT COUNT(*)::int FROM public.commands c
              WHERE c.farm_id = f.id AND c.created_at >= _from AND c.created_at < _to), 0) AS commands_total,
    COALESCE((SELECT COUNT(*)::int FROM public.commands c
              WHERE c.farm_id = f.id AND c.created_at >= _from AND c.created_at < _to
                AND c.status::text = 'executed'), 0) AS commands_success,
    COALESCE((SELECT COUNT(*)::int FROM public.commands c
              WHERE c.farm_id = f.id AND c.created_at >= _from AND c.created_at < _to
                AND c.status::text IN ('timeout','error','cancelled')), 0) AS commands_failed,
    COALESCE((SELECT COUNT(*)::int FROM public.automation_log al
              WHERE al.farm_id = f.id AND al.occurred_at >= _from AND al.occurred_at < _to
                AND al.origin::text = 'auto'), 0) AS automations_fired,
    COALESCE((SELECT COUNT(*)::int FROM public.agent_logs ag
              WHERE ag.farm_id = f.id AND ag.created_at >= _from AND ag.created_at < _to
                AND ag.level = 'error'), 0) AS alerts_critical,
    COALESCE((SELECT COUNT(*)::int FROM public.agent_logs ag
              WHERE ag.farm_id = f.id AND ag.created_at >= _from AND ag.created_at < _to
                AND ag.level = 'warn'), 0) AS alerts_warning,
    (SELECT sh.last_heartbeat FROM public.site_health sh WHERE sh.farm_id = f.id ORDER BY sh.last_heartbeat DESC LIMIT 1) AS last_heartbeat
  FROM public.farms f
  WHERE public.is_platform_staff(auth.uid());
$$;