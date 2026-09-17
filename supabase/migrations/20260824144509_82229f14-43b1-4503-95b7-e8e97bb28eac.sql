SELECT cron.unschedule('agent-logs-cleanup-6h') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agent-logs-cleanup-6h');
SELECT cron.schedule('agent-logs-cleanup-6h', '0 */6 * * *', $$SELECT public.cron_invoke('agent-logs-cleanup', '{}'::jsonb);$$);

SELECT cron.unschedule('command-verifier-tick') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'command-verifier-tick');
SELECT cron.schedule('command-verifier-tick', '* * * * *', $$SELECT public.cron_invoke('command-verifier', '{}'::jsonb);$$);

SELECT cron.unschedule('command-verifier-tick-30') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'command-verifier-tick-30');
SELECT cron.schedule('command-verifier-tick-30', '* * * * *', $$SELECT pg_sleep(30); SELECT public.cron_invoke('command-verifier', '{}'::jsonb);$$);

SELECT cron.unschedule('peak-hours-alert') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'peak-hours-alert');
SELECT cron.schedule('peak-hours-alert', '0 21 * * 1-5', $$SELECT public.cron_invoke('whatsapp-alerts', '{"alert_type":"peak_hours"}'::jsonb);$$);

DROP POLICY IF EXISTS inema_daily_select ON public.inema_daily_compliance;
CREATE POLICY inema_daily_select ON public.inema_daily_compliance FOR SELECT TO authenticated
  USING (farm_id IN (SELECT ur.farm_id FROM public.user_roles ur WHERE ur.user_id = auth.uid()));

DROP POLICY IF EXISTS "service_role manages alert log" ON public.whatsapp_alerts_log;

DROP POLICY IF EXISTS device_links_insert_admin ON public.device_register_links;
CREATE POLICY device_links_insert_admin ON public.device_register_links FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin(auth.uid()));