ALTER TABLE public.ai_classification_log
  ADD COLUMN IF NOT EXISTS operator_correction TEXT,
  ADD COLUMN IF NOT EXISTS feedback_type TEXT CHECK (feedback_type IN ('positive','negative','correction')),
  ADD COLUMN IF NOT EXISTS feedback_for_log_id UUID REFERENCES public.ai_classification_log(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_classification_log_feedback
  ON public.ai_classification_log(operator_phone, feedback_type)
  WHERE feedback_type IS NOT NULL;