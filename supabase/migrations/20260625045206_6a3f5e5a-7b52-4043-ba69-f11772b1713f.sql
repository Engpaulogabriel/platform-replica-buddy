ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

UPDATE public.whatsapp_operators
SET user_id = 'f170b2be-ca22-4cd9-b14e-aa4f476c783b'
WHERE name ILIKE '%gabriel%' AND user_id IS NULL;

UPDATE public.whatsapp_operators
SET user_id = 'a9988fda-6d6a-4eb1-8722-dadb8dabd1a4'
WHERE (name ILIKE '%renov%' OR name ILIKE 'Operador 5577999608294') AND user_id IS NULL;