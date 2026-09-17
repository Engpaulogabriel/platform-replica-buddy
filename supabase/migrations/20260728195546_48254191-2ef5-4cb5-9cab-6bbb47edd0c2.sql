-- Migration 1: log_manual_command_to_automation_log agora dispara em timeout/error
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
  -- Dispara em executed, timeout e error (antes só executed)
  IF NEW.type <> 'manual'::public.command_type
     OR NEW.status NOT IN ('executed'::public.command_status,
                           'timeout'::public.command_status,
                           'error'::public.command_status)
     OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT name INTO v_equipment_name
  FROM public.equipments
  WHERE id = NEW.equipment_id;

  IF NEW.created_by IS NULL THEN
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
    'command_status', NEW.status,
    'frame', NEW.frame,
    'systemic', NEW.created_by IS NULL
  );

  INSERT INTO public.automation_log (
    farm_id, user_id, user_email, equipment_id, equipment_name,
    action, origin, actor_label, result, occurred_at,
    source_device, details, client_event_id
  ) VALUES (
    NEW.farm_id, NEW.created_by, v_email, NEW.equipment_id,
    COALESCE(v_equipment_name, 'Equipamento'),
    v_action, v_origin, v_actor_label,
    CASE WHEN NEW.status IN ('error'::public.command_status, 'timeout'::public.command_status, 'cancelled'::public.command_status)
         THEN 'fail'::public.event_result
         ELSE 'success'::public.event_result END,
    COALESCE(NEW.responded_at, NEW.sent_at, NEW.created_at, now()),
    NEW.source_device, v_details, NEW.client_event_id
  )
  ON CONFLICT (farm_id, client_event_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- Migration 2: origin='local' grava actor_label='Sistema' + backfill
CREATE OR REPLACE FUNCTION public.log_equipment_state_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_saida_idx int;
  v_old_running boolean;
  v_new_running boolean;
  v_origin public.event_origin;
  v_action public.event_action;
  v_dup_count int;
  v_actor_label text;
BEGIN
  IF NEW.type NOT IN ('poco', 'bombeamento') THEN
    RETURN NEW;
  END IF;

  v_saida_idx := COALESCE(NEW.saida, 1);

  IF OLD.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_old_running := substring(OLD.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF OLD.last_outputs_state ~ '^[01]$' THEN
    v_old_running := OLD.last_outputs_state = '1';
  ELSE
    v_old_running := false;
  END IF;

  IF NEW.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_new_running := substring(NEW.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF NEW.last_outputs_state ~ '^[01]$' THEN
    v_new_running := NEW.last_outputs_state = '1';
  ELSE
    v_new_running := false;
  END IF;

  IF v_old_running IS NOT DISTINCT FROM v_new_running THEN
    RETURN NEW;
  END IF;

  v_origin := CASE
    WHEN NEW.last_actuation_origin = 'local' THEN 'local'::public.event_origin
    WHEN NEW.last_actuation_origin = 'remote' THEN 'remote'::public.event_origin
    ELSE 'reading'::public.event_origin
  END;

  IF v_origin = 'remote'::public.event_origin THEN
    RETURN NEW;
  END IF;

  v_action := CASE WHEN v_new_running THEN 'turn_on'::public.event_action ELSE 'turn_off'::public.event_action END;

  SELECT count(*) INTO v_dup_count
  FROM public.automation_log
  WHERE equipment_id = NEW.id
    AND action = v_action
    AND occurred_at > now() - interval '5 seconds';

  IF v_dup_count > 0 THEN
    RETURN NEW;
  END IF;

  v_actor_label := CASE WHEN v_origin = 'local'::public.event_origin THEN 'Sistema' ELSE NULL END;

  INSERT INTO public.automation_log (
    farm_id, equipment_id, equipment_name,
    occurred_at, origin, action, result,
    new_state, client_event_id, source_device, actor_label, details
  )
  VALUES (
    NEW.farm_id, NEW.id, NEW.name,
    COALESCE(NEW.last_communication, now()),
    v_origin, v_action, 'success'::public.event_result,
    NEW.last_outputs_state,
    gen_random_uuid(),
    'auto-trigger',
    v_actor_label,
    jsonb_build_object('actuation_origin', NEW.last_actuation_origin)
  );

  RETURN NEW;
END;
$function$;

-- Backfill: registros locais antigos
UPDATE public.automation_log
   SET actor_label = 'Sistema'
 WHERE origin = 'local'::public.event_origin
   AND (actor_label = 'Acionamento Local' OR actor_label IS NULL OR btrim(actor_label) = '');