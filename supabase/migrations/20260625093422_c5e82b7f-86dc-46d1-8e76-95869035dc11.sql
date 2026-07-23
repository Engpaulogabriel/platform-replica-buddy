
ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS cpf text;
ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS full_name text;

CREATE INDEX IF NOT EXISTS idx_whatsapp_operators_cpf ON public.whatsapp_operators(cpf) WHERE cpf IS NOT NULL;
