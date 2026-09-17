ALTER TABLE public.farm_productivity_config
  ADD COLUMN IF NOT EXISTS valor_safra_r_per_m3 numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS salario_medio_regional numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS operadores_reduzidos numeric NOT NULL DEFAULT 0;