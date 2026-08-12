-- Agenda o well-hours-watchdog no pg_cron (a cada 10 min) ────────────────────
-- Checa horas operadas hoje × limite diário da outorga por poço; quando faltar
-- ≤ 1h, dispara WhatsApp ao técnico da fazenda (whatsapp_alert_settings).
-- Requer config.toml [functions.well-hours-watchdog] verify_jwt = false (senão 401).
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM cron.unschedule('well-hours-watchdog-tick');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'well-hours-watchdog-tick',
  '*/10 * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://dnyukgfedredvxpzjpqz.supabase.co/functions/v1/well-hours-watchdog',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk',
      'Content-Type',  'application/json'
    ),
    body := jsonb_build_object('source','pg_cron','ts', now())
  );
  $cron$
);
