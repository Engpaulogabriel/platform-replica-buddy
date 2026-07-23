CREATE TABLE IF NOT EXISTS public.whatsapp_conversation_state (
  operator_phone text PRIMARY KEY,
  awaiting text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.whatsapp_conversation_state TO service_role;
ALTER TABLE public.whatsapp_conversation_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only conv state" ON public.whatsapp_conversation_state FOR ALL USING (false) WITH CHECK (false);