CREATE OR REPLACE FUNCTION public.set_automation_actor_label()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  -- Preserve any meaningful pre-filled label (except the legacy placeholder)
  IF NEW.actor_label IS NOT NULL
     AND btrim(NEW.actor_label) <> ''
     AND NEW.actor_label <> 'Acionamento Local' THEN
    RETURN NEW;
  END IF;

  IF NEW.origin = 'remote'::public.event_origin THEN
    IF NEW.user_id IS NOT NULL THEN
      NEW.actor_label := COALESCE(
        (SELECT NULLIF(btrim(full_name), '') FROM public.profiles WHERE id = NEW.user_id),
        NULLIF(btrim(NEW.user_email), ''),
        'Comando Remoto'
      );
    ELSE
      NEW.actor_label := COALESCE(NULLIF(btrim(NEW.user_email), ''), 'Comando Remoto');
    END IF;
  ELSIF NEW.origin = 'auto'::public.event_origin THEN
    NEW.actor_label := 'Automação';
  ELSE
    -- local / system / reading / qualquer outro
    NEW.actor_label := 'Sistema';
  END IF;

  RETURN NEW;
END;
$function$;