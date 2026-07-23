-- Altera o valor default da coluna comm_system_seconds para 10
ALTER TABLE public.farm_timing_config ALTER COLUMN comm_system_seconds SET DEFAULT 10;

-- Atualiza todas as fazendas existentes que estão com o valor antigo (3) para 10
UPDATE public.farm_timing_config SET comm_system_seconds = 10 WHERE comm_system_seconds = 3;