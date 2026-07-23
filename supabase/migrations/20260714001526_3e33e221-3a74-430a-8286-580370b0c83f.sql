
ALTER TABLE public.equipments DISABLE TRIGGER trg_notify_equipment_state_change;

DO $$
BEGIN
  PERFORM cron.unschedule('check-unresponsive-commands');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
