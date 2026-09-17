-- lovable-cron-fallback-reviewed: 1440 runs/day; scheduled-shutdown é config-driven por minuto (janelas 17:45/17:47/17:49 da Sossego e 17:00-17:15 da Semear); substitui cron existente de mesma função, comando reaproveitado verbatim, exigido pelo cliente.
-- ============================================================================
-- CRON DO DESLIGAMENTO PROGRAMADO: de hardcoded-SEMEAR para GLOBAL por minuto. (V2)
-- ----------------------------------------------------------------------------
-- CAUSA (confirmada em produção)
--   O job ativo é `scheduled-shutdown-semear-17h` com `0-20 20 * * 1-5`, ou seja
--   17:00–17:20 BRT. O nome e a cadência são da SEMEAR.
--
--   A Edge Function `scheduled-shutdown` é config-driven: para cada regra de
--   `scheduled_automations` ela calcula
--       elapsed   = minuto_do_dia − time_brt
--       windowEnd = max_retries × retry_interval_min
--   e só age quando `0 <= elapsed <= windowEnd` (index.ts:92-96).
--
--   SEMEAR  17:00, 5 min × 3 → janela 17:00–17:15 → ticks em 00/05/10/15 ✔
--   SOSSEGO 17:45, 2 min × 2 → janela 17:45–17:49 → NENHUM tick ✘
--
--   A regra da SOSSEGO nunca é avaliada. Não é bug da função nem da config.
--
-- POR QUE NÃO REAPLICAR `20260807190000_scheduled_automations.sql`
--   Aquela é a migration de criação da feature inteira. Reaplicá-la executaria
--   CREATE TABLE, quatro DROP/CREATE POLICY, DROP CONSTRAINT, e — o mais grave —
--   o INSERT de seed da regra "Desligamento 17h Semear" (linhas 85-91), cujo
--   `ON CONFLICT (farm_id, name)` não protege se o nome da regra tiver mudado em
--   produção: criaria uma SEGUNDA regra de desligamento para a SEMEAR.
--   Esta migration faz APENAS o cron.
--
-- AUTENTICAÇÃO
--   O comando do job atual é REAPROVEITADO VERBATIM; só o schedule muda. Assim a
--   autenticação continua exatamente a de hoje (o job usa apikey/Authorization,
--   não CRON_SECRET), não há risco novo de 401, e NENHUMA chave literal aparece
--   neste arquivo.
--
-- POR QUE EXISTE A V2
--   A V1 (20260903120000) abortou corretamente, sem alterar nada:
--     P0001: O comando do job scheduled-shutdown-semear-17h não chama
--            scheduled-shutdown — abortado sem alterar nada.
--   Ela validava o formato HTTP direto (`functions/v1/scheduled-shutdown`),
--   mas o comando real em produção usa o wrapper:
--       SELECT public.cron_invoke('scheduled-shutdown');
--   ÚNICA diferença da V1 para a V2: o reconhecimento do comando. Todo o
--   restante da lógica é idêntico.
--
-- ESCOPO: um único job. Nenhuma tabela, policy, regra, horário, Edge Function,
-- fazenda ou outro cron é tocado. Há trava que aborta se algo além disso mudar.
-- ============================================================================

DO $$
DECLARE
  v_old_name  text := 'scheduled-shutdown-semear-17h';
  v_new_name  text := 'scheduled-automations-tick';
  v_cmd       text;
  v_cmd_sem_comentario text;
  -- Reconhecimento do ALVO do job. Dois formatos aceitos:
  --   (a) wrapper atual  → public.cron_invoke('scheduled-shutdown'[, ...])
  --   (b) HTTP legado    → .../functions/v1/scheduled-shutdown
  -- Tolera espaços, caixa e argumentos extras. NÃO é uma busca solta pela
  -- palavra: exige a sintaxe da chamada e que o argumento seja exatamente
  -- 'scheduled-shutdown' (o `[,)]` final impede casar 'scheduled-shutdown-x').
  c_re_wrapper CONSTANT text :=
    '(^|[^a-z0-9_])(public\s*\.\s*)?cron_invoke\s*\(\s*''scheduled-shutdown''\s*[,)]';
  c_re_http    CONSTANT text :=
    '/functions/v1/scheduled-shutdown([^a-z0-9_-]|$)';
  v_outros_antes  bigint;
  v_outros_depois bigint;
  v_chamadores    bigint;
