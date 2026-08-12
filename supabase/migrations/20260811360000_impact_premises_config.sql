-- Premissas configuráveis do Impacto RENOV, por fazenda. Ficam em
-- farm_productivity_config (mesma tabela dos custos/tarifas). Default 0 → o
-- painel mostra "requer valor" e não assume nada. Ver useRenovImpact.
ALTER TABLE public.farm_productivity_config
  ADD COLUMN IF NOT EXISTS safra_value_per_m3 numeric NOT NULL DEFAULT 0,        -- R$/m³ da safra
  ADD COLUMN IF NOT EXISTS monthly_salary_regional numeric NOT NULL DEFAULT 0;   -- salário médio regional (R$/mês)
