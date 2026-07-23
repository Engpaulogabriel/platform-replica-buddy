
UPDATE public.agent_releases SET is_latest = false WHERE is_latest = true;

INSERT INTO public.agent_releases (version, artifact_type, storage_path, file_hash, file_size_bytes, is_latest, mandatory, release_notes, download_url)
VALUES (
  '3.16.0',
  'asar',
  '3.16.0/app.asar',
  '498cd037bdd85f3863ca512cded88d1179ebf25c67ae02ec23a190674d86a7e6',
  11225392,
  true,
  false,
  'Base v3.15.0 + persistência da última porta COM que funcionou. No 1º RX válido após abrir a bridge, salva a porta em last_working_com.txt (userData). Ao iniciar, tenta primeiro a porta salva, depois a porta do banco. Se a salva funcionar e diferir do banco, atualiza agent_config e loga. Se ambas falharem, retry 30s na porta salva. Sem scan.',
  NULL
)
ON CONFLICT (version) DO UPDATE SET
  storage_path = EXCLUDED.storage_path,
  file_hash = EXCLUDED.file_hash,
  file_size_bytes = EXCLUDED.file_size_bytes,
  is_latest = true,
  release_notes = EXCLUDED.release_notes;
