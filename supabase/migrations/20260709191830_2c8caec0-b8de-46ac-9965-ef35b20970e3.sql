
-- =========================================================================
-- SECURITY HARDENING F1: rate limit + sessão única + alertas WhatsApp
-- =========================================================================

-- Extensões necessárias (pg_net para HTTP async)
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ------------------------------------------------------------------------
-- 1) login_attempts: log de todas as tentativas (usado para contar falhas por IP)
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.login_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip            inet NOT NULL,
  email         text,
  success       boolean NOT NULL,
  reason        text,
  user_agent    text,
  captcha_score numeric,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON public.login_attempts (ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time ON public.login_attempts (email, created_at DESC);

GRANT ALL ON public.login_attempts TO service_role;
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;
-- Nenhuma policy para authenticated/anon: apenas service_role acessa.

-- ------------------------------------------------------------------------
-- 2) ip_blocks: IPs bloqueados temporariamente
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ip_blocks (
  ip             inet PRIMARY KEY,
  blocked_until  timestamptz NOT NULL,
  level          smallint NOT NULL DEFAULT 1,   -- 1=30min, 2=24h
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ip_blocks_until ON public.ip_blocks (blocked_until DESC);

GRANT ALL ON public.ip_blocks TO service_role;
ALTER TABLE public.ip_blocks ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------
-- 3) active_sessions: rastreia sessão vigente por usuário (sessão única)
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.active_sessions (
  session_id    text PRIMARY KEY,             -- token id (jti) ou refresh_token hash
  user_id       uuid NOT NULL,
  device_fp     text,
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_active_sessions_user ON public.active_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_active_sessions_active ON public.active_sessions (user_id) WHERE revoked_at IS NULL;

GRANT SELECT ON public.active_sessions TO authenticated;
GRANT ALL ON public.active_sessions TO service_role;
ALTER TABLE public.active_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own sessions"
  ON public.active_sessions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ------------------------------------------------------------------------
-- 4) security_alerts: log central de eventos de segurança
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.security_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type    text NOT NULL,       -- ip_block_30min | ip_block_24h | session_takeover | scraping | api_flood | fp_mismatch
  ip            inet,
  user_id       uuid,
  email         text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_taken  text,
  whatsapp_sent boolean NOT NULL DEFAULT false,
  whatsapp_error text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_security_alerts_time ON public.security_alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_alerts_type ON public.security_alerts (alert_type, created_at DESC);

GRANT ALL ON public.security_alerts TO service_role;
ALTER TABLE public.security_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "platform admins read security alerts"
  ON public.security_alerts FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()));

-- ------------------------------------------------------------------------
-- 5) Config: destinos fixos dos alertas de segurança
-- ------------------------------------------------------------------------
INSERT INTO public.platform_settings (key, value)
VALUES (
  'security_alert_recipients',
  jsonb_build_object('numbers', jsonb_build_array('5577999608294','5577981503951'))
)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value;

-- ------------------------------------------------------------------------
-- 6) Função que envia o alerta via WhatsApp usando pg_net + whatsapp_config
-- ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_security_alert_whatsapp(_alert_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
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

  -- Pega o primeiro whatsapp_config com credenciais válidas.
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
      PERFORM extensions.http_post(
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
$$;

REVOKE ALL ON FUNCTION public.send_security_alert_whatsapp(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.send_security_alert_whatsapp(uuid) TO service_role;

-- Trigger: sempre que um security_alert é inserido, dispara WhatsApp
CREATE OR REPLACE FUNCTION public.tg_security_alert_dispatch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.send_security_alert_whatsapp(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_security_alerts_dispatch ON public.security_alerts;
CREATE TRIGGER trg_security_alerts_dispatch
  AFTER INSERT ON public.security_alerts
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_security_alert_dispatch();

-- ------------------------------------------------------------------------
-- 7) RPC pública (SECURITY DEFINER) para o cliente registrar sua sessão
--    e derrubar as anteriores do mesmo usuário. Chamada pós-login.
-- ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_active_session(
  _session_id text,
  _device_fp  text,
  _ip         text,
  _user_agent text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- Revoga todas as sessões anteriores desse usuário
  UPDATE public.active_sessions
     SET revoked_at = now()
   WHERE user_id = v_uid
     AND session_id <> _session_id
     AND revoked_at IS NULL;

  -- Registra a atual
  INSERT INTO public.active_sessions (session_id, user_id, device_fp, ip, user_agent)
  VALUES (_session_id, v_uid, _device_fp, NULLIF(_ip,'')::inet, _user_agent)
  ON CONFLICT (session_id) DO UPDATE
    SET last_seen_at = now(),
        device_fp = EXCLUDED.device_fp,
        ip = EXCLUDED.ip,
        user_agent = EXCLUDED.user_agent,
        revoked_at = NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_active_session(text,text,text,text) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_active_session(text,text,text,text) TO authenticated;

-- Heartbeat leve para manter last_seen_at (opcional; usado pela F2)
CREATE OR REPLACE FUNCTION public.touch_active_session(_session_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ok  boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  UPDATE public.active_sessions
     SET last_seen_at = now()
   WHERE session_id = _session_id
     AND user_id = v_uid
     AND revoked_at IS NULL
   RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$$;

REVOKE ALL ON FUNCTION public.touch_active_session(text) FROM public;
GRANT EXECUTE ON FUNCTION public.touch_active_session(text) TO authenticated;
