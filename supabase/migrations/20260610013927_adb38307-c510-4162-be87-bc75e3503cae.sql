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
  v_origin public.event_origin;
  v_actor_label text;
BEGIN
  IF NEW.type <> 'manual'::public.command_type
     OR NEW.status <> 'executed'::public.command_status
     OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT name INTO v_equipment_name
  FROM public.equipments
  WHERE id = NEW.equipment_id;

  IF NEW.created_by IS NULL THEN
    -- Comando sistêmico (ex.: RESET automático da nuvem, proteção):
    -- registrar sem usuário, com origem 'system' e rótulo claro.
    v_origin := 'system'::public.event_origin;
    v_actor_label := 'Sistema (proteção automática)';
    v_email := NULL;
  ELSE
    v_origin := 'remote'::public.event_origin;
    v_actor_label := NULL;
    SELECT email INTO v_email
    FROM public.profiles
    WHERE id = NEW.created_by;
  END IF;

  v_action := CASE
    WHEN NEW.frame LIKE '%{1}%' OR NEW.frame LIKE '%{01}%' OR NEW.frame LIKE '%{001}%' OR NEW.frame LIKE '%{0001}%' OR NEW.frame LIKE '%{00001}%' OR NEW.frame LIKE '%{000001}%'
      THEN 'turn_on'::public.event_action
    ELSE 'turn_off'::public.event_action
  END;

  v_details := jsonb_build_object(
    'type', 'manual',
    'command_id', NEW.id,
    'frame', NEW.frame,
    'systemic', NEW.created_by IS NULL
  );

  INSERT INTO public.automation_log (
    farm_id,
    user_id,
    user_email,
    equipment_id,
    equipment_name,
    action,
    origin,
    actor_label,
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
    v_origin,
    v_actor_label,
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