BEGIN
  -- Quantos jobs existem FORA dos dois nomes? Tem de ser o mesmo no fim.
  SELECT count(*) INTO v_outros_antes
    FROM cron.job WHERE jobname NOT IN (v_old_name, v_new_name);

  -- Comando de origem: preferimos o do job antigo; se já houver o novo, o dele.
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = v_old_name;
  IF v_cmd IS NULL THEN
    SELECT command INTO v_cmd FROM cron.job WHERE jobname = v_new_name;
  END IF;

  IF v_cmd IS NULL THEN
    RAISE EXCEPTION
      'Nenhum job (% nem %) encontrado — nada foi alterado. Verifique cron.job antes de aplicar.',
      v_old_name, v_new_name;
  END IF;

  -- O comando TEM de CHAMAR scheduled-shutdown. Comentários são removidos antes
  -- de casar, para que uma menção comentada não seja confundida com chamada.
  v_cmd_sem_comentario := regexp_replace(v_cmd, '--[^\n]*', '', 'g');
  IF NOT (v_cmd_sem_comentario ~* c_re_wrapper
          OR v_cmd_sem_comentario ~* c_re_http) THEN
    RAISE EXCEPTION
      'O comando do job % não chama scheduled-shutdown — abortado sem alterar nada. Comando: %',
      COALESCE(v_old_name, v_new_name), left(v_cmd, 200);
  END IF;

  -- Remove os dois nomes (idempotência: aplicar duas vezes não duplica).
  BEGIN PERFORM cron.unschedule(v_old_name); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM cron.unschedule(v_new_name); EXCEPTION WHEN OTHERS THEN NULL; END;

  -- Um único job global, a cada minuto. A própria Edge Function decide quais
  -- regras estão dentro da janela — sem cron por fazenda, sem hardcode.
  PERFORM cron.schedule(v_new_name, '* * * * *', v_cmd);

  -- ── Travas ───────────────────────────────────────────────────────────────
  SELECT count(*) INTO v_chamadores
    FROM cron.job
   WHERE regexp_replace(command, '--[^\n]*', '', 'g') ~* c_re_wrapper
      OR regexp_replace(command, '--[^\n]*', '', 'g') ~* c_re_http;
  IF v_chamadores <> 1 THEN
    RAISE EXCEPTION
      'TRAVA: % jobs chamam scheduled-shutdown (esperado 1) — revertendo.', v_chamadores;
  END IF;

  SELECT count(*) INTO v_outros_depois
    FROM cron.job WHERE jobname NOT IN (v_old_name, v_new_name);
  IF v_outros_antes <> v_outros_depois THEN
    RAISE EXCEPTION
      'TRAVA: os demais jobs mudaram de % para % — revertendo.',
      v_outros_antes, v_outros_depois;
  END IF;

  RAISE NOTICE 'cron: % removido, % agendado com * * * * * (comando preservado)',
    v_old_name, v_new_name;
END $$;

-- ============================================================================
-- VALIDAÇÃO (rodar depois)
--   -- 1) exatamente UM job, a cada minuto:
--   SELECT jobname, schedule, active, command FROM cron.job
--    WHERE command ILIKE '%cron_invoke%scheduled-shutdown%'
--       OR command ILIKE '%functions/v1/scheduled-shutdown%';
--   -- esperado: scheduled-automations-tick | * * * * * | t
--
--   -- 2) o job antigo sumiu:
--   SELECT count(*) FROM cron.job WHERE jobname = 'scheduled-shutdown-semear-17h';
--   -- esperado: 0
--
--   -- 3) sem 401 e sem duplicidade no mesmo minuto:
--   SELECT status_code, count(*), min(created), max(created)
--     FROM net._http_response WHERE created > now() - interval '10 minutes'
--    GROUP BY status_code;
--
--   -- 4) a SOSSEGO passou a ser avaliada (rodar depois das 17:49 BRT):
--   SELECT f.name, s.run_date, s.attempt, s.status, s.steps_done
--     FROM public.scheduled_shutdowns s JOIN public.farms f ON f.id = s.farm_id
--    WHERE s.run_date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
--    ORDER BY f.name;
--
--   -- 5) a SEMEAR continua igual:
--   SELECT name, time_brt, retry_interval_min, max_retries, is_active, last_run_at
--     FROM public.scheduled_automations ORDER BY time_brt;
--
-- ROLLBACK (volta ao cron antigo, REABRINDO o problema da SOSSEGO):
--   DO $r$
--   DECLARE v_cmd text;
--   BEGIN
--     SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'scheduled-automations-tick';
--     PERFORM cron.unschedule('scheduled-automations-tick');
--     PERFORM cron.schedule('scheduled-shutdown-semear-17h', '0-20 20 * * 1-5', v_cmd);
--   END $r$;
-- ============================================================================