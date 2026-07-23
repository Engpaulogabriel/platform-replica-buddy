REVOKE ALL ON FUNCTION public.claim_whatsapp_alert_send(text, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_whatsapp_alert_send(text, uuid, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_whatsapp_alert_send(text, uuid, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_alert_send(text, uuid, text, integer) TO service_role;