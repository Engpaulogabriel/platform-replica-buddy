-- ============================================================================
-- REGISTRO DA RELEASE PILOTO — FASE 3 (asar cifrado + loader) v3.25.66 — SÓ SYKUE
-- ----------------------------------------------------------------------------
-- Rode ISTO no SQL Editor APÓS o build:
--     cd electron-agent && RENOV_ENCRYPT_ASAR=1 ./installer/build-secure-asar.sh
-- O build imprime 3 valores — substitua os placeholders abaixo:
--     <SHA256_ASAR>   = "sha256:" do app.asar (bloco "app.asar gerado")
--     <SIZE_BYTES>    = "tamanho:" em bytes (mesmo bloco)
--     <AES_KEY_B64>   = "AES key (base64):" (bloco "FASE 3 — main.enc gerado")
--
-- NÃO promove is_latest → a frota permanece no 3.25.65. Enforcement OFF garante
-- que, se a decifragem falhar, o loader cai no main.cjs obfuscado (não brica).
--
-- ⚠️ storage_path é RELATIVO ao bucket agent-releases — NÃO prefixe "agent-releases/"
--    (foi o bug de "Object not found" da 3.25.64). Suba DOIS arquivos no bucket:
--      • agent-releases/3.25.66/app.asar   (loader como entry; hash vai no agent_releases)
--      • agent-releases/3.25.66/main.enc   (código cifrado; o loader baixa por OTA via
--        agent-asar-key → decifra em memória → cacheia selado local. NÃO vai em resources/.)
-- ============================================================================

-- 1) RELEASE (storage-based; is_latest=false — não mexe no que a frota recebe)
INSERT INTO public.agent_releases
  (version, artifact_type, storage_path, file_hash, file_size_bytes, is_latest, mandatory, download_url, release_notes)
VALUES
  ('3.25.66', 'asar', '3.25.66/app.asar', '<SHA256_ASAR>', <SIZE_BYTES>, false, false, NULL,
   'FASE 3 piloto (asar cifrado AES-256 + loader.cjs). Enforcement OFF. Somente Sykue.')
ON CONFLICT (version) DO UPDATE SET
  artifact_type   = EXCLUDED.artifact_type,
  storage_path    = EXCLUDED.storage_path,
  file_hash       = EXCLUDED.file_hash,
  file_size_bytes = EXCLUDED.file_size_bytes,
  is_latest       = false,
  release_notes   = EXCLUDED.release_notes;

-- 2) CHAVE AES da versão (base64, 32 bytes). Tabela sem policy → só service_role
--    (a edge agent-asar-key valida fingerprint+token antes de entregar ao loader).
INSERT INTO public.agent_release_keys (version, aes_key, algo)
VALUES ('3.25.66', '<AES_KEY_B64>', 'aes-256-gcm')
ON CONFLICT (version) DO UPDATE SET aes_key = EXCLUDED.aes_key, algo = EXCLUDED.algo;

-- 3) PIN só na Sykue (as demais fazendas não são tocadas)
UPDATE public.farms
   SET target_agent_version = '3.25.66'
 WHERE name ILIKE '%sykue%';

-- ── Conferência ────────────────────────────────────────────────────────────
SELECT version, storage_path, is_latest, file_hash, file_size_bytes
  FROM public.agent_releases WHERE version = '3.25.66';
SELECT version, algo, length(aes_key) AS key_len
  FROM public.agent_release_keys WHERE version = '3.25.66';
SELECT name, target_agent_version
  FROM public.farms WHERE name ILIKE '%sykue%';
