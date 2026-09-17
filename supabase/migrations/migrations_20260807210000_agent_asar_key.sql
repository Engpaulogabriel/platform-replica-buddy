-- FASE 3 — Chave AES do asar cifrado (agent-asar-key) ───────────────────────
-- A chave AES-256 de cada release do app.asar.enc fica em uma tabela SEM policy
-- (só service_role acessa). NÃO usar uma coluna em agent_releases: essa tabela
-- pode ter SELECT para authenticated, o que vazaria a chave. Tabela isolada:
CREATE TABLE IF NOT EXISTS public.agent_release_keys (
  version    text PRIMARY KEY,
  aes_key    text NOT NULL,          -- base64 da chave AES-256 (32 bytes)
  algo       text NOT NULL DEFAULT 'aes-256-gcm',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS habilitada e NENHUMA policy → nem anon nem authenticated leem.
-- Somente service_role (edge function agent-asar-key) tem acesso.
ALTER TABLE public.agent_release_keys ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.agent_release_keys IS
  'Chave AES-256 (base64) por versão do app.asar.enc. Acesso SÓ via service_role '
  '(edge function agent-asar-key valida fingerprint+token antes de entregar). FASE 3.';
