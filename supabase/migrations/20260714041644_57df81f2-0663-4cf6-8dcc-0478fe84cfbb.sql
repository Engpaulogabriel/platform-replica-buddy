UPDATE public.agent_releases SET is_latest = false WHERE is_latest = true;

INSERT INTO public.agent_releases (version, artifact_type, storage_path, file_hash, file_size_bytes, is_latest, mandatory, release_notes, download_url)
VALUES (
  '3.22.0',
  'asar',
  '3.22.0/app.asar',
  '394554848c5454c9f816b592062538da35930b2fdffda887d4c9acf26a295c22',
  11472843,
  true,
  true,
  'Recomeço do baseline 3.14.0 + 3 mudanças cirúrgicas: (1) last_actuation_origin=local em fireSafetyOff; (2) persiste última COM funcional em last_working_com.txt; (3) AGENT_VERSION=3.22.0.',
  null
)
ON CONFLICT (version) DO UPDATE SET
  storage_path = EXCLUDED.storage_path,
  file_hash = EXCLUDED.file_hash,
  file_size_bytes = EXCLUDED.file_size_bytes,
  is_latest = EXCLUDED.is_latest,
  mandatory = EXCLUDED.mandatory,
  release_notes = EXCLUDED.release_notes;