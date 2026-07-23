DROP TRIGGER IF EXISTS sync_equipment_pending_command_on_insert_trigger ON public.commands;
CREATE TRIGGER sync_equipment_pending_command_on_insert_trigger
AFTER INSERT ON public.commands
FOR EACH ROW
EXECUTE FUNCTION public.sync_equipment_pending_command_on_insert();

DROP TRIGGER IF EXISTS sync_equipment_pending_command_on_update_trigger ON public.commands;
CREATE TRIGGER sync_equipment_pending_command_on_update_trigger
AFTER UPDATE ON public.commands
FOR EACH ROW
EXECUTE FUNCTION public.sync_equipment_pending_command_on_update();