-- ============================================================================
-- REAPONTA OS SEIS JOBS AGENDADOS PARA cron_invoke() — com x-cron-secret.
-- O SEGREDO NÃO APARECE NESTE ARQUIVO. Schedules preservados exatamente.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.cron_job_backup (
  id          bigserial PRIMARY KEY,
  jobname     text NOT NULL,
  schedule    text NOT NULL,
  command     text NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.cron_job_backup TO service_role;
GRANT ALL ON SEQUENCE public.cron_job_backup_id_seq TO service_role;
ALTER TABLE public.cron_job_backup ENABLE ROW LEVEL SECURITY;
-- sem policy: só service_role/superuser lê. O command antigo contém a anon key.

DO $$
DECLARE
  v_map jsonb := jsonb_build_object(
    'scheduled-shutdown-semear-17h',        'scheduled-shutdown',
    'agent-offline-watchdog-every-minute',  'agent-offline-watchdog',
    'agent-offline-watchdog-tick',          'agent-offline-watchdog',
    'security-anomaly-watchdog-tick',       'security-anomaly-watchdog',
    'well-hours-watchdog-tick',             'well-hours-watchdog',
    'whatsapp-alerts-healthcheck-daily',    'whatsapp-alerts-healthcheck'
  );
  v_job text; v_fn text; v_sched text; v_cmd text;
  v_outros_antes bigint; v_outros_depois bigint;
BEGIN
  IF NOT public.cron_secret_configured() THEN
    RAISE EXCEPTION 'CRON_SECRET ausente no Vault — aplique o passo 2 antes desta migration';
  END IF;

  SELECT count(*) INTO v_outros_antes
    FROM cron.job WHERE jobname NOT IN (SELECT jsonb_object_keys(v_map));

  FOR v_job, v_fn IN SELECT key, value #>> '{}' FROM jsonb_each(v_map) LOOP
    SELECT schedule, command INTO v_sched, v_cmd
      FROM cron.job WHERE jobname = v_job;

    IF v_sched IS NULL THEN
      RAISE EXCEPTION 'job % não existe — abortado sem alterar nada', v_job;
    END IF;

    INSERT INTO public.cron_job_backup (jobname, schedule, command)
    VALUES (v_job, v_sched, v_cmd);

    PERFORM cron.unschedule(v_job);
    PERFORM cron.schedule(v_job, v_sched,
      format('SELECT public.cron_invoke(%L);', v_fn));

    RAISE NOTICE 'job % -> cron_invoke(%) [schedule preservado]', v_job, v_fn;
  END LOOP;

  SELECT count(*) INTO v_outros_depois
    FROM cron.job WHERE jobname NOT IN (SELECT jsonb_object_keys(v_map));

  IF v_outros_antes <> v_outros_depois THEN
    RAISE EXCEPTION 'TRAVA: os demais jobs mudaram de % para % — revertendo',
      v_outros_antes, v_outros_depois;
  END IF;
END $$;

DO $$
DECLARE v_ruim text;
BEGIN
  SELECT string_agg(jobname, ', ') INTO v_ruim
    FROM cron.job
   WHERE jobname IN ('scheduled-shutdown-semear-17h','agent-offline-watchdog-every-minute',
                     'agent-offline-watchdog-tick','security-anomaly-watchdog-tick',
                     'well-hours-watchdog-tick','whatsapp-alerts-healthcheck-daily')
     AND (command ILIKE '%net.http_post%' OR command ILIKE '%eyJ%' OR command NOT ILIKE '%cron_invoke%');
  IF v_ruim IS NOT NULL THEN
    RAISE EXCEPTION 'jobs ainda sem cron_invoke: %', v_ruim;
  END IF;
END $$;