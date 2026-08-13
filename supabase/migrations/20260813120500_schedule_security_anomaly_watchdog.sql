-- Agenda o security-anomaly-watchdog no pg_cron (a cada 5 min) ───────────────
-- Varre user_activity_log / export_log e alerta super_admins no WhatsApp:
--   > 50 páginas distintas em 5 min · > 5 PDFs em 10 min (dedup 1h por usuário).
-- Requer config.toml [functions.security-anomaly-watchdog] verify_jwt = false.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM cron.unschedule('security-anomaly-watchdog-tick');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'security-anomaly-watchdog-tick',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://dnyukgfedredvxpzjpqz.supabase.co/functions/v1/security-anomaly-watchdog',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk',
      'Content-Type',  'application/json'
    ),
    body := jsonb_build_object('source','pg_cron','ts', now())
  );
  $cron$
);
