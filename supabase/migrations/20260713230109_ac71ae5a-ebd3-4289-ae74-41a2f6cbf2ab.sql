CREATE OR REPLACE FUNCTION public.guard_actuation_command_vs_local()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _eq RECORD;
  _frame text;
BEGIN
  _frame := COALESCE(NEW.frame, '');

  -- CRÍTICO: comandos de comunicação/leitura NUNCA podem ser bloqueados.
  -- Isso inclui polling e frames textuais de status/ping/dump/read.
  IF NEW.type IS DISTINCT FROM 'automation' THEN
    RETURN NEW;
  END IF;

  IF _frame = '' THEN
    RETURN NEW;
  END IF;

  IF _frame ~* '(STATUS|PING|DUMP|READ|POLL)' THEN
    RETURN NEW;
  END IF;

  -- Só considera atuação real o frame de escrita de saída do protocolo Renov.
  IF _frame !~ '\[\d{4}_1_\]\{[01]{1,6}\}' THEN
    RETURN NEW;
  END IF;

  IF NEW.equipment_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id, last_actuation_origin
    INTO _eq
    FROM public.equipments
    WHERE id = NEW.equipment_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Bloqueia APENAS atuação automática quando a bomba está em Local.
  IF _eq.last_actuation_origin IS DISTINCT FROM 'local' THEN
    RETURN NEW;
  END IF;

  NEW.status := 'cancelled';
  NEW.responded_at := NOW();
  NEW.error_message := 'Atuação automática bloqueada — equipamento em modo Local (polling/status liberados)';
  RETURN NEW;
END;
$function$;