
CREATE OR REPLACE FUNCTION public.cancel_pending_polling_on_manual()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Ao inserir um comando manual/automação, cancela qualquer comando de
  -- polling ainda pendente para o MESMO equipamento. Elimina a race em
  -- que o polling foi enfileirado com desired_running antigo e chegaria
  -- ~1-2s depois do manual, desfazendo o clique do operador.
  IF NEW.type IN ('manual','automation') AND NEW.equipment_id IS NOT NULL THEN
    UPDATE public.commands
    SET status = 'cancelled',
        error_message = COALESCE(error_message, 'Cancelado: superado por comando manual ' || NEW.id::text),
        responded_at = COALESCE(responded_at, now())
    WHERE equipment_id = NEW.equipment_id
      AND type = 'polling'
      AND status = 'pending'
      AND id <> NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cancel_pending_polling_on_manual ON public.commands;
CREATE TRIGGER trg_cancel_pending_polling_on_manual
AFTER INSERT ON public.commands
FOR EACH ROW
EXECUTE FUNCTION public.cancel_pending_polling_on_manual();
