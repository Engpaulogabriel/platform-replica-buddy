UPDATE public.agent_releases SET is_latest = false WHERE is_latest = true;

INSERT INTO public.agent_releases (version, storage_path, file_hash, file_size_bytes, is_latest, release_notes, artifact_type)
VALUES (
  '3.14.7',
  '3.14.7/app.asar',
  '76d4685894928139486e470b5f4528036abfa956e0966ad74770035397ba545f',
  10755207,
  true,
  'v3.14.7 — OTA independente da bridge serial. Se a COM não existir ou a bridge falhar, o agente segue em modo cloud-only (heartbeat, comandos remotos e OTA continuam funcionando). Auto-detecta a porta COM quando a configurada não é encontrada.',
  'asar'
)
ON CONFLICT (version) DO UPDATE SET
  storage_path = EXCLUDED.storage_path,
  file_hash = EXCLUDED.file_hash,
  file_size_bytes = EXCLUDED.file_size_bytes,
  is_latest = true,
  release_notes = EXCLUDED.release_notes,
  artifact_type = EXCLUDED.artifact_type;