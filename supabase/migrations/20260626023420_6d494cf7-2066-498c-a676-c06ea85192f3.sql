
ALTER TABLE public.whatsapp_operators
  ADD COLUMN IF NOT EXISTS can_approve BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_register BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.registration_codes
  ADD COLUMN IF NOT EXISTS generated_by TEXT;

UPDATE public.whatsapp_operators
  SET can_approve = TRUE, can_register = TRUE
  WHERE role = 'super_admin';

UPDATE public.whatsapp_operators
  SET can_register = TRUE
  WHERE role = 'admin' AND can_register = FALSE;
