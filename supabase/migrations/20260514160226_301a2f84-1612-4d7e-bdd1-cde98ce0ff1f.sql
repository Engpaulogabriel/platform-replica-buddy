-- A) Tarifa: adicionar utility_name em farm_productivity_config (tarifas/custos já existem aqui)
ALTER TABLE public.farm_productivity_config
  ADD COLUMN IF NOT EXISTS utility_name text;

-- B) Localização da sede da fazenda
ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS latitude  numeric,
  ADD COLUMN IF NOT EXISTS longitude numeric;