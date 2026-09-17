-- ── 1) AUDITORIA POR FAZENDA — sem artefato de LEFT JOIN ────────────────────
CREATE OR REPLACE FUNCTION public.automation_report_farm_audit()
RETURNS TABLE (
  fazenda                  text,
  eventos_oficiais         int,
  remotos_com_nome         int,
  remotos_sem_nome         int,
  locais                   int,
  automacoes               int,
  tecnicos_ruido_excluido  int,
  possiveis_duplicidades   int,
  transicoes_sem_prova     int
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH ofic AS (
  SELECT al.*, CASE WHEN al.action IN ('turn_on','pump_on') THEN 1 ELSE 0 END AS st
    FROM public.automation_log al
   WHERE al.noise_reason IS NULL
     AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
), dup AS (
  SELECT o.farm_id, count(*)::int n FROM (
    SELECT farm_id, st,
           lag(st) OVER (PARTITION BY equipment_id ORDER BY occurred_at, created_at, id) prev
      FROM ofic WHERE equipment_id IS NOT NULL) o
   WHERE o.prev IS NOT NULL AND o.st = o.prev
   GROUP BY o.farm_id
)
SELECT f.name,
  count(o.id)::int,
  count(o.id) FILTER (WHERE o.origin='remote'::public.event_origin AND o.user_id IS NOT NULL)::int,
  count(o.id) FILTER (WHERE o.origin='remote'::public.event_origin AND o.user_id IS NULL)::int,
  count(o.id) FILTER (WHERE o.origin='local'::public.event_origin)::int,
  count(o.id) FILTER (WHERE o.origin='auto'::public.event_origin)::int,
  COALESCE((SELECT count(*)::int FROM public.automation_log x
             WHERE x.farm_id=f.id AND x.noise_reason IS NOT NULL), 0),
  COALESCE((SELECT d.n FROM dup d WHERE d.farm_id=f.id), 0),
  count(o.id) FILTER (WHERE o.result IS DISTINCT FROM 'success'::public.event_result
                        AND COALESCE(o.details->>'state_confirmed','') <> 'true')::int
FROM public.farms f
LEFT JOIN ofic o ON o.farm_id = f.id
GROUP BY f.id, f.name
ORDER BY f.name;
$$;

-- ── 2) CRITÉRIOS DE ACEITE — uma linha por critério, por construção ─────────
CREATE OR REPLACE FUNCTION public.automation_report_acceptance(_farm_id uuid DEFAULT NULL)
RETURNS TABLE (criterio text, violacoes int, situacao text, exemplos text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH ofic AS (
  SELECT al.* FROM public.automation_log al
   WHERE al.noise_reason IS NULL
     AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND (_farm_id IS NULL OR al.farm_id = _farm_id)
), viol AS (
  SELECT '1. remoto sem usuário' c, id FROM ofic
    WHERE origin='remote'::public.event_origin AND user_id IS NULL
  UNION ALL
  SELECT '2. rótulo técnico como usuário', id FROM ofic
    WHERE origin='remote'::public.event_origin AND public.is_technical_actor_label(actor_label)
  UNION ALL
  SELECT '2b. rótulo provisório como usuário', id FROM ofic
    WHERE lower(COALESCE(actor_label,'')) IN
          ('autoria histórica em revisão','comando remoto','em apuração','remoto não identificado')
  UNION ALL
  SELECT '3. técnico/polling no histórico oficial', id FROM ofic
    WHERE origin='reading'::public.event_origin OR equipment_id IS NULL
  UNION ALL
  SELECT '4. duplicidade sem transição física', o.id FROM (
    SELECT id, CASE WHEN action IN ('turn_on','pump_on') THEN 1 ELSE 0 END st,
           lag(CASE WHEN action IN ('turn_on','pump_on') THEN 1 ELSE 0 END)
             OVER (PARTITION BY equipment_id ORDER BY occurred_at, created_at, id) prev
      FROM ofic WHERE equipment_id IS NOT NULL) o
    WHERE o.prev IS NOT NULL AND o.st = o.prev
  UNION ALL
  SELECT '5. remoto sem fonte de autoria auditável', id FROM ofic
    WHERE origin='remote'::public.event_origin
      AND (user_id IS NULL OR user_email IS NULL OR COALESCE(details->>'authorship_source','') = '')
  UNION ALL
  SELECT '6. automação sem nome de regra', id FROM ofic
    WHERE origin='auto'::public.event_origin AND COALESCE(btrim(actor_label),'') = ''
  UNION ALL
  SELECT '7. local sem evidência física', id FROM ofic
    WHERE origin='local'::public.event_origin
      AND COALESCE(details->>'origin','') NOT IN ('local','spontaneous_tx')
      AND COALESCE(btrim(actor_label),'') = ''
), criterios(c) AS (
  VALUES ('1. remoto sem usuário'),
         ('2. rótulo técnico como usuário'),
         ('2b. rótulo provisório como usuário'),
         ('3. técnico/polling no histórico oficial'),
         ('4. duplicidade sem transição física'),
         ('5. remoto sem fonte de autoria auditável'),
         ('6. automação sem nome de regra'),
         ('7. local sem evidência física')
)
SELECT k.c,
       count(v.id)::int,
       CASE WHEN count(v.id) = 0 THEN 'PASSOU' ELSE 'REPROVADO' END,
       COALESCE(string_agg(left(v.id::text, 8), ', ' ORDER BY v.id), '—')
  FROM criterios k
  LEFT JOIN viol v ON v.c = k.c
 GROUP BY k.c
 ORDER BY k.c;
$$;

GRANT EXECUTE ON FUNCTION public.automation_report_farm_audit() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.automation_report_acceptance(uuid) TO authenticated, service_role;