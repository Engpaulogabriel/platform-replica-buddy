CREATE OR REPLACE FUNCTION public.auto_flip_online_on_telemetry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Quando o bridge/Electron escreve telemetria nova (avança last_communication)
  -- e o status atual é 'offline', volta para 'online' automaticamente.
  -- Isso garante que o trigger notify_equipment_change dispare o alerta back_online.
  IF NEW.last_communication IS NOT NULL
     AND (OLD.last_communication IS NULL OR NEW.last_communication > OLD.last_communication)
     AND OLD.communication_status = 'offline'
     AND (NEW.communication_status IS NULL OR NEW.communication_status = OLD.communication_status)
  THEN
    NEW.communication_status := 'online';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_flip_online_on_telemetry ON public.equipments;
CREATE TRIGGER trg_auto_flip_online_on_telemetry
BEFORE UPDATE OF last_communication ON public.equipments
FOR EACH ROW
EXECUTE FUNCTION public.auto_flip_online_on_telemetry();