
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS vazao_m3_por_pulso integer DEFAULT 1
    CHECK (vazao_m3_por_pulso IN (1, 2, 3, 5, 10, 25));

ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS outorga_vazao_max_m3h real DEFAULT NULL;

ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS outorga_volume_max_mensal_m3 real DEFAULT NULL;
