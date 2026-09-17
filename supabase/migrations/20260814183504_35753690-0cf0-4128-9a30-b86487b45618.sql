-- ============================================================================
-- FASE A — INVENTÁRIO GLOBAL do Relatório de Automação. SOMENTE LEITURA.
-- ============================================================================

CREATE OR REPLACE VIEW public.automation_row_classified
WITH (security_invoker = true) AS
SELECT
  al.id, al.farm_id, al.equipment_id, al.equipment_name, al.occurred_at,
  al.created_at, al.action, al.origin, al.result, al.actor_label,
  al.user_id, al.user_email, al.details,
  CASE WHEN al.action IN ('turn_on','pump_on') THEN 1 ELSE 0 END AS target_state,
  CASE
    WHEN al.action NOT IN ('turn_on','turn_off','pump_on','pump_off') THEN 'F_tecnico'
    WHEN al.origin = 'reading'::public.event_origin                   THEN 'F_tecnico'
    WHEN al.equipment_id IS NULL                                      THEN 'G_sem_prova'
    WHEN al.result IS DISTINCT FROM 'success'::public.event_result
         AND COALESCE(al.details->>'state_confirmed','') <> 'true'    THEN 'G_sem_prova'
    WHEN al.origin = 'system'::public.event_origin                    THEN 'A_origem_indefinida'
    WHEN public.is_technical_actor_label(al.actor_label)              THEN 'B_usuario_tecnico'
    WHEN lower(btrim(COALESCE(al.actor_label,''))) IN
         ('autoria histórica em revisão','comando remoto','em apuração',
          'origem em apuração','remoto não identificado','não identificado')
                                                                      THEN 'B_usuario_tecnico'
    WHEN al.origin = 'remote'::public.event_origin
         AND (al.user_id IS NULL OR COALESCE(btrim(al.user_email),'') = ''
              OR COALESCE(btrim(al.actor_label),'') = '')             THEN 'C_remoto_sem_autor'
    WHEN al.origin = 'auto'::public.event_origin
         AND COALESCE(btrim(al.actor_label),'') = ''                  THEN 'E_auto_sem_regra'
    WHEN al.origin = 'local'::public.event_origin AND EXISTS (
           SELECT 1 FROM public.command_audit ca
            WHERE ca.equipment_id = al.equipment_id
              AND ca.user_id IS NOT NULL
              AND ca.intent = CASE WHEN al.action IN ('turn_on','pump_on')
                                   THEN 'turn_on' ELSE 'turn_off' END
              AND ca.command_created_at
                  BETWEEN al.occurred_at - interval '180 seconds'
                      AND al.occurred_at + interval '180 seconds')
                                                                      THEN 'D_local_com_comando'
    ELSE 'OK'
  END AS issue
FROM public.automation_log al
WHERE al.noise_reason IS NULL;

COMMENT ON VIEW public.automation_row_classified IS
  'Fase A: classifica cada linha oficial do Relatório de Automação em OK ou numa categoria de problema (A a G). Somente leitura.';
