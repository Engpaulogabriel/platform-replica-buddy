ALTER TABLE public.equipments
ADD COLUMN IF NOT EXISTS auto_mode boolean NOT NULL DEFAULT false;