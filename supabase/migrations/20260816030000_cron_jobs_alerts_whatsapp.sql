-- ============================================================================
-- OITO JOBS DE ALERTA/WHATSAPP PASSAM A USAR cron_invoke() — com x-cron-secret.
-- ----------------------------------------------------------------------------
-- Estado atual:
--   • critical-alerts-tick-every-minute manda `current_setting('app.cron_secret')`,
--     que é NULL — o header vai vazio e a função devolve 401 desde sempre;
--   • os sete restantes usam a ANON KEY, que é pública. `whatsapp-automation-notify`
--     envia mensagem real pela Meta Cloud API, então a exposição é para fora.
--
-- O killswitch impede o ENVIO, não a INVOCAÇÃO. Esta migration fecha a porta.
--
-- NÃO cria, apaga, rotaciona nem duplica segredo. Usa o CRON_SECRET que já
-- existe no Vault e nas Edge Functions. Nenhum segredo literal aqui.
--
-- SCHEDULES e CORPOS: preservados exatamente. A migration LÊ o schedule e
-- EXTRAI o body jsonb do comando atual de cada job — nada hardcoded. Se o body
-- não puder ser extraído com segurança, o job é ABORTADO sem alteração.
--
-- ESCOPO: apenas os oito nomeados. Os jobs de bomba/watchdog já protegidos e
-- todos os demais ficam intocados — há verificação de contagem no fim.
--
-- Pré-requisito: public.cron_secret_configured() = true.
-- ============================================================================

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
  v_job text; v_sched text; v_cmd text; v_fn text; v_body text;
  v_outros_antes bigint; v_outros_depois bigint;
BEGIN
  IF NOT public.cron_secret_configured() THEN
    RAISE EXCEPTION 'CRON_SECRET ausente no Vault — nada foi alterado';
  END IF;

  SELECT count(*) INTO v_outros_antes
    FROM cron.job WHERE jobname <> ALL(v_jobs);

  FOREACH v_job IN ARRAY v_jobs LOOP
    SELECT schedule, command INTO v_sched, v_cmd FROM cron.job WHERE jobname = v_job;
    IF v_sched IS NULL THEN
      RAISE EXCEPTION 'job % não existe — abortado sem alterar nada', v_job;
    END IF;

    -- Função de destino: extraída da própria URL do comando atual.
    v_fn := substring(v_cmd from 'functions/v1/([a-z0-9-]+)');
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'não consegui identificar a função do job % — abortado', v_job;
    END IF;

    -- Corpo: preserva `batch_tick`, `immediate` e qualquer outro payload atual.
    -- Aceita as duas formas usadas hoje: literal '...'::jsonb ou jsonb_build_object(...).
    v_body := substring(v_cmd from 'body\s*:?=\s*''(\{[^'']*\})''');
    IF v_body IS NULL THEN
      v_body := substring(v_cmd from 'body\s*:?=\s*(jsonb_build_object\([^)]*\))');
      IF v_body IS NULL THEN
        -- Sem body identificável: só seguimos se realmente não houver body.
        IF v_cmd ~* 'body' THEN
          RAISE EXCEPTION 'job % tem body que não consegui extrair — abortado para não perder payload', v_job;
        END IF;
        v_body := '{}';
      END IF;
      -- forma construída: reaproveita a expressão como está
      INSERT INTO public.cron_job_backup (jobname, schedule, command)
      VALUES (v_job, v_sched, v_cmd);
      PERFORM cron.unschedule(v_job);
      PERFORM cron.schedule(v_job, v_sched,
        format('SELECT public.cron_invoke(%L, %s);', v_fn, v_body));
      RAISE NOTICE 'job % -> cron_invoke(%) [body construído preservado]', v_job, v_fn;
      CONTINUE;
    END IF;

    INSERT INTO public.cron_job_backup (jobname, schedule, command)
    VALUES (v_job, v_sched, v_cmd);

    PERFORM cron.unschedule(v_job);
    PERFORM cron.schedule(v_job, v_sched,
      format('SELECT public.cron_invoke(%L, %L::jsonb);', v_fn, v_body));

    RAISE NOTICE 'job % -> cron_invoke(%) [schedule e body preservados]', v_job, v_fn;
  END LOOP;

  SELECT count(*) INTO v_outros_depois
    FROM cron.job WHERE jobname <> ALL(v_jobs);
  IF v_outros_antes <> v_outros_depois THEN
    RAISE EXCEPTION 'TRAVA: os demais jobs mudaram de % para % — revertendo',
      v_outros_antes, v_outros_depois;
  END IF;
END $$;

-- ── Conferência: nenhum dos oito pode ter sobrado com anon key ou GUC vazio ─
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
     AND (command ILIKE '%net.http_post%'
          OR command ILIKE '%eyJ%'
          OR command ILIKE '%app.cron_secret%'
          OR command NOT ILIKE '%cron_invoke%');
  IF v_ruim IS NOT NULL THEN
    RAISE EXCEPTION 'jobs ainda inseguros: %', v_ruim;
  END IF;
END $$;

-- ============================================================================
-- VALIDAÇÃO
--   -- 1) os oito usam cron_invoke, com body preservado:
--   SELECT jobname, schedule, command FROM cron.job
--    WHERE jobname LIKE 'whatsapp-automation-notify%' OR jobname LIKE 'wa-batch-tick%'
--       OR jobname = 'critical-alerts-tick-every-minute' ORDER BY jobname;
--
--   -- 2) schedule e body iguais aos de antes:
--   SELECT b.jobname, b.schedule AS antes, j.schedule AS depois,
--          (b.schedule = j.schedule) AS schedule_igual,
--          substring(b.command from 'body[^,]*') AS body_antes,
--          substring(j.command from 'cron_invoke\(.*') AS chamada_depois
--     FROM public.cron_job_backup b JOIN cron.job j USING (jobname)
--    WHERE b.jobname = ANY(ARRAY['critical-alerts-tick-every-minute',
--          'whatsapp-automation-notify-every-minute','wa-batch-tick-every-minute'])
--    ORDER BY b.jobname, b.backed_up_at DESC;
--
--   -- 3) os jobs de bomba/watchdog já protegidos NÃO mudaram:
--   SELECT jobname, command FROM cron.job
--    WHERE jobname IN ('scheduled-shutdown-semear-17h','agent-offline-watchdog-tick',
--                      'agent-offline-watchdog-every-minute','security-anomaly-watchdog-tick',
--                      'well-hours-watchdog-tick','whatsapp-alerts-healthcheck-daily');
--
--   -- 4) critical-alerts-tick deixou de dar 401:
--   SELECT status_code, left(content,200), created FROM net._http_response
--    ORDER BY created DESC LIMIT 30;
--
-- ROLLBACK POR JOB:
--   DO $r$
--   DECLARE b record;
--   BEGIN
--     SELECT * INTO b FROM public.cron_job_backup
--      WHERE jobname = '<NOME-DO-JOB>' ORDER BY backed_up_at DESC LIMIT 1;
--     PERFORM cron.unschedule(b.jobname);
--     PERFORM cron.schedule(b.jobname, b.schedule, b.command);
--   END $r$;
--   -- Atenção: o rollback devolve a anon key ao comando. Se a Edge Function já
--   -- estiver publicada com a guarda, o job passará a receber 401/403.
-- ============================================================================
