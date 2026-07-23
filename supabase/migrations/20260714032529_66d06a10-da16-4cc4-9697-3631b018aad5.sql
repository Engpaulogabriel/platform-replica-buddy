
UPDATE public.agent_releases SET is_latest = false WHERE is_latest = true;

INSERT INTO public.agent_releases (version, artifact_type, storage_path, file_hash, file_size_bytes, is_latest, mandatory, release_notes, download_url)
VALUES (
  '3.17.0',
  'asar',
  '3.17.0/app.asar',
  'b70a2d90aabbe9b0834835cbca182520f6b30ade9ba5d2a2de4035f0396d0847',
  11225190,
  true,
  false,
  'Base v3.16.0 + Watchdog de alertas técnicos via WhatsApp APENAS para admins RENOV. Dispara para whatsapp-automation-notify (source=electron_watchdog) nos casos: bridge_down (bridge caiu), pumps_offline (50%+ poços sem RX 5min), com_missing (nenhuma COM abriu). Recovery pareado quando restabelece. Anti-spam de 10min por tipo/fazenda no backend. Cron agent-offline-watchdog a cada 1min detecta heartbeat > 3min.',
  NULL
)
ON CONFLICT (version) DO UPDATE SET
  storage_path = EXCLUDED.storage_path,
  file_hash = EXCLUDED.file_hash,
  file_size_bytes = EXCLUDED.file_size_bytes,
  is_latest = true,
  release_notes = EXCLUDED.release_notes;
