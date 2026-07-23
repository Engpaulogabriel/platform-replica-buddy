-- Reduzir polling_interval_seconds para teste (modo "instantâneo")
-- Limite físico do hardware ESP_A é ~3s entre TX. Usamos 5s por segurança.
ALTER TABLE public.equipments
  ALTER COLUMN polling_interval_seconds SET DEFAULT 5;

UPDATE public.equipments
SET polling_interval_seconds = 5
WHERE polling_interval_seconds > 5;