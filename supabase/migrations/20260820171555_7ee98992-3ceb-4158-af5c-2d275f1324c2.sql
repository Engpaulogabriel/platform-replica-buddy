DROP FUNCTION IF EXISTS public.automation_global_acceptance();
CREATE FUNCTION public.automation_global_acceptance()
RETURNS TABLE(categoria text, violacoes bigint, situacao text, fazendas_afetadas text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH agg AS (
  SELECT k.cat, count(c.id) AS n, string_agg(DISTINCT f.name, ', ') AS farms
    FROM (VALUES ('A_origem_indefinida'),('B_usuario_tecnico'),('C_remoto_sem_autor'),
                 ('D_local_com_comando'),('E_auto_sem_regra'),('F_tecnico'),
                 ('G_sem_prova')) k(cat)
    LEFT JOIN public.automation_row_classified c ON c.issue = k.cat
    LEFT JOIN public.farms f ON f.id = c.farm_id
   GROUP BY k.cat
),
fisica AS (
  SELECT al.*
    FROM public.automation_log al
   WHERE al.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND al.result = 'success'::public.event_result
),
-- H1: transição física REAL que vazou ao relatório oficial em estado inválido
vazamento AS (
  SELECT al.id, al.farm_id
    FROM fisica al
   WHERE al.noise_reason IS NULL
     AND ( al.origin = 'system'::public.event_origin
        OR public.is_technical_actor_label(al.actor_label)
        OR al.actor_label IS NULL
        OR btrim(al.actor_label) = ''
        OR al.actor_label ILIKE 'desconhecid%'
        OR (al.origin = 'remote'::public.event_origin AND al.user_id IS NULL) )
),
-- H2: transição física escondida SEM quarentena auditável e válida
sem_decisao AS (
  SELECT al.id, al.farm_id
    FROM fisica al
   WHERE al.noise_reason IN ('pending_authorship_review','no_authorship','system_origin')
     AND NOT (
       EXISTS (SELECT 1 FROM public.automation_cleanup_audit a
                WHERE a.event_id = al.id
                  AND a.action = 'kept_technical_only'
                  AND a.phase_a_category = 'REMOTE_NO_PERSON')
       AND al.origin <> 'local'::public.event_origin   -- (d) não convertida para Local
       AND al.user_id IS NULL                          -- (e) não recebeu nome inventado
       AND NOT public.is_technical_actor_label(COALESCE(al.actor_label,''))
     )
),
h AS (
  SELECT id, farm_id FROM vazamento
  UNION
  SELECT id, farm_id FROM sem_decisao
)
SELECT agg.cat, agg.n,
       CASE WHEN agg.n = 0 THEN 'PASSOU' ELSE 'REPROVADO' END,
       COALESCE(agg.farms,'—')
  FROM agg
UNION ALL
SELECT 'H_transicao_fisica_escondida', count(*),
       CASE WHEN count(*) = 0 THEN 'PASSOU' ELSE 'REPROVADO' END,
       COALESCE(string_agg(DISTINCT f.name, ', '),'—')
  FROM h LEFT JOIN public.farms f ON f.id = h.farm_id
UNION ALL
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