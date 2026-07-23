CREATE OR REPLACE FUNCTION public.send_security_alert_whatsapp(_alert_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net'
AS $function$
DECLARE
  v_alert       public.security_alerts%ROWTYPE;
  v_token       text;
  v_phone_id    text;
  v_recipients  jsonb;
  v_number      text;
  v_body        text;
  v_ts          text;
  v_err         text;
BEGIN
  SELECT * INTO v_alert FROM public.security_alerts WHERE id = _alert_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT api_token, phone_number_id
    INTO v_token, v_phone_id
    FROM public.whatsapp_config
    WHERE api_token IS NOT NULL
      AND phone_number_id IS NOT NULL
      AND length(api_token) > 10
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1;

  IF v_token IS NULL OR v_phone_id IS NULL THEN
    UPDATE public.security_alerts
       SET whatsapp_error = 'whatsapp_config sem api_token/phone_number_id'
     WHERE id = _alert_id;
    RETURN;
  END IF;

  SELECT value->'numbers' INTO v_recipients
    FROM public.platform_settings
    WHERE key = 'security_alert_recipients';

  IF v_recipients IS NULL OR jsonb_array_length(v_recipients) = 0 THEN
    UPDATE public.security_alerts
       SET whatsapp_error = 'security_alert_recipients vazio'
     WHERE id = _alert_id;
    RETURN;
  END IF;

  v_ts := to_char(v_alert.created_at AT TIME ZONE 'America/Bahia', 'DD/MM/YYYY HH24:MI');

  v_body :=
    E'🚨 ALERTA DE SEGURANÇA — RENOV\n' ||
    E'Tipo: ' || COALESCE(v_alert.alert_type,'-') || E'\n' ||
    E'IP: ' || COALESCE(host(v_alert.ip),'-') || E'\n' ||
    E'Usuário: ' || COALESCE(v_alert.email,'-') || E'\n' ||
    E'Detalhes: ' || COALESCE(v_alert.details->>'description', v_alert.details::text, '-') || E'\n' ||
    E'Ação tomada: ' || COALESCE(v_alert.action_taken,'-') || E'\n' ||
    E'Horário: ' || v_ts || 'h';

  BEGIN
    FOR v_number IN SELECT jsonb_array_elements_text(v_recipients)
    LOOP
      PERFORM net.http_post(
        url     := 'https://graph.facebook.com/v21.0/' || v_phone_id || '/messages',
        headers := jsonb_build_object(
                     'Content-Type','application/json',
                     'Authorization','Bearer ' || v_token
                   ),
        body    := jsonb_build_object(
                     'messaging_product','whatsapp',
                     'to', v_number,
                     'type','text',
                     'text', jsonb_build_object('preview_url', false, 'body', v_body)
                   )
      );
    END LOOP;

    UPDATE public.security_alerts
       SET whatsapp_sent = true, whatsapp_error = NULL
     WHERE id = _alert_id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    UPDATE public.security_alerts
       SET whatsapp_error = v_err
     WHERE id = _alert_id;
  END;
END;
$function$;

-- Reprocessa alertas pendentes (falharam antes por causa de extensions.http_post)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.security_alerts
           WHERE whatsapp_sent = false
             AND created_at > now() - interval '24 hours'
  LOOP
    PERFORM public.send_security_alert_whatsapp(r.id);
  END LOOP;
END $$;