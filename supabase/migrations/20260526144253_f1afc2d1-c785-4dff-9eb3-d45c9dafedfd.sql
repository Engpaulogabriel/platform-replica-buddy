
CREATE OR REPLACE FUNCTION public.resolve_automation_actor_label(_user_id uuid, _user_email text, _origin event_origin, _details jsonb, _source_device text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Automações da nuvem (configuradas por usuário) → "Automação"
  IF COALESCE(_source_device, '') IN ('cloud-automation', 'cloud-protective-off')
     OR _origin = 'auto'::public.event_origin THEN
    RETURN 'Automação';
  END IF;

  -- Local (PLC) sem identificação → "Acionamento Local"
  -- Remote sem user_id já é descartado/reclassificado pelo trigger enforce_automation_log_actor_rule
  RETURN 'Acionamento Local';
END;
$function$;
