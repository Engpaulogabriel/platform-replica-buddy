ALTER TABLE public.whatsapp_operators
ADD COLUMN IF NOT EXISTS default_farm_id uuid REFERENCES public.farms(id) ON DELETE SET NULL;