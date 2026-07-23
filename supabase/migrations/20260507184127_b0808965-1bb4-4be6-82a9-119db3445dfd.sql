-- 1) Default novo: PLC tem 1 saída por padrão
ALTER TABLE public.plc_groups ALTER COLUMN output_count SET DEFAULT 1;

-- 2) Corrige PLCs existentes da Sykue: todas as 1xxx são saída única
UPDATE public.plc_groups
SET output_count = 1
WHERE hw_id NOT LIKE '21%' AND output_count <> 1;