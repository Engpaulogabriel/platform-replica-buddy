-- Espaço livre em disco no heartbeat (monitoramento) ────────────────────────
-- O agente v3.25.53 reporta disk_free_mb a cada heartbeat; < 2 GB também vira
-- last_error='disk_low'. Serve para acompanhar os PCs de fazenda enchendo.
ALTER TABLE public.site_health
  ADD COLUMN IF NOT EXISTS disk_free_mb integer;

COMMENT ON COLUMN public.site_health.disk_free_mb IS
  'Espaço livre no disco do PC da fazenda (MB), reportado pelo agente. Ver limpeza de disco (v3.25.53).';
