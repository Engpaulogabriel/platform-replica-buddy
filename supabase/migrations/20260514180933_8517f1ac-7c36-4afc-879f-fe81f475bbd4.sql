
-- 1) Trigger de equipments só registra acionamento local/leitura.
--    Acionamentos remotos vêm do trigger de commands (com user_id real).
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
    'auto-trigger',
    jsonb_build_object('actuation_origin', NEW.last_actuation_origin)
  );

  RETURN NEW;
END;
$$;

-- 2) Drop + recreate do resolver (assinatura preservada, sem "Operador").
DROP FUNCTION IF EXISTS public.resolve_automation_actor_label(uuid, text, public.event_origin, jsonb, text);

CREATE FUNCTION public.resolve_automation_actor_label(
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
    RETURN 'Sistema';
  END IF;

  IF _origin = 'local'::public.event_origin THEN
    RETURN 'Acionamento Local';
  END IF;

  -- Para 'remote' sem identificação não usamos mais "Operador".
  RETURN 'Sistema';
END;
$$;

-- 3) Limpeza de duplicatas existentes
DELETE FROM public.automation_log a
WHERE a.source_device = 'auto-trigger'
  AND a.origin = 'remote'::public.event_origin
  AND a.user_id IS NULL
  AND EXISTS (
    SELECT 1 FROM public.automation_log b
    WHERE b.equipment_id = a.equipment_id
      AND b.action = a.action
      AND b.user_id IS NOT NULL
      AND b.occurred_at BETWEEN a.occurred_at - interval '5 seconds'
                            AND a.occurred_at + interval '5 seconds'
  );

-- 4) Recalcular actor_label das linhas remanescentes que ainda mostravam "Operador"
UPDATE public.automation_log
SET actor_label = public.resolve_automation_actor_label(
  user_id, user_email, origin, details, source_device
)
WHERE actor_label = 'Operador';
