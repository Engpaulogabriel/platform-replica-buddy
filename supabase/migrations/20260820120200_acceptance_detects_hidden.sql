-- ============================================================================
-- ACEITE VERDADEIRO — falha quando há transição física REAL escondida.
-- ----------------------------------------------------------------------------
-- O aceite antigo só olhava linhas com noise_reason IS NULL. Com 98 transições
-- escondidas na Semear, ele deu 8/8 PASSOU — porque o que sobrou estava limpo.
-- Aceite que aprova conjunto vazio não é aceite.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.automation_global_acceptance()
RETURNS TABLE (categoria text, violacoes bigint, situacao text, fazendas_afetadas text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH agg AS (
  SELECT k.cat, count(c.id) AS n, string_agg(DISTINCT f.name, ', ') AS farms
    FROM (VALUES ('A_origem_indefinida'),('B_usuario_tecnico'),('C_remoto_sem_autor'),
                 ('D_local_com_comando'),('E_auto_sem_regra'),('F_tecnico'),
                 ('G_sem_prova')) k(cat)
    LEFT JOIN public.automation_row_classified c ON c.issue = k.cat
    LEFT JOIN public.farms f ON f.id = c.farm_id
   GROUP BY k.cat
)
SELECT agg.cat, agg.n,
       CASE WHEN agg.n = 0 THEN 'PASSOU' ELSE 'REPROVADO' END,
       COALESCE(agg.farms,'—')
  FROM agg
UNION ALL
-- ── H: transição física REAL escondida do relatório ────────────────────────
SELECT 'H_transicao_fisica_escondida', count(*),
       CASE WHEN count(*) = 0 THEN 'PASSOU' ELSE 'REPROVADO' END,
       COALESCE(string_agg(DISTINCT f.name, ', '),'—')
  FROM public.automation_log al JOIN public.farms f ON f.id = al.farm_id
 WHERE al.action IN ('turn_on','turn_off','pump_on','pump_off')
   AND al.result = 'success'::public.event_result
   AND al.noise_reason IN ('pending_authorship_review','no_authorship','system_origin')
UNION ALL
-- ── I: relatório vazio não pode ser aprovado ───────────────────────────────
SELECT 'I_relatorio_nao_vazio',
       CASE WHEN (SELECT count(*) FROM public.automation_log
                   WHERE noise_reason IS NULL
                     AND action IN ('turn_on','turn_off','pump_on','pump_off')) = 0
            THEN 1 ELSE 0 END,
       CASE WHEN (SELECT count(*) FROM public.automation_log
                   WHERE noise_reason IS NULL
                     AND action IN ('turn_on','turn_off','pump_on','pump_off')) = 0
            THEN 'REPROVADO' ELSE 'PASSOU' END,
       '—'
UNION ALL
-- ── J: fazenda ativa sem NENHUM remoto nem local nos últimos 7 dias ────────
--     É o sintoma exato deste incidente: só automação aparecendo.
SELECT 'J_fazenda_so_com_automacao', count(*),
       CASE WHEN count(*) = 0 THEN 'PASSOU' ELSE 'REPROVADO' END,
       COALESCE(string_agg(nome, ', '),'—')
  FROM (
    SELECT f.name AS nome
      FROM public.farms f
     WHERE EXISTS (SELECT 1 FROM public.equipments e
                    WHERE e.farm_id = f.id AND e.active)
       AND EXISTS (SELECT 1 FROM public.automation_log a
                    WHERE a.farm_id = f.id AND a.noise_reason IS NULL
                      AND a.origin = 'auto'::public.event_origin
                      AND a.occurred_at > now() - interval '7 days')
       AND NOT EXISTS (SELECT 1 FROM public.automation_log a
                        WHERE a.farm_id = f.id AND a.noise_reason IS NULL
                          AND a.origin IN ('remote'::public.event_origin,
                                           'local'::public.event_origin,
                                           'whatsapp'::public.event_origin)
                          AND a.occurred_at > now() - interval '7 days')
  ) s
 ORDER BY 1;
$$;
GRANT EXECUTE ON FUNCTION public.automation_global_acceptance() TO authenticated, service_role;

-- ============================================================================
-- Agora o aceite REPROVA o cenário deste incidente:
--   H → há transição física escondida
--   J → fazenda mostrando só automação
-- ============================================================================
