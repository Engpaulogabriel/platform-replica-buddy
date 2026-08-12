-- Premissas configuráveis do Impacto RENOV, por fazenda. Ficam em
-- farm_productivity_config (mesma tabela dos custos/tarifas). Default 0 → o
-- painel mostra "requer valor"/usa o fallback e não assume nada. Ver useRenovImpact.
ALTER TABLE public.farm_productivity_config
  ADD COLUMN IF NOT EXISTS valor_safra_r_per_m3 numeric NOT NULL DEFAULT 0,     -- R$/m³ da safra
  ADD COLUMN IF NOT EXISTS salario_medio_regional numeric NOT NULL DEFAULT 0,   -- salário médio regional (R$/mês)
  ADD COLUMN IF NOT EXISTS operadores_reduzidos numeric NOT NULL DEFAULT 0;     -- nº de operadores reduzidos (0 = usar ceil(poços/4)-1)
