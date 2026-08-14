-- ============================================================================
-- DIAGNÓSTICO de lotes remotos históricos — SOMENTE LEITURA. NENHUM UPDATE.
-- ----------------------------------------------------------------------------
-- Esta migration NÃO altera dado nenhum. Ela cria funções de ANÁLISE que
-- agrupam eventos remotos em lotes e PROPÕEM uma decisão, para revisão humana.
-- A atribuição em si, se você aprovar, é feita depois por script cirúrgico.
--
-- REGRA ABSOLUTA (implementada em `decisao_proposta`):
--   • só sugere atribuição automática quando existe EXATAMENTE UM usuário já
--     comprovado por FONTE FORTE dentro do próprio lote — command_audit,
--     details.user_id ou operator_verified_batch_reconciliation;
--   • qualquer ambiguidade (2+ usuários, ou nenhuma prova forte) → não sugere
--     nada, mantém pendência auditável;
--   • equipments.last_changed_by NUNCA é usado como prova aqui: é campo de
--     estado ATUAL e não descreve autoria de evento antigo.
-- ============================================================================

-- ── Fontes consideradas FORTES para autoria já comprovada ───────────────────
CREATE OR REPLACE FUNCTION public.is_strong_authorship_source(_src text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE(_src,'') IN (
    'command_audit',
    'details_user',
    'operator_verified_batch_reconciliation'
  );
$$;

-- ── Agrupamento em LOTES ────────────────────────────────────────────────────
-- Um lote = mesma fazenda + mesma intenção (liga OU desliga) + eventos remotos
-- encadeados com intervalo <= 5 min entre consecutivos. Lotes com automação
-- programada ou atuação local misturada na mesma janela são MARCADOS e nunca
-- recebem sugestão automática.
CREATE OR REPLACE FUNCTION public.historical_remote_batches(
  _farm_id uuid DEFAULT NULL,
  _from timestamptz DEFAULT NULL,
  _to   timestamptz DEFAULT NULL,
  _gap  interval DEFAULT interval '5 minutes')
RETURNS TABLE (
  batch_id           text,
  farm_id            uuid,
  farm_name          text,
  inicio_brt         text,
  fim_brt            text,
  acao               text,
  total_eventos      int,
  ja_atribuidos      int,
  sem_autor          int,
  usuarios_fortes    int,
  usuario_unico      uuid,
  usuario_unico_nome text,
  fontes_autoria     text,
  contaminado        boolean,
  pocos              text,
  decisao_proposta   text,
  motivo             text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH base AS (
  SELECT al.*,
         CASE WHEN al.action IN ('turn_on','pump_on') THEN 'ligar' ELSE 'desligar' END AS intencao
    FROM public.automation_log al
   WHERE al.noise_reason IS NULL
     AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND al.origin = 'remote'::public.event_origin
     AND (_farm_id IS NULL OR al.farm_id = _farm_id)
     AND (_from    IS NULL OR al.occurred_at >= _from)
     AND (_to      IS NULL OR al.occurred_at <  _to)
), marcado AS (
  SELECT b.*,
         CASE WHEN lag(b.occurred_at) OVER (PARTITION BY b.farm_id, b.intencao ORDER BY b.occurred_at) IS NULL
                OR b.occurred_at - lag(b.occurred_at) OVER (PARTITION BY b.farm_id, b.intencao ORDER BY b.occurred_at) > _gap
              THEN 1 ELSE 0 END AS novo_lote
    FROM base b
), numerado AS (
  SELECT m.*, sum(m.novo_lote) OVER (PARTITION BY m.farm_id, m.intencao ORDER BY m.occurred_at
                                     ROWS UNBOUNDED PRECEDING) AS grupo
    FROM marcado m
), agregado AS (
  SELECT n.farm_id, n.intencao, n.grupo,
         min(n.occurred_at) AS ini, max(n.occurred_at) AS fim,
         count(*)::int AS total,
         count(*) FILTER (WHERE n.user_id IS NOT NULL)::int AS atribuidos,
         count(*) FILTER (WHERE n.user_id IS NULL)::int      AS sem_autor,
         count(DISTINCT n.user_id) FILTER (
           WHERE n.user_id IS NOT NULL
             AND public.is_strong_authorship_source(n.details->>'authorship_source'))::int AS fortes,
         (array_agg(DISTINCT n.user_id) FILTER (
           WHERE n.user_id IS NOT NULL
             AND public.is_strong_authorship_source(n.details->>'authorship_source')))[1]  AS user_forte,
         string_agg(DISTINCT n.details->>'authorship_source', ', ')                        AS fontes,
         string_agg(n.equipment_name || ' @' ||
                    to_char(n.occurred_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') ||
                    ' [' || left(n.id::text, 8) || ']' ||
                    CASE WHEN n.user_id IS NULL THEN ' (sem autor)' ELSE '' END,
                    ' · ' ORDER BY n.occurred_at)                                          AS pocos
    FROM numerado n
   GROUP BY n.farm_id, n.intencao, n.grupo
)
SELECT
  to_char(a.ini AT TIME ZONE 'America/Sao_Paulo','YYYYMMDD-HH24MI') || '-' || a.intencao AS batch_id,
  a.farm_id, f.name,
  to_char(a.ini AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
  to_char(a.fim AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
  a.intencao, a.total, a.atribuidos, a.sem_autor, a.fortes,
  a.user_forte, p.full_name, COALESCE(a.fontes,'—'),
  -- contaminado = automação ou atuação local na MESMA janela e fazenda
  EXISTS (
    SELECT 1 FROM public.automation_log x
     WHERE x.farm_id = a.farm_id AND x.noise_reason IS NULL
       AND x.action IN ('turn_on','turn_off','pump_on','pump_off')
       AND x.origin IN ('auto'::public.event_origin,'local'::public.event_origin)
       AND x.occurred_at BETWEEN a.ini AND a.fim),
  a.pocos,
  CASE
    WHEN a.sem_autor = 0 THEN 'NENHUMA — lote já totalmente atribuído'
    WHEN EXISTS (
      SELECT 1 FROM public.automation_log x
       WHERE x.farm_id = a.farm_id AND x.noise_reason IS NULL
         AND x.action IN ('turn_on','turn_off','pump_on','pump_off')
         AND x.origin IN ('auto'::public.event_origin,'local'::public.event_origin)
         AND x.occurred_at BETWEEN a.ini AND a.fim)
      THEN 'NÃO ATRIBUIR — janela contaminada por automação/atuação local'
    WHEN a.fortes = 1 THEN 'SUGERIR atribuição ao usuário único comprovado do lote'
    WHEN a.fortes > 1 THEN 'NÃO ATRIBUIR — mais de um usuário comprovado no lote'
    ELSE 'NÃO ATRIBUIR — nenhuma prova forte no lote'
  END,
  CASE
    WHEN a.sem_autor = 0 THEN 'todos os eventos já têm autor'
    WHEN a.fortes = 1 THEN 'exatamente 1 usuário com fonte forte ('
                           || COALESCE(a.fontes,'—') || ') e nenhum conflito humano'
    WHEN a.fortes > 1 THEN 'ambiguidade: ' || a.fortes || ' usuários comprovados'
    ELSE 'sem command_audit, sem details.user_id e sem reconciliação verificada'
  END
FROM agregado a
JOIN public.farms f ON f.id = a.farm_id
LEFT JOIN public.profiles p ON p.id = a.user_forte
ORDER BY a.ini DESC;
$$;

GRANT EXECUTE ON FUNCTION public.historical_remote_batches(uuid, timestamptz, timestamptz, interval)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.historical_remote_batches(uuid, timestamptz, timestamptz, interval) IS
  'ANÁLISE somente-leitura de lotes remotos históricos. Propõe decisão; não altera nada. last_changed_by não é usado como prova.';

-- ============================================================================
-- COMO USAR (nada é alterado por estas consultas)
-- ----------------------------------------------------------------------------
-- Todos os lotes de todas as fazendas:
--   SELECT * FROM public.historical_remote_batches();
--
-- LOTES DESTACADOS NO PEDIDO:
--   -- 11/08/2026 21:18–21:22 BRT
--   SELECT * FROM public.historical_remote_batches(
--     '0b1d53df-6d5c-4674-8517-9299aac3ec18',
--     (TIMESTAMP '2026-08-11 21:15:00' AT TIME ZONE 'America/Sao_Paulo'),
--     (TIMESTAMP '2026-08-11 21:25:00' AT TIME ZONE 'America/Sao_Paulo'));
--
--   -- 13/08/2026 07:58–08:02 BRT
--   SELECT * FROM public.historical_remote_batches(
--     '0b1d53df-6d5c-4674-8517-9299aac3ec18',
--     (TIMESTAMP '2026-08-13 07:55:00' AT TIME ZONE 'America/Sao_Paulo'),
--     (TIMESTAMP '2026-08-13 08:05:00' AT TIME ZONE 'America/Sao_Paulo'));
-- ============================================================================
