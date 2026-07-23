CREATE OR REPLACE FUNCTION public.commands_block_during_maintenance()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.type IN ('on','off','reset') AND public.is_farm_in_maintenance(NEW.farm_id) THEN
    -- Origens automatizadas: descarta silenciosamente (evita quebrar tick em massa)
    IF NEW.source_device IN ('automation-engine','platform-scheduler','automation-tick') THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'Fazenda em Modo Manutenção. Comandos bloqueados até o término.';
  END IF;
  RETURN NEW;
END;
$$;