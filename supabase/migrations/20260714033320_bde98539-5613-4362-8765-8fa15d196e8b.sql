
UPDATE public.agent_releases SET is_latest = false WHERE is_latest = true;

INSERT INTO public.agent_releases (
  version, download_url, storage_path, artifact_type,
  file_hash, file_size_bytes, is_latest, mandatory,
  release_notes, published_at
) VALUES (
  '3.18.0',
  'https://dnyukgfedredvxpzjpqz.supabase.co/storage/v1/object/public/agent-releases/3.18.0/app.asar',
  '3.18.0/app.asar',
  'asar',
  'f3de94ac008b75d4e1702624eb6fc8ed6f5e1d8f9365c00cf341a53de637c384',
  10956996,
  true,
  false,
  'v3.18.0 — Auto-discovery de porta COM. Ordem: last_working_com.txt → agent_config → scan de todas as COMs do sistema. Uma porta só é considerada válida se produzir frame RENOV (telemetria/CFG) em até 20s; caso contrário é descartada e a próxima é testada. Se nenhuma responder, retry a cada 30s. A porta confirmada é salva localmente e sincronizada em agent_config.',
  now()
);
