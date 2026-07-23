-- Registra release v3.25.4 do agente e desmarca versões anteriores como latest.
UPDATE public.agent_releases SET is_latest = false WHERE is_latest = true;

INSERT INTO public.agent_releases (
  version, artifact_type, storage_path, file_hash, file_size_bytes,
  is_latest, mandatory, release_notes, download_url
) VALUES (
  '3.25.4', 'asar', '3.25.4/app.asar',
  '006287226ca5547f56faa80d5df4750abaab884da4021f74ead51e49f12a9e65',
  10763929, true, false,
  'v3.25.4 — Sequência de meia-noite unificada: polling normal captura N2 final do dia (grava daily_consumption com data de ontem) + polling com RV com retry (0/6/12/18s) até confirmação. Elimina janela de perda entre última leitura e reset.',
  null
)
ON CONFLICT (version) DO UPDATE SET
  storage_path = EXCLUDED.storage_path,
  file_hash = EXCLUDED.file_hash,
  file_size_bytes = EXCLUDED.file_size_bytes,
  is_latest = true,
  mandatory = EXCLUDED.mandatory,
  release_notes = EXCLUDED.release_notes;