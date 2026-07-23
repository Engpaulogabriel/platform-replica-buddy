ALTER TABLE public.automation_log
ADD COLUMN IF NOT EXISTS actor_label text;

ALTER TABLE public.automation_log
DROP CONSTRAINT IF EXISTS automation_log_remote_requires_user;

ALTER TABLE public.automation_log
ADD CONSTRAINT automation_log_remote_requires_user
CHECK (origin <> 'remote'::public.event_origin OR user_id IS NOT NULL);

CREATE OR REPLACE FUNCTION public.resolve_automation_actor_label(
  _user_id uuid,
  _user_email text DEFAULT NULL,
  _origin public.event_origin DEFAULT NULL,
  _details jsonb DEFAULT NULL,
  _source_device text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name text;
  v_profile_email text;
BEGIN
  IF _user_id IS NOT NULL THEN
    SELECT NULLIF(btrim(full_name), ''), NULLIF(btrim(email), '')
      INTO v_full_name, v_profile_email
    FROM public.profiles
    WHERE id = _user_id;

    RETURN COALESCE(
      v_full_name,
      v_profile_email,
      NULLIF(btrim(_user_email), ''),
      'Usuário'
    );
  END IF;

  RETURN 'Sistema';
END;
$$;

CREATE OR REPLACE FUNCTION public.set_automation_actor_label()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.actor_label := public.resolve_automation_actor_label(
    NEW.user_id,
    NEW.user_email,
    NEW.origin,
    NEW.details,
    NEW.source_device
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_automation_actor_label ON public.automation_log;
CREATE TRIGGER trg_set_automation_actor_label
BEFORE INSERT OR UPDATE OF user_id, user_email, origin, details, source_device, actor_label
ON public.automation_log
FOR EACH ROW
EXECUTE FUNCTION public.set_automation_actor_label();

CREATE OR REPLACE FUNCTION public.log_manual_command_to_automation_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    CASE WHEN NEW.status = 'failed'::public.command_status THEN 'fail'::public.event_result ELSE 'success'::public.event_result END,
    COALESCE(NEW.responded_at, NEW.sent_at, NEW.created_at, now()),
    NEW.source_device,
    v_details,
    NEW.client_event_id
  )
  ON CONFLICT (farm_id, client_event_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_manual_command ON public.commands;
CREATE TRIGGER trg_log_manual_command
AFTER UPDATE ON public.commands
FOR EACH ROW
WHEN (NEW.type = 'manual'::public.command_type AND NEW.status = 'executed'::public.command_status)
EXECUTE FUNCTION public.log_manual_command_to_automation_log();

REVOKE ALL ON FUNCTION public.resolve_automation_actor_label(uuid, text, public.event_origin, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_automation_actor_label(uuid, text, public.event_origin, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.set_automation_actor_label() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_automation_actor_label() FROM anon;
REVOKE ALL ON FUNCTION public.log_manual_command_to_automation_log() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_manual_command_to_automation_log() FROM anon;