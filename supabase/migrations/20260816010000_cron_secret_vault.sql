-- ============================================================================
-- SEGREDO DE CRON — os jobs passam a se autenticar com um segredo próprio.
-- ----------------------------------------------------------------------------
-- Hoje os cron jobs chamam as Edge Functions com a ANON KEY, que é pública por
-- definição (vai no bundle do frontend) e está inclusive LITERAL numa migration
-- antiga. Na prática, qualquer pessoa consegue disparar desligamento
-- programado, watchdogs e alertas.
--
-- O segredo NUNCA aparece aqui. Ele é lido do Vault em tempo de execução.
-- Guarde-o em DOIS lugares, com o MESMO valor:
--   1. Edge Functions → secret `CRON_SECRET`
--   2. Vault do banco → `SELECT vault.create_secret('<valor>', 'CRON_SECRET');`
--
-- Não altera lógica de desligamento, alertas, WhatsApp, agente, rádio, bridge,
-- Relatório, automações nem FASE 2/3. Só muda COMO o job se identifica.
-- ============================================================================

-- ── Leitura do segredo, sem nunca materializar em log ───────────────────────
CREATE OR REPLACE FUNCTION public.cron_secret()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE v text;
BEGIN
  SELECT decrypted_secret INTO v
    FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1;
  RETURN v;   -- NULL se ausente: quem chama decide, e a função Edge fecha
END; $$;
REVOKE ALL ON FUNCTION public.cron_secret() FROM PUBLIC, anon, authenticated;

-- ── Chamada padrão dos jobs ─────────────────────────────────────────────────
-- Envia o segredo em `x-cron-secret`. Mantém apikey/Authorization para o
-- gateway, mas eles deixam de ser o que autoriza — a função Edge só aceita o
-- segredo ou a service_role.
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

-- ── Conferência (não imprime o segredo, só diz se existe) ──────────────────
CREATE OR REPLACE FUNCTION public.cron_secret_configured()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, vault AS $$
  SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets
                  WHERE name = 'CRON_SECRET' AND btrim(decrypted_secret) <> '');
$$;

-- ============================================================================
-- APLICAÇÃO (nesta ordem, para nada parar)
--   1. Edge Functions → criar secret CRON_SECRET (32+ bytes aleatórios).
--   2. No banco:
--        SELECT vault.create_secret('<mesmo valor>', 'CRON_SECRET');
--        SELECT vault.create_secret('https://<ref>.supabase.co/functions/v1',
--                                   'PROJECT_FUNCTIONS_URL');
--   3. Aplicar ESTA migration.
--   4. SELECT public.cron_secret_configured();   -- precisa ser true
--   5. Publicar as Edge Functions com a guarda.
--   6. Reapontar cada job para cron_invoke(), um a um, conferindo net._http_response.
--
-- REPOINTAR UM JOB (exemplo — ajuste o schedule ao atual):
--   SELECT cron.unschedule('<nome-do-job>');
--   SELECT cron.schedule('<nome-do-job>', '<schedule>',
--     $$ SELECT public.cron_invoke('scheduled-shutdown'); $$);
--
-- ROLLBACK sem derrubar os jobs: republique a Edge Function sem a guarda.
-- Enquanto o segredo estiver certo nos dois lados, nada precisa ser revertido.
-- ============================================================================
