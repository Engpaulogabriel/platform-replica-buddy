
CREATE TABLE public.whatsapp_pending_actions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  operator_phone TEXT NOT NULL,
  action_type TEXT NOT NULL,
  equipment_id UUID NOT NULL,
  equipment_name TEXT NOT NULL,
  farm_id UUID,
  operator_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wa_pending_phone_created ON public.whatsapp_pending_actions (operator_phone, created_at DESC);

GRANT ALL ON public.whatsapp_pending_actions TO service_role;

ALTER TABLE public.whatsapp_pending_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role manages pending actions"
  ON public.whatsapp_pending_actions
  FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);
