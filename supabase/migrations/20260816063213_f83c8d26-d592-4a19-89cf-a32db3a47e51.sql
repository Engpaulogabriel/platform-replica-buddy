-- ============================================================================
-- SEGREDO DE CRON — os jobs passam a se autenticar com um segredo próprio.
-- O segredo NUNCA aparece aqui. Ele é lido do Vault em tempo de execução.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cron_secret()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE v text;
BEGIN
  SELECT decrypted_secret INTO v
    FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1;
  RETURN v;
END; $$;
REVOKE ALL ON FUNCTION public.cron_secret() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cron_invoke(_fn text, _body jsonb DEFAULT '{}'::jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault, extensions AS $$
DECLARE v_secret text; v_url text; v_id bigint;
BEGIN
  v_secret := public.cron_secret();
  IF v_secret IS NULL OR btrim(v_secret) = '' THEN
    RAISE EXCEPTION 'CRON_SECRET ausente no Vault — job % não foi disparado', _fn;
  END IF;

  SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'PROJECT_FUNCTIONS_URL' LIMIT 1;
  IF v_url IS NULL THEN
    RAISE EXCEPTION 'PROJECT_FUNCTIONS_URL ausente no Vault';
  END IF;

  SELECT net.http_post(
    url     := rtrim(v_url, '/') || '/' || _fn,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', v_secret),
    body    := _body
  ) INTO v_id;
  RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.cron_invoke(text, jsonb) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.cron_invoke(text, jsonb) IS
  'Único caminho para o pg_cron chamar Edge Function agendada. Lê CRON_SECRET do Vault; nunca imprime o segredo.';

CREATE OR REPLACE FUNCTION public.cron_secret_configured()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, vault AS $$
  SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets
                  WHERE name = 'CRON_SECRET' AND btrim(decrypted_secret) <> '');
$$;