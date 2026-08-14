-- ============================================================================
-- RECONCILIAÇÃO CIRÚRGICA — lote remoto comprovado (1 fazenda, 1 janela, 1 autor)
-- ----------------------------------------------------------------------------
-- Este arquivo NÃO é migration. É uma correção pontual, de execução manual e em
-- DUAS ETAPAS: primeiro conferir (PARTE A), só depois atribuir (PARTE B).
--
-- Escopo travado: uma fazenda, uma janela de 2 minutos, ação de ligar, origem
-- remota, user_id nulo. Nenhum outro evento, equipamento, fazenda ou pendência
-- é tocado. A PARTE B ABORTA se a contagem não for exatamente 13.
--
-- Fuso: a janela é convertida com America/Sao_Paulo. (Em 08/2026 é idêntico a
-- America/Bahia, usado noutros pontos do sistema — o Brasil não tem mais horário
-- de verão; anotado apenas para não haver dúvida na auditoria.)
-- ============================================================================

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ PARTE A — SOMENTE LEITURA. Rode isto primeiro e confira o resultado.      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
SELECT
  al.id,
  al.equipment_name                                             AS equipamento,
  to_char(al.occurred_at AT TIME ZONE 'America/Sao_Paulo',
          'DD/MM/YYYY HH24:MI:SS')                              AS horario_brt,
  al.action::text                                               AS acao,
  al.origin::text                                               AS origem,
  al.actor_label                                                AS ator,
  al.user_id,
  al.user_email,
  al.result::text                                               AS resultado,
  al.noise_reason,
  al.details->>'confirmation_method'                            AS metodo_confirmacao,
  al.details->>'authorship_source'                              AS autoria_atual,
  al.details->>'origin'                                         AS origem_declarada_agente,
  (SELECT count(*) FROM public.authorship_pending_review r
    WHERE r.automation_log_id = al.id AND r.resolved_at IS NULL) AS pendencia_aberta
FROM public.automation_log al
WHERE al.farm_id = '0b1d53df-6d5c-4674-8517-9299aac3ec18'
  AND al.action IN ('turn_on','pump_on')
  AND al.origin  = 'remote'::public.event_origin
  AND al.user_id IS NULL
  AND al.occurred_at >= (TIMESTAMP '2026-08-14 07:48:00' AT TIME ZONE 'America/Sao_Paulo')
  AND al.occurred_at <  (TIMESTAMP '2026-08-14 07:50:00' AT TIME ZONE 'America/Sao_Paulo')
ORDER BY al.equipment_name, al.occurred_at;

-- Conferência rápida da contagem e dos nomes (o UPDATE exige exatamente 13):
SELECT count(*) AS total_candidatas,
       string_agg(DISTINCT al.equipment_name, ' | ' ORDER BY al.equipment_name) AS equipamentos
