DROP FUNCTION IF EXISTS public.resolve_automation_actor_label(uuid, text, public.event_origin, jsonb, text);
DROP FUNCTION IF EXISTS public.resolve_automation_actor_label(uuid, text);

CREATE OR REPLACE FUNCTION public.resolve_automation_actor_label(
  _user_id uuid,
  _user_email text,
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
  v_details_name text;
BEGIN
  IF _user_id IS NOT NULL THEN
    SELECT NULLIF(btrim(full_name), ''), NULLIF(btrim(email), '')
      INTO v_full_name, v_profile_email
    FROM public.profiles WHERE id = _user_id;
    RETURN COALESCE(v_full_name, v_profile_email, NULLIF(btrim(_user_email), ''), 'Usuário');
  END IF;

  IF NULLIF(btrim(_user_email), '') IS NOT NULL THEN
    RETURN btrim(_user_email);
  END IF;

  v_details_name := NULLIF(btrim((_details->>'user_name')), '');
  IF v_details_name IS NOT NULL THEN
    RETURN v_details_name;
  END IF;

  IF COALESCE(_source_device, '') IN ('cloud-automation', 'cloud-protective-off')
     OR _origin = 'auto'::public.event_origin THEN
    RETURN 'Automação';
  END IF;

  IF _origin = 'local'::public.event_origin THEN
    RETURN 'Acionamento Local';
  END IF;

  IF _origin = 'remote'::public.event_origin THEN
    RETURN 'Operador';
  END IF;

  RETURN 'Sistema';
END;
$$;

-- Recria trigger function que usa o resolver (assinatura compatível)
CREATE OR REPLACE FUNCTION public.set_automation_actor_label()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.actor_label := public.resolve_automation_actor_label(
    NEW.user_id, NEW.user_email, NEW.origin, NEW.details, NEW.source_device
  );
  RETURN NEW;
END;
$$;

-- Trigger de equipments: pula log duplicado quando comando manual com user já loga
CREATE OR REPLACE FUNCTION public.log_equipment_state_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_saida_idx int;
  v_old_running boolean;
  v_new_running boolean;
  v_origin public.event_origin;
  v_action public.event_action;
  v_dup_count int;
  v_recent_manual_user uuid;
  v_recent_cmd_source text;
  v_effective_source text;
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

  v_action := CASE WHEN v_new_running THEN 'turn_on'::public.event_action ELSE 'turn_off'::public.event_action END;

  IF v_origin = 'remote'::public.event_origin THEN
    SELECT created_by, source_device
      INTO v_recent_manual_user, v_recent_cmd_source
    FROM public.commands
    WHERE equipment_id = NEW.id
      AND type = 'manual'::public.command_type
      AND status = 'executed'::public.command_status
      AND responded_at > now() - interval '90 seconds'
    ORDER BY responded_at DESC
    LIMIT 1;

    IF v_recent_manual_user IS NOT NULL THEN
      RETURN NEW;
    END IF;

    v_effective_source := COALESCE(v_recent_cmd_source, 'auto-trigger');
  ELSE
    v_effective_source := 'auto-trigger';
  END IF;

  SELECT count(*) INTO v_dup_count
  FROM public.automation_log
  WHERE equipment_id = NEW.id
    AND action = v_action
    AND occurred_at > now() - interval '5 seconds';

  IF v_dup_count > 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.automation_log (
    farm_id, equipment_id, equipment_name,
    occurred_at, origin, action, result,
    new_state, client_event_id, source_device, details
  )
  VALUES (
    NEW.farm_id, NEW.id, NEW.name,
    COALESCE(NEW.last_communication, now()),
    v_origin, v_action, 'success'::public.event_result,
    NEW.last_outputs_state,
    gen_random_uuid(),
    v_effective_source,
    jsonb_build_object('actuation_origin', NEW.last_actuation_origin)
  );

  RETURN NEW;
END;
$$;

-- Backfill: recalcula actor_label de todos os registros existentes
UPDATE public.automation_log
SET actor_label = public.resolve_automation_actor_label(
  user_id, user_email, origin, details, source_device
)
WHERE actor_label IS NULL
   OR actor_label IN ('Sistema', 'Usuário identificado', 'Usuário');
