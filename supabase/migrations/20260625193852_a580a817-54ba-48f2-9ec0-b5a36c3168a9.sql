
CREATE TABLE IF NOT EXISTS public.ai_classification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  farm_id UUID REFERENCES public.farms(id) ON DELETE SET NULL,
  operator_phone TEXT NOT NULL,
  raw_message TEXT NOT NULL,
  canonical_command TEXT,
  ai_intent TEXT,
  ai_equipments TEXT[],
  ai_confidence NUMERIC(3,2),
  ai_full_response JSONB,
  fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  execution_time_ms INTEGER,
  tokens_input INTEGER,
  tokens_output INTEGER,
  was_correct BOOLEAN
);

GRANT SELECT ON public.ai_classification_log TO authenticated;
GRANT ALL ON public.ai_classification_log TO service_role;

ALTER TABLE public.ai_classification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can read AI log"
ON public.ai_classification_log FOR SELECT
TO authenticated
USING (public.is_platform_admin(auth.uid()));

CREATE INDEX IF NOT EXISTS ai_classification_log_farm_created_idx
  ON public.ai_classification_log (farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_classification_log_phone_created_idx
  ON public.ai_classification_log (operator_phone, created_at DESC);
