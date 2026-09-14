-- ============================================================================
-- REAPONTA OS SEIS JOBS AGENDADOS PARA cron_invoke() — com x-cron-secret.
-- ----------------------------------------------------------------------------
-- Hoje esses jobs chamam as Edge Functions com a ANON KEY, que é pública. Aqui
-- eles passam a mandar o CRON_SECRET, lido do Vault em tempo de execução.
--
-- O SEGREDO NÃO APARECE NESTE ARQUIVO. Nem literal, nem em log, nem em NOTICE.
--
-- SCHEDULES: preservados exatamente. A migration LÊ o schedule atual de cada
-- job em `cron.job` e reagenda com o mesmo — não há horário hardcoded aqui,
-- justamente para não introduzir divergência.
--
-- ESCOPO: apenas os seis jobs nomeados. Qualquer outro job existente fica
-- intocado — há verificação no fim que aborta se a contagem dos demais mudar.
--
-- Pré-requisito: 20260816010000_cron_secret_vault.sql aplicada e
--                SELECT public.cron_secret_configured() = true.
-- ============================================================================

-- ── 0) Backup exato do estado atual, para rollback por job ─────────────────
CREATE TABLE IF NOT EXISTS public.cron_job_backup (
  id          bigserial PRIMARY KEY,
  jobname     text NOT NULL,
  schedule    text NOT NULL,
  command     text NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cron_job_backup ENABLE ROW LEVEL SECURITY;
-- sem policy: só service_role/superuser lê. O command antigo contém a anon key.

DO $$
DECLARE
  -- job → Edge Function. Dois jobs apontam para agent-offline-watchdog; isso é
  -- o estado atual e foi preservado como está (não cabe a esta migration
  -- decidir se um deles é redundante).
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

  -- Quantos jobs existem FORA da nossa lista? Tem de ser o mesmo no fim.
  SELECT count(*) INTO v_outros_antes
    FROM cron.job WHERE jobname NOT IN (SELECT jsonb_object_keys(v_map));

  FOR v_job, v_fn IN SELECT key, value #>> '{}' FROM jsonb_each(v_map) LOOP
    SELECT schedule, command INTO v_sched, v_cmd
      FROM cron.job WHERE jobname = v_job;

    IF v_sched IS NULL THEN
      RAISE EXCEPTION 'job % não existe — abortado sem alterar nada', v_job;
    END IF;

    -- guarda o comando ORIGINAL antes de trocar (rollback exato)
    INSERT INTO public.cron_job_backup (jobname, schedule, command)
    VALUES (v_job, v_sched, v_cmd);

    -- reagenda com o MESMO schedule, trocando só COMO a função é chamada
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

-- ── Conferência: nenhum dos seis pode ter sobrado com anon key ─────────────
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

-- ============================================================================
-- VALIDAÇÃO (rodar depois)
--   -- 1) os seis usam cron_invoke e nenhum tem token embutido:
--   SELECT jobname, schedule, command FROM cron.job
--    WHERE jobname IN ('scheduled-shutdown-semear-17h','agent-offline-watchdog-every-minute',
--                      'agent-offline-watchdog-tick','security-anomaly-watchdog-tick',
--                      'well-hours-watchdog-tick','whatsapp-alerts-healthcheck-daily')
--    ORDER BY jobname;
--
--   -- 2) os OUTROS 22 continuam idênticos (compare com o print de antes):
--   SELECT count(*) AS outros, string_agg(jobname, ', ' ORDER BY jobname)
--     FROM cron.job WHERE jobname NOT IN (...os seis acima...);
--
--   -- 3) resposta de cada disparo (200 esperado; 401/403 = segredo divergente):
--   SELECT r.id, r.status_code, left(r.content, 200) AS corpo, r.created
--     FROM net._http_response r ORDER BY r.created DESC LIMIT 20;
--
--   -- 4) schedules preservados: compare com o backup
--   SELECT b.jobname, b.schedule AS antes, j.schedule AS depois,
--          (b.schedule = j.schedule) AS igual
--     FROM public.cron_job_backup b JOIN cron.job j USING (jobname)
--    ORDER BY b.jobname;
--
-- ROLLBACK POR JOB (restaura o comando original, com o schedule original):
--   DO $r$
--   DECLARE b record;
--   BEGIN
--     SELECT * INTO b FROM public.cron_job_backup
--      WHERE jobname = '<NOME-DO-JOB>' ORDER BY backed_up_at DESC LIMIT 1;
--     PERFORM cron.unschedule(b.jobname);
--     PERFORM cron.schedule(b.jobname, b.schedule, b.command);
--   END $r$;
--
-- ROLLBACK DE TODOS: repita o bloco acima para cada um dos seis nomes.
-- Observação: o rollback devolve a anon key ao comando — é reversão de
-- emergência, não estado desejado. Se precisar dele, republique também as
-- Edge Functions sem a guarda, ou os jobs passarão a receber 401/403.
-- ============================================================================
