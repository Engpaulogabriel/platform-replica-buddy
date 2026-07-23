CREATE TABLE public.registration_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  registration_code TEXT REFERENCES public.registration_codes(code) ON DELETE SET NULL,
  target_phone TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  location_accuracy NUMERIC(10,2),
  location_denied BOOLEAN NOT NULL DEFAULT FALSE,
  city_from_ip TEXT,
  state_from_ip TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_registration_verifications_token ON public.registration_verifications(token);
CREATE INDEX idx_registration_verifications_code ON public.registration_verifications(registration_code);
CREATE INDEX idx_registration_verifications_phone ON public.registration_verifications(target_phone);

GRANT ALL ON public.registration_verifications TO service_role;

ALTER TABLE public.registration_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role manages registration_verifications"
ON public.registration_verifications
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
