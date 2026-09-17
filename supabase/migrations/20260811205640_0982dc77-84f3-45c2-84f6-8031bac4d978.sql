ALTER TABLE public.equipments ADD COLUMN IF NOT EXISTS power_cv numeric;

ALTER TABLE public.equipments ADD COLUMN IF NOT EXISTS flow_rate_m3h numeric;

UPDATE public.equipments
SET power_cv = 125, flow_rate_m3h = 300
WHERE farm_id = (SELECT id FROM public.farms WHERE name ILIKE '%semear%' LIMIT 1)
  AND type IN ('poco', 'bombeamento');