ALTER TABLE public.registration_codes ADD COLUMN IF NOT EXISTS target_phone TEXT;
CREATE INDEX IF NOT EXISTS idx_registration_codes_target_phone ON public.registration_codes(target_phone);