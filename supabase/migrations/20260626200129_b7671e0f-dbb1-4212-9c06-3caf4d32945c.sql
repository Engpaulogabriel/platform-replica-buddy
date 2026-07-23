CREATE TABLE IF NOT EXISTS public.whatsapp_alert_send_claims (
  alert_type text NOT NULL,
  equipment_id uuid NOT NULL,
  phone text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_type, equipment_id, phone)
);

GRANT ALL ON public.whatsapp_alert_send_claims TO service_role;

ALTER TABLE public.whatsapp_alert_send_claims ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.claim_whatsapp_alert_send(
  p_alert_type text,
  p_equipment_id uuid,
  p_phone text,
  p_window_seconds integer DEFAULT 1800
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_claimed boolean := false;
BEGIN
  IF p_alert_type IS NULL OR p_equipment_id IS NULL OR p_phone IS NULL OR length(trim(p_phone)) = 0 THEN
    RETURN true;
  END IF;

  v_phone := regexp_replace(p_phone, '\D', '', 'g');
  IF v_phone = '' THEN
    RETURN true;
  END IF;

  INSERT INTO public.whatsapp_alert_send_claims (alert_type, equipment_id, phone, claimed_at)
  VALUES (p_alert_type, p_equipment_id, v_phone, now())
  ON CONFLICT (alert_type, equipment_id, phone)
  DO UPDATE SET claimed_at = EXCLUDED.claimed_at
  WHERE public.whatsapp_alert_send_claims.claimed_at < now() - make_interval(secs => p_window_seconds)
  RETURNING true INTO v_claimed;

  RETURN coalesce(v_claimed, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_whatsapp_alert_send(text, uuid, text, integer) TO service_role;