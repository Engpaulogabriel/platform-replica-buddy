DO $$
DECLARE
  v_jobs text[] := ARRAY[
    'critical-alerts-tick-every-minute',
    'whatsapp-automation-notify-every-minute',
    'whatsapp-automation-notify-every-10s-10',
    'whatsapp-automation-notify-every-10s-20',
    'whatsapp-automation-notify-every-10s-30',
    'whatsapp-automation-notify-every-10s-40',
    'whatsapp-automation-notify-every-10s-50',
    'wa-batch-tick-every-minute'
  ];
  v_job text; v_sched text; v_cmd text; v_fn text; v_body text; v_new text;
  v_sleep text; v_lo text; v_hi text; v_loop_sleep text;
  v_outros_antes bigint; v_outros_depois bigint;
BEGIN
  IF NOT public.cron_secret_configured() THEN
    RAISE EXCEPTION 'CRON_SECRET ausente no Vault — nada foi alterado';
  END IF;

  SELECT count(*) INTO v_outros_antes FROM cron.job WHERE jobname <> ALL(v_jobs);

  FOREACH v_job IN ARRAY v_jobs LOOP
    SELECT schedule, command INTO v_sched, v_cmd FROM cron.job WHERE jobname = v_job;
    IF v_sched IS NULL THEN
      RAISE EXCEPTION 'job % não existe — abortado sem alterar nada', v_job;
    END IF;

    v_fn := substring(v_cmd from 'functions/v1/([a-z0-9-]+)');
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'não consegui identificar a função do job % — abortado', v_job;
    END IF;

    v_body := substring(v_cmd from 'body\s*:?=\s*''(\{[^'']*\})''');
    IF v_body IS NULL THEN
      IF v_cmd ~* 'body' THEN
        RAISE EXCEPTION 'job % tem body que não consegui extrair — abortado', v_job;
      END IF;
      v_body := '{}';
    END IF;

    v_sleep      := substring(v_cmd from '^\s*SELECT\s+pg_sleep\((\d+)\)');
    v_lo         := substring(v_cmd from 'FOR\s+i\s+IN\s+(\d+)\s*\.\.\s*\d+\s+LOOP');
    v_hi         := substring(v_cmd from 'FOR\s+i\s+IN\s+\d+\s*\.\.\s*(\d+)\s+LOOP');
    v_loop_sleep := substring(v_cmd from 'LOOP.*pg_sleep\((\d+)\)');

    IF v_lo IS NOT NULL AND v_hi IS NOT NULL THEN
      v_new := format('DO $INNER$ DECLARE i int; BEGIN FOR i IN %s..%s LOOP PERFORM public.cron_invoke(%L, %L::jsonb); PERFORM pg_sleep(%s); END LOOP; END $INNER$;',
                      v_lo, v_hi, v_fn, v_body, COALESCE(v_loop_sleep, '5'));
    ELSIF v_sleep IS NOT NULL THEN
      v_new := format('SELECT pg_sleep(%s); SELECT public.cron_invoke(%L, %L::jsonb);', v_sleep, v_fn, v_body);
    ELSE
      v_new := format('SELECT public.cron_invoke(%L, %L::jsonb);', v_fn, v_body);
    END IF;

    INSERT INTO public.cron_job_backup (jobname, schedule, command) VALUES (v_job, v_sched, v_cmd);
    PERFORM cron.unschedule(v_job);
    PERFORM cron.schedule(v_job, v_sched, v_new);
    RAISE NOTICE 'job % -> cron_invoke(%)', v_job, v_fn;
  END LOOP;

  SELECT count(*) INTO v_outros_depois FROM cron.job WHERE jobname <> ALL(v_jobs);
  IF v_outros_antes <> v_outros_depois THEN
    RAISE EXCEPTION 'TRAVA: os demais jobs mudaram de % para % — revertendo', v_outros_antes, v_outros_depois;
  END IF;
END $$;

DO $$
DECLARE v_ruim text;
BEGIN
  SELECT string_agg(jobname, ', ') INTO v_ruim
    FROM cron.job
   WHERE jobname IN ('critical-alerts-tick-every-minute',
                     'whatsapp-automation-notify-every-minute',
                     'whatsapp-automation-notify-every-10s-10',
                     'whatsapp-automation-notify-every-10s-20',
                     'whatsapp-automation-notify-every-10s-30',
                     'whatsapp-automation-notify-every-10s-40',
                     'whatsapp-automation-notify-every-10s-50',
                     'wa-batch-tick-every-minute')
     AND (command ILIKE '%net.http_post%' OR command ILIKE '%eyJ%'
          OR command ILIKE '%app.cron_secret%' OR command NOT ILIKE '%cron_invoke%');
  IF v_ruim IS NOT NULL THEN
    RAISE EXCEPTION 'jobs ainda inseguros: %', v_ruim;
  END IF;
END $$;