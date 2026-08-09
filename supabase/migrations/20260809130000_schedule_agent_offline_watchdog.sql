-- Agenda o agent-offline-watchdog no pg_cron ────────────────────────────────
-- BUG: o watchdog NUNCA foi agendado (nenhum cron.schedule existia) E não estava
-- no config.toml (verify_jwt=true → 401). Resultado: nenhum alerta offline/serial
-- disparou — 3 fazendas caíram e ninguém foi avisado. Esta migração agenda a
-- verificação a cada 2 min. (config.toml passa a ter verify_jwt=false p/ o 401.)
-- Detecta: agente offline (heartbeat>5min), bridge caída (agente online + serial
-- morta), e 3+ equipamentos sem comunicação (>3min). Anti-spam + recovery no notify.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM cron.unschedule('agent-offline-watchdog-tick');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'agent-offline-watchdog-tick',
  '*/2 * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://dnyukgfedredvxpzjpqz.supabase.co/functions/v1/agent-offline-watchdog',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk',
      'Content-Type',  'application/json'
    ),
    body := jsonb_build_object('source','pg_cron','ts', now())
  );
  $cron$
);
