ALTER TABLE public.equipments ADD COLUMN IF NOT EXISTS is_captacao boolean NOT NULL DEFAULT false;

-- Backfill: equipamentos do tipo 'poco' são captação por padrão
UPDATE public.equipments SET is_captacao = true WHERE type = 'poco';