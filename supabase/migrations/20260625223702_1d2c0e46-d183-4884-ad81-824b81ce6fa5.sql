ALTER TABLE public.whatsapp_operators ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved';
NOTIFY pgrst, 'reload schema';