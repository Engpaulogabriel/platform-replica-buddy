
CREATE TABLE IF NOT EXISTS public.whatsapp_message_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  direction text NOT NULL CHECK (direction IN ('incoming','outgoing')),
  phone text NOT NULL,
  operator_name text,
  operator_id uuid,
  farm_id uuid,
  message_type text,
  message_body text,
  message_id text,
  command_parsed text,
  command_result text,
  metadata jsonb,
  timestamp_meta timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.whatsapp_message_log TO authenticated;
GRANT ALL ON public.whatsapp_message_log TO service_role;

ALTER TABLE public.whatsapp_message_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wa_msg_log_super_admin_all"
ON public.whatsapp_message_log
FOR SELECT
TO authenticated
USING (public.is_platform_admin(auth.uid()));

CREATE POLICY "wa_msg_log_farm_admin_select"
ON public.whatsapp_message_log
FOR SELECT
TO authenticated
USING (farm_id IS NOT NULL AND public.is_farm_admin(auth.uid(), farm_id));

CREATE POLICY "wa_msg_log_super_admin_delete"
ON public.whatsapp_message_log
FOR DELETE
TO authenticated
USING (public.is_platform_admin(auth.uid()));

CREATE INDEX IF NOT EXISTS idx_message_log_phone ON public.whatsapp_message_log(phone);
CREATE INDEX IF NOT EXISTS idx_message_log_created ON public.whatsapp_message_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_log_farm ON public.whatsapp_message_log(farm_id);
