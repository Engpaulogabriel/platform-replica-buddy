
-- 1) Cancela comandos pending órfãos (frame com PLC desatualizado)
UPDATE public.commands c
SET status = 'cancelled',
    error_message = 'PLC do equipamento foi alterado — comando obsoleto'
WHERE c.status = 'pending'
  AND c.equipment_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.id = c.equipment_id
      AND COALESCE(pg.hw_id, substring(e.hw_id from 1 for 4)) <> COALESCE(c.plc_hw_id, '')
  );

-- 2) Trigger: ao alterar plc_group_id ou hw_id do equipamento, cancela comandos pending dele
CREATE OR REPLACE FUNCTION public.cancel_pending_on_equipment_plc_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.plc_group_id IS DISTINCT FROM OLD.plc_group_id)
     OR (NEW.hw_id IS DISTINCT FROM OLD.hw_id) THEN
    UPDATE public.commands
    SET status = 'cancelled',
        error_message = 'PLC/hw_id do equipamento foi alterado — comando obsoleto'
    WHERE equipment_id = NEW.id
      AND status IN ('pending', 'sent');

    -- Reseta o relógio de polling para que um novo comando seja enfileirado imediatamente
    NEW.last_polling_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cancel_pending_on_equipment_plc_change ON public.equipments;
CREATE TRIGGER trg_cancel_pending_on_equipment_plc_change
BEFORE UPDATE ON public.equipments
FOR EACH ROW
EXECUTE FUNCTION public.cancel_pending_on_equipment_plc_change();

-- 3) Trigger equivalente em plc_groups: ao mudar o hw_id do PLC, cancela comandos pending dos equipamentos vinculados
CREATE OR REPLACE FUNCTION public.cancel_pending_on_plc_group_hw_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.hw_id IS DISTINCT FROM OLD.hw_id THEN
    UPDATE public.commands c
    SET status = 'cancelled',
        error_message = 'hw_id do PLC foi alterado — comando obsoleto'
    WHERE c.status IN ('pending', 'sent')
      AND c.equipment_id IN (SELECT id FROM public.equipments WHERE plc_group_id = NEW.id);

    UPDATE public.equipments SET last_polling_at = NULL WHERE plc_group_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cancel_pending_on_plc_group_hw_change ON public.plc_groups;
CREATE TRIGGER trg_cancel_pending_on_plc_group_hw_change
BEFORE UPDATE ON public.plc_groups
FOR EACH ROW
EXECUTE FUNCTION public.cancel_pending_on_plc_group_hw_change();
