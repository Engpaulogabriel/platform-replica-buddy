UPDATE public.agent_releases SET is_latest = false WHERE is_latest = true;

INSERT INTO public.agent_releases (version, storage_path, file_hash, file_size_bytes, is_latest, release_notes, artifact_type)
VALUES (
  '3.14.8',
  '3.14.8/app.asar',
  '38f8b6ecb60c4584563c50c1ecf412e8b7d9eeb74b4c55b8ac3d9a2802f182a6',
  10756301,
  true,
  'v3.14.8 — Polling sempre envia {0} ou {1} (nunca {} vazio, que a PLC ignora). Safety corrigido: se operador mandou DESLIGAR e a bomba não obedeceu (modo LOCAL), NÃO inverte para LIGAR — mantém desired=0 e alerta. Só inverte para OFF quando o comando era LIGAR.',
  'asar'
)
ON CONFLICT (version) DO UPDATE SET
  storage_path = EXCLUDED.storage_path,
  file_hash = EXCLUDED.file_hash,
  file_size_bytes = EXCLUDED.file_size_bytes,
  is_latest = true,
  release_notes = EXCLUDED.release_notes,
  artifact_type = EXCLUDED.artifact_type;