GRANT SELECT ON public.automation_row_classified TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.automation_row_issue(_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT issue FROM public.automation_row_classified WHERE id = _id;
$$;
GRANT EXECUTE ON FUNCTION public.automation_row_issue(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.automation_global_inventory()
RETURNS TABLE (
  fazenda            text,
  total_oficial      bigint,
  remoto_com_autor   bigint,
  local_comprovado   bigint,
  automacao_correta  bigint,
  origem_indefinida  bigint,
  usuario_tecnico    bigint,
  remoto_sem_autor   bigint,
  tecnicos_ruido     bigint,
  duplicidades       bigint,
  sem_prova          bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH dup AS (
  SELECT o.farm_id, count(*) AS n
    FROM (SELECT c.farm_id, c.target_state,
                 lag(c.target_state) OVER (PARTITION BY c.equipment_id
                                           ORDER BY c.occurred_at, c.created_at, c.id) AS prev
            FROM public.automation_row_classified c
           WHERE c.equipment_id IS NOT NULL
             AND c.action IN ('turn_on','turn_off','pump_on','pump_off')) o
   WHERE o.prev IS NOT NULL AND o.target_state = o.prev
   GROUP BY o.farm_id
)
SELECT f.name,
  count(c.id) FILTER (WHERE c.action IN ('turn_on','turn_off','pump_on','pump_off')),
  count(c.id) FILTER (WHERE c.issue = 'OK' AND c.origin = 'remote'::public.event_origin),
  count(c.id) FILTER (WHERE c.issue = 'OK' AND c.origin = 'local'::public.event_origin),
  count(c.id) FILTER (WHERE c.issue = 'OK' AND c.origin = 'auto'::public.event_origin),
  count(c.id) FILTER (WHERE c.issue = 'A_origem_indefinida'),
  count(c.id) FILTER (WHERE c.issue = 'B_usuario_tecnico'),
  count(c.id) FILTER (WHERE c.issue = 'C_remoto_sem_autor'),
  count(c.id) FILTER (WHERE c.issue = 'F_tecnico'),
  COALESCE((SELECT d.n FROM dup d WHERE d.farm_id = f.id), 0),
  count(c.id) FILTER (WHERE c.issue = 'G_sem_prova')
FROM public.farms f
LEFT JOIN public.automation_row_classified c ON c.farm_id = f.id
GROUP BY f.id, f.name
ORDER BY f.name;
$$;
GRANT EXECUTE ON FUNCTION public.automation_global_inventory() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.automation_issue_rows(_categoria text DEFAULT NULL)
RETURNS TABLE (
  categoria text, fazenda text, equipamento text, id uuid,
  ocorrido_brt text, acao text, origem text, ator text,
  tem_usuario boolean, fonte_autoria text, metodo_confirmacao text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.issue, f.name, c.equipment_name, c.id,
         to_char(c.occurred_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
         c.action::text, c.origin::text, c.actor_label,
         c.user_id IS NOT NULL,
         c.details->>'authorship_source',
         c.details->>'confirmation_method'
    FROM public.automation_row_classified c
    JOIN public.farms f ON f.id = c.farm_id
   WHERE c.issue <> 'OK'
     AND (_categoria IS NULL OR c.issue LIKE _categoria || '%')
   ORDER BY c.issue, f.name, c.occurred_at DESC;
$$;
GRANT EXECUTE ON FUNCTION public.automation_issue_rows(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.automation_issue_summary()
RETURNS TABLE (categoria text, descricao text, ocorrencias bigint, fazendas bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT k.cat, k.descr,
       count(c.id),
       count(DISTINCT c.farm_id)
  FROM (VALUES
    ('A_origem_indefinida', 'origem system/indefinida — exibida como "Origem em apuração"'),
    ('B_usuario_tecnico',   'usuário técnico ou genérico na coluna Usuário'),
    ('C_remoto_sem_autor',  'remoto sem user_id/e-mail/nome humano'),
    ('D_local_com_comando', 'marcado Local havendo comando remoto compatível na janela'),
    ('E_auto_sem_regra',    'automação sem nome de regra'),
    ('F_tecnico',           'polling/eco/retry/startup/status_read no relatório oficial'),
    ('G_sem_prova',         'sem prova física de transição')
  ) k(cat, descr)
  LEFT JOIN public.automation_row_classified c ON c.issue = k.cat
 GROUP BY k.cat, k.descr
 ORDER BY k.cat;
$$;
GRANT EXECUTE ON FUNCTION public.automation_issue_summary() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.automation_global_acceptance()
RETURNS TABLE (categoria text, violacoes bigint, situacao text, fazendas_afetadas text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH agg AS (
  SELECT k.cat,
         count(c.id) AS n,
         string_agg(DISTINCT f.name, ', ') AS farms
    FROM (VALUES ('A_origem_indefinida'),('B_usuario_tecnico'),('C_remoto_sem_autor'),
                 ('D_local_com_comando'),('E_auto_sem_regra'),('F_tecnico'),
                 ('G_sem_prova')) k(cat)
    LEFT JOIN public.automation_row_classified c ON c.issue = k.cat
    LEFT JOIN public.farms f ON f.id = c.farm_id
   GROUP BY k.cat
)
SELECT agg.cat, agg.n,
       CASE WHEN agg.n = 0 THEN 'PASSOU' ELSE 'REPROVADO' END,
       COALESCE(agg.farms, '—')
  FROM agg ORDER BY agg.cat;
$$;
GRANT EXECUTE ON FUNCTION public.automation_global_acceptance() TO authenticated, service_role;