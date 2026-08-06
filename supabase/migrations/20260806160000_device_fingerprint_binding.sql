-- v3.25.45 — Amarracao server-side anti-clone (license-validate)
-- A edge function license-validate passa a comparar o fingerprint enviado pelo
-- agente com o device registrado e a contar divergencias. Precisa destas duas
-- colunas em device_licenses (a tabela ja tem machine_id_hash e fingerprint).
--
-- fingerprint_mismatch_count: quantas vezes um hardware divergente (>=2 comps)
--   tentou validar com o token deste device (sinal de clone/pirataria).
-- last_fingerprint_check: ultima vez que o fingerprint foi conferido.
--
-- Idempotente. Nenhuma policy nova: a edge function usa service_role.

ALTER TABLE public.device_licenses
  ADD COLUMN IF NOT EXISTS fingerprint_mismatch_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_fingerprint_check timestamptz;

COMMENT ON COLUMN public.device_licenses.fingerprint_mismatch_count IS
  'Tentativas de validar o token deste device a partir de hardware divergente (>=2 componentes) — sinal de clone. Ver license-validate.';
