-- ============================================================================
-- AUDITORIA GLOBAL + CRITÉRIOS DE ACEITE do Relatório de Automação.
-- ----------------------------------------------------------------------------
-- Somente leitura. Estas funções são a PROVA exigida na Etapa D: enquanto
-- qualquer critério estiver REPROVADO, a entrega não está pronta.
--
-- Nada aqui altera dado. Nenhuma delas depende de nome de fazenda ou pessoa.
-- ============================================================================

-- ── ETAPA A — TABELA GLOBAL POR FAZENDA ─────────────────────────────────────
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
  -- estado repetido consecutivo no mesmo equipamento = duplicidade suspeita
  SELECT o.farm_id, count(*)::int n FROM (
    SELECT farm_id, st,
           lag(st) OVER (PARTITION BY equipment_id ORDER BY occurred_at, created_at, id) prev
      FROM ofic WHERE equipment_id IS NOT NULL) o
   WHERE o.prev IS NOT NULL AND o.st = o.prev
   GROUP BY o.farm_id
)
SELECT f.name,
  count(o.id)::int,
  count(*) FILTER (WHERE o.origin='remote'::public.event_origin AND o.user_id IS NOT NULL)::int,
  count(*) FILTER (WHERE o.origin='remote'::public.event_origin AND o.user_id IS NULL)::int,
  count(*) FILTER (WHERE o.origin='local'::public.event_origin)::int,
  count(*) FILTER (WHERE o.origin='auto'::public.event_origin)::int,
  (SELECT count(*)::int FROM public.automation_log x
    WHERE x.farm_id=f.id AND x.noise_reason IS NOT NULL),
  COALESCE((SELECT d.n FROM dup d WHERE d.farm_id=f.id), 0),
  -- sem prova física: nem result success, nem confirmação declarada
  count(*) FILTER (WHERE o.result IS DISTINCT FROM 'success'::public.event_result
                     AND COALESCE(o.details->>'state_confirmed','') <> 'true')::int
FROM public.farms f
LEFT JOIN ofic o ON o.farm_id = f.id
GROUP BY f.id, f.name
ORDER BY f.name;
$$;
GRANT EXECUTE ON FUNCTION public.automation_report_farm_audit() TO authenticated, service_role;

