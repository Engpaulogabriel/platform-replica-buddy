ALTER TABLE public.whatsapp_pending_actions
ADD COLUMN IF NOT EXISTS original_text text;