ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS forced_shutdown_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.equipments.forced_shutdown_enabled IS 'Quando true, comando DESLIGAR para bomba com last_actuation_origin=local executa sequência {1}->10s->{0}';