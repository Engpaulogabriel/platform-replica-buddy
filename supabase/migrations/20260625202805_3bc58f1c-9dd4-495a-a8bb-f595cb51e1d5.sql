ALTER TABLE public.whatsapp_message_log ADD COLUMN IF NOT EXISTS original_type TEXT DEFAULT 'text';
ALTER TABLE public.whatsapp_message_log ADD COLUMN IF NOT EXISTS audio_duration_seconds INTEGER;