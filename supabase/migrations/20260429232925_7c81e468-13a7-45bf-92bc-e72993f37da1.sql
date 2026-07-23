-- Trigger AFTER UPDATE: apaga a linha imediatamente quando status finaliza
CREATE OR REPLACE FUNCTION public.delete_finished_command()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('executed','timeout','cancelled','error') THEN
    DELETE FROM public.commands WHERE id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_delete_finished_command ON public.commands;

CREATE TRIGGER trg_delete_finished_command
AFTER UPDATE OF status ON public.commands
FOR EACH ROW
WHEN (NEW.status IN ('executed','timeout','cancelled','error'))
EXECUTE FUNCTION public.delete_finished_command();