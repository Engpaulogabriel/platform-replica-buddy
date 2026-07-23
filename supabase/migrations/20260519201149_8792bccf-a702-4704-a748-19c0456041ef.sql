ALTER TABLE public.automation_log
  ALTER COLUMN client_event_id DROP NOT NULL;

COMMENT ON COLUMN public.automation_log.client_event_id IS
  'Identificador opcional do evento iniciado pela interface. Leituras espontâneas/polling do PLC podem não possuir evento de cliente associado.';