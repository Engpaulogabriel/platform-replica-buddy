
UPDATE public.agent_releases SET is_latest = false WHERE is_latest = true;

INSERT INTO public.agent_releases (version, artifact_type, storage_path, file_hash, file_size_bytes, is_latest, mandatory, release_notes)
VALUES (
  '3.14.2',
  'asar',
  '3.14.2/app.asar',
  'cbb08b3f2753d8e00c35e50c98dfab8ddfcc26bd9d38ab306890a8516ccfdff5',
  11007344,
  true,
  false,
  'Fix: RX CFG (PING/STATUS/DUMP) agora casa com comando pendente e grava status=executed + response na tabela commands. Adiciona logs [CFG RX], [CFG UPDATE OK] e [CFG UPDATE FAIL] para diagnóstico.'
)
ON CONFLICT (version) DO UPDATE SET
  storage_path = EXCLUDED.storage_path,
  file_hash = EXCLUDED.file_hash,
  file_size_bytes = EXCLUDED.file_size_bytes,
  is_latest = true,
  release_notes = EXCLUDED.release_notes;
