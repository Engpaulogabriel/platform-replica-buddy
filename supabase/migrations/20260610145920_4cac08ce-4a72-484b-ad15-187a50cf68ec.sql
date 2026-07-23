ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS local_ack_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.equipments.local_ack_at IS
  'Timestamp em que o operador reconheceu o aviso de acionamento Local (dismiss via double-click no badge LOCAL). Badge só reaparece se houver novo acionamento local com last_communication > local_ack_at.';