
ALTER TABLE public.farm_productivity_config
  ADD COLUMN IF NOT EXISTS tariff_intermediate numeric(8,4),
  ADD COLUMN IF NOT EXISTS reserved_hour_start time NOT NULL DEFAULT '21:30',
  ADD COLUMN IF NOT EXISTS reserved_hour_end time NOT NULL DEFAULT '06:00',
  ADD COLUMN IF NOT EXISTS intermediate_hour_pre_start time NOT NULL DEFAULT '17:00',
  ADD COLUMN IF NOT EXISTS intermediate_hour_post_end time NOT NULL DEFAULT '21:30';

UPDATE public.farm_productivity_config
SET tariff_intermediate = 1.1951,
    reserved_hour_start = '21:30',
    reserved_hour_end   = '06:00',
    intermediate_hour_pre_start = '17:00',
    intermediate_hour_post_end  = '21:30'
WHERE farm_id IN (SELECT id FROM public.farms WHERE name ILIKE '%terra norte%');