FROM public.automation_log al
WHERE al.farm_id = '0b1d53df-6d5c-4674-8517-9299aac3ec18'
  AND al.action IN ('turn_on','pump_on')
  AND al.origin  = 'remote'::public.event_origin
  AND al.user_id IS NULL
  AND al.occurred_at >= (TIMESTAMP '2026-08-14 07:48:00' AT TIME ZONE 'America/Sao_Paulo')
  AND al.occurred_at <  (TIMESTAMP '2026-08-14 07:50:00' AT TIME ZONE 'America/Sao_Paulo');


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ PARTE B — ATRIBUIÇÃO. NÃO RODE antes de conferir a PARTE A.              ║
-- ║ Descomente o bloco inteiro só depois de confirmar as 13 linhas.          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
/*
BEGIN;

DO $reconcile$
DECLARE
  c_farm   constant uuid := '0b1d53df-6d5c-4674-8517-9299aac3ec18';
  c_user   constant uuid := 'd86c9393-1138-4b0c-95c2-c350fdd434d9';
  c_email  constant text := 'seibertyuri@gmail.com';
  c_actor  constant text := 'Yuri Seibert';
  c_from   constant timestamptz := TIMESTAMP '2026-08-14 07:48:00' AT TIME ZONE 'America/Sao_Paulo';
  c_to     constant timestamptz := TIMESTAMP '2026-08-14 07:50:00' AT TIME ZONE 'America/Sao_Paulo';
  c_expect constant int  := 13;

  -- ⇩ PREENCHA com o UUID do platform_admin que está executando (auditoria).
  --   No SQL Editor auth.uid() é nulo, por isso é explícito.
  v_verified_by uuid := NULL;

  v_ids uuid[];
  v_n   int;
BEGIN
  -- 1) O usuário precisa existir. Sem isso, nada é escrito.
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = c_user) THEN
    RAISE EXCEPTION 'ABORTADO: user_id % não existe em profiles', c_user;
  END IF;
  IF v_verified_by IS NULL THEN
    RAISE EXCEPTION 'ABORTADO: preencha v_verified_by com o UUID do platform_admin executor';
  END IF;

  -- 2) Congela o conjunto exato (mesmos critérios da PARTE A).
  SELECT array_agg(al.id), count(*) INTO v_ids, v_n
    FROM public.automation_log al
   WHERE al.farm_id = c_farm
     AND al.action IN ('turn_on','pump_on')
     AND al.origin  = 'remote'::public.event_origin
     AND al.user_id IS NULL
     AND al.occurred_at >= c_from
     AND al.occurred_at <  c_to;

  -- 3) TRAVA: quantidade diferente do esperado → nada é alterado.
  IF COALESCE(v_n, 0) <> c_expect THEN
    RAISE EXCEPTION 'ABORTADO: encontradas % linha(s), esperado %. Nenhuma alteração feita.',
      COALESCE(v_n, 0), c_expect;
  END IF;

  -- 4) Atribuição APENAS nessas linhas.
  UPDATE public.automation_log al
     SET user_id     = c_user,
         user_email  = c_email,
         actor_label = c_actor,
         details     = COALESCE(al.details, '{}'::jsonb) || jsonb_build_object(
           'authorship_source',      'operator_verified_batch_reconciliation',
           'authorship_confidence',  'strong',
           'authorship_evidence',    'Painel web acessado pelo usuário imediatamente antes do lote; '
                                     || 'equipamentos com last_actuation_origin=remote-desired; '
                                     || 'confirmação RF dos mesmos 13 poços na janela 07:48–07:49 BRT de 14/08/2026.',
           'authorship_verified_at', now(),
           'authorship_verified_by', v_verified_by,
           'authorship_batch_size',  c_expect)
   WHERE al.id = ANY(v_ids);

  -- 5) Fecha somente as pendências dessas linhas.
  UPDATE public.authorship_pending_review r
     SET resolved_at = now(), resolved_by = v_verified_by
   WHERE r.automation_log_id = ANY(v_ids)
     AND r.resolved_at IS NULL;

  RAISE NOTICE 'OK: % linha(s) atribuídas a % e pendências fechadas.', v_n, c_actor;
END
$reconcile$;

-- 6) CONFERÊNCIA FINAL — as 13 linhas já atribuídas.
SELECT
  al.equipment_name AS equipamento,
  to_char(al.occurred_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS') AS horario_brt,
  al.action::text   AS acao,
  al.origin::text   AS origem,
  al.actor_label    AS ator,
  al.user_email,
  al.result::text   AS resultado,
  al.details->>'authorship_source'     AS fonte_autoria,
  al.details->>'authorship_confidence' AS confianca,
  al.details->>'confirmation_method'   AS metodo_confirmacao
FROM public.automation_log al
WHERE al.farm_id = '0b1d53df-6d5c-4674-8517-9299aac3ec18'
  AND al.user_id = 'd86c9393-1138-4b0c-95c2-c350fdd434d9'
  AND al.occurred_at >= (TIMESTAMP '2026-08-14 07:48:00' AT TIME ZONE 'America/Sao_Paulo')
  AND al.occurred_at <  (TIMESTAMP '2026-08-14 07:50:00' AT TIME ZONE 'America/Sao_Paulo')
ORDER BY al.equipment_name;

COMMIT;
*/

-- ============================================================================
-- ROLLBACK desta reconciliação (só ela; nada mais é tocado):
--   UPDATE public.automation_log
--      SET user_id = NULL, user_email = NULL, actor_label = NULL
--    WHERE details->>'authorship_source' = 'operator_verified_batch_reconciliation';
--   UPDATE public.authorship_pending_review r
--      SET resolved_at = NULL, resolved_by = NULL
--     FROM public.automation_log al
--    WHERE r.automation_log_id = al.id
--      AND al.details->>'authorship_source' = 'operator_verified_batch_reconciliation';
-- ============================================================================
