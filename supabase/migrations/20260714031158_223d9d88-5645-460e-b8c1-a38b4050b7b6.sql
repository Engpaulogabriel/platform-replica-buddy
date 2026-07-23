
UPDATE public.agent_releases SET is_latest = false WHERE is_latest = true;

INSERT INTO public.agent_releases (version, artifact_type, storage_path, file_hash, file_size_bytes, is_latest, mandatory, release_notes, download_url)
VALUES (
  '3.15.0',
  'asar',
  '3.15.0/app.asar',
  '933aae942f6801a351515b7878e7c70e54e4cd753bf0f1dc3374e4bca6060ab7',
  11199002,
  true,
  false,
  'Baseada em v3.14.0 original. Única mudança: fireSafetyOff agora atualiza last_actuation_origin=''local'' junto com safety_expired_at, permitindo que o badge LOCAL apareça no card da bomba quando safety timer expira.',
  NULL
)
ON CONFLICT (version) DO UPDATE SET
  storage_path = EXCLUDED.storage_path,
  file_hash = EXCLUDED.file_hash,
  file_size_bytes = EXCLUDED.file_size_bytes,
  is_latest = true,
  release_notes = EXCLUDED.release_notes;
