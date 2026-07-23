ALTER TABLE public.automation_log
ADD COLUMN IF NOT EXISTS actor_label text;

CREATE OR REPLACE FUNCTION public.resolve_automation_actor_label(
  _user_id uuid,
  _user_email text,
  _origin public.event_origin,
  _details jsonb,
  _source_device text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_name text;
  v_profile_email text;
  v_type text;
  v_last_origin text;
BEGIN
  IF _user_id IS NOT NULL THEN
    SELECT NULLIF(btrim(full_name), ''), NULLIF(btrim(email), '')
      INTO v_profile_name, v_profile_email
    FROM public.profiles
    WHERE id = _user_id;

    RETURN COALESCE(
      v_profile_name,
      NULLIF(btrim(_user_email), ''),
      v_profile_email,
      'Usuário identificado'
    );
  END IF;

  v_type := lower(COALESCE(
    _details->>'type',
    _details->>'command_type',
    _details->>'commandType',
    CASE
      WHEN COALESCE(_source_device, '') LIKE 'automation-tick%' THEN 'automation'
      WHEN COALESCE(_source_device, '') LIKE 'platform-scheduler%' THEN 'polling'
      ELSE NULL
    END,
    ''
  ));

  v_last_origin := lower(COALESCE(
    _details->>'last_actuation_origin',
    _details->>'lastActuationOrigin',
    ''
  ));

  IF _origin = 'local'::public.event_origin OR v_last_origin = 'local' THEN
    RETURN 'Sistema';
  END IF;

  IF _origin IN ('auto'::public.event_origin, 'reading'::public.event_origin, 'system'::public.event_origin)
     OR v_type IN ('polling', 'automation') THEN
    RETURN 'Automação';
  END IF;

  IF v_type = 'manual' OR _origin = 'remote'::public.event_origin THEN
    RETURN 'Usuário não identificado (comando antigo)';
  END IF;

  RETURN 'Remoto (não identificado)';
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

UPDATE public.automation_log
SET actor_label = public.resolve_automation_actor_label(user_id, user_email, origin, details, source_device)
WHERE actor_label IS NULL
   OR btrim(actor_label) = ''
   OR user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.log_manual_command_to_automation_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eq_name text;
  v_action  event_action;
  v_result  event_result;
  v_email   text;
  v_name    text;
  v_payload text;
  v_saida   smallint;
  v_bit     char;
  v_details jsonb;
BEGIN
  IF NEW.type <> 'manual' THEN RETURN NEW; END IF;
  IF NEW.status <> 'executed' THEN RETURN NEW; END IF;
  IF OLD.status = 'executed' THEN RETURN NEW; END IF;

  SELECT name, COALESCE(saida, 1)
    INTO v_eq_name, v_saida
  FROM public.equipments WHERE id = NEW.equipment_id;
  IF v_eq_name IS NULL THEN RETURN NEW; END IF;

  v_payload := substring(NEW.frame from '\{([01]+)\}');
  IF v_payload IS NULL OR length(v_payload) < v_saida THEN RETURN NEW; END IF;
  v_bit := substr(v_payload, v_saida, 1);
  v_action := CASE WHEN v_bit = '1' THEN 'turn_on'::event_action ELSE 'turn_off'::event_action END;
  v_result := 'success'::event_result;

  IF NEW.created_by IS NOT NULL THEN
    SELECT email, full_name INTO v_email, v_name
    FROM public.profiles WHERE id = NEW.created_by;
  END IF;

  v_details := jsonb_build_object('type', 'manual', 'command_type', 'manual');
  IF v_name IS NOT NULL THEN
    v_details := v_details || jsonb_build_object('user_name', v_name);
  END IF;

  INSERT INTO public.automation_log (
    client_event_id,
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
    actor_label
  ) VALUES (
    NEW.id,
    NEW.farm_id,
    NEW.created_by,
    v_email,
    NEW.equipment_id,
    v_eq_name,
    v_action,
    'remote'::event_origin,
    v_result,
    COALESCE(NEW.responded_at, now()),
    NEW.source_device,
    v_details,
    public.resolve_automation_actor_label(NEW.created_by, v_email, 'remote'::event_origin, v_details, NEW.source_device)
  )
  ON CONFLICT (farm_id, client_event_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_manual_command ON public.commands;
CREATE TRIGGER trg_log_manual_command
AFTER UPDATE ON public.commands
FOR EACH ROW
WHEN (NEW.type = 'manual' AND NEW.status = 'executed' AND OLD.status IS DISTINCT FROM 'executed')
EXECUTE FUNCTION public.log_manual_command_to_automation_log();