-- ── ETAPA D — CRITÉRIOS DE ACEITE (PASSOU/REPROVADO) ────────────────────────
-- Um critério só passa quando a contagem de violações é ZERO em TODAS as
-- fazendas. `exemplos` traz até 5 ids para investigação imediata.
CREATE OR REPLACE FUNCTION public.automation_report_acceptance(_farm_id uuid DEFAULT NULL)
RETURNS TABLE (criterio text, violacoes int, situacao text, exemplos text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH ofic AS (
  SELECT al.* FROM public.automation_log al
   WHERE al.noise_reason IS NULL
     AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND (_farm_id IS NULL OR al.farm_id = _farm_id)
), v AS (
  SELECT '1. remoto sem usuário' c, id FROM ofic
    WHERE origin='remote'::public.event_origin AND user_id IS NULL
  UNION ALL
  SELECT '2. rótulo técnico como usuário', id FROM ofic
    WHERE origin='remote'::public.event_origin
      AND public.is_technical_actor_label(actor_label)
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
      AND (user_id IS NULL OR user_email IS NULL
           OR COALESCE(details->>'authorship_source','') = '')
  UNION ALL
  SELECT '6. automação sem nome de regra', id FROM ofic
    WHERE origin='auto'::public.event_origin
      AND COALESCE(btrim(actor_label),'') = ''
  UNION ALL
  SELECT '7. local sem evidência física', id FROM ofic
    WHERE origin='local'::public.event_origin
      AND COALESCE(details->>'origin','') NOT IN ('local','spontaneous_tx')
      AND COALESCE(btrim(actor_label),'') = ''
)
SELECT v.c, count(*)::int,
       CASE WHEN count(*) = 0 THEN 'PASSOU' ELSE 'REPROVADO' END,
       COALESCE(string_agg(left(v.id::text, 8), ', ' ORDER BY v.id) FILTER (WHERE v.id IS NOT NULL), '—')
  FROM v GROUP BY v.c
UNION ALL
-- critérios sem violações possíveis aparecem explicitamente como PASSOU
SELECT x.c, 0, 'PASSOU', '—'
  FROM (VALUES ('1. remoto sem usuário'),('2. rótulo técnico como usuário'),
               ('2b. rótulo provisório como usuário'),('3. técnico/polling no histórico oficial'),
               ('4. duplicidade sem transição física'),('5. remoto sem fonte de autoria auditável'),
               ('6. automação sem nome de regra'),('7. local sem evidência física')) x(c)
 WHERE NOT EXISTS (
   SELECT 1 FROM (
     SELECT '1. remoto sem usuário' c FROM ofic WHERE origin='remote'::public.event_origin AND user_id IS NULL
     UNION ALL SELECT '2. rótulo técnico como usuário' FROM ofic
       WHERE origin='remote'::public.event_origin AND public.is_technical_actor_label(actor_label)
     UNION ALL SELECT '2b. rótulo provisório como usuário' FROM ofic
       WHERE lower(COALESCE(actor_label,'')) IN ('autoria histórica em revisão','comando remoto','em apuração','remoto não identificado')
     UNION ALL SELECT '3. técnico/polling no histórico oficial' FROM ofic
       WHERE origin='reading'::public.event_origin OR equipment_id IS NULL
     UNION ALL SELECT '5. remoto sem fonte de autoria auditável' FROM ofic
       WHERE origin='remote'::public.event_origin AND (user_id IS NULL OR user_email IS NULL OR COALESCE(details->>'authorship_source','')='')
     UNION ALL SELECT '6. automação sem nome de regra' FROM ofic
       WHERE origin='auto'::public.event_origin AND COALESCE(btrim(actor_label),'')=''
     UNION ALL SELECT '7. local sem evidência física' FROM ofic
       WHERE origin='local'::public.event_origin AND COALESCE(details->>'origin','') NOT IN ('local','spontaneous_tx')
         AND COALESCE(btrim(actor_label),'')=''
   ) y WHERE y.c = x.c)
ORDER BY 1;
$$;
GRANT EXECUTE ON FUNCTION public.automation_report_acceptance(uuid) TO authenticated, service_role;

-- ── ETAPA B.2 — DIVIDIR LOTE quando há autores diferentes ───────────────────
-- Cria um novo lote pendente com o subconjunto informado, removendo-o do
-- original. Permite atribuir autores distintos a subgrupos do mesmo período.
CREATE OR REPLACE FUNCTION public.split_reconciliation_batch(
  _queue_id uuid, _subset_ids uuid[], _executor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE q public.remote_reconciliation_queue%ROWTYPE; v_new uuid; v_rest uuid[];
BEGIN
  IF _executor IS NULL THEN RAISE EXCEPTION 'ABORTADO: executor obrigatório'; END IF;
  SELECT * INTO q FROM public.remote_reconciliation_queue WHERE id=_queue_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ABORTADO: lote inexistente'; END IF;
  IF q.status <> 'pending' THEN RAISE EXCEPTION 'ABORTADO: lote já %', q.status; END IF;
  IF NOT (q.event_ids @> _subset_ids) THEN
    RAISE EXCEPTION 'ABORTADO: subconjunto não pertence ao lote';
  END IF;
  IF COALESCE(array_length(_subset_ids,1),0) = 0
     OR array_length(_subset_ids,1) >= array_length(q.event_ids,1) THEN
    RAISE EXCEPTION 'ABORTADO: subconjunto precisa ser não-vazio e menor que o lote';
  END IF;

  SELECT array_agg(x) INTO v_rest
    FROM unnest(q.event_ids) x WHERE NOT (x = ANY(_subset_ids));

  INSERT INTO public.remote_reconciliation_queue (
    farm_id, batch_id, started_at, ended_at, intent, event_ids,
    events_total, events_unnamed, candidates)
  SELECT q.farm_id, q.batch_id || '-s' || substr(md5(_subset_ids::text),1,4),
         min(al.occurred_at), max(al.occurred_at), q.intent, _subset_ids,
         array_length(_subset_ids,1),
         count(*) FILTER (WHERE al.user_id IS NULL)::int, q.candidates
    FROM public.automation_log al WHERE al.id = ANY(_subset_ids)
  RETURNING id INTO v_new;

  UPDATE public.remote_reconciliation_queue
     SET event_ids = v_rest,
         events_total = array_length(v_rest,1),
         events_unnamed = (SELECT count(*)::int FROM public.automation_log al
                            WHERE al.id = ANY(v_rest) AND al.user_id IS NULL)
   WHERE id = _queue_id;

  RETURN v_new;
END; $$;
GRANT EXECUTE ON FUNCTION public.split_reconciliation_batch(uuid, uuid[], uuid) TO service_role;

-- ============================================================================
-- PROVA EXIGIDA (Etapa D) — rodar e anexar o resultado:
--   SELECT * FROM public.automation_report_farm_audit();      -- panorama global
--   SELECT * FROM public.automation_report_acceptance();      -- TODAS as fazendas
--   SELECT * FROM public.automation_report_acceptance('<farm_id>');  -- por fazenda
-- A entrega só está pronta quando TODA linha de `automation_report_acceptance()`
-- estiver com situacao='PASSOU'.
-- ============================================================================
