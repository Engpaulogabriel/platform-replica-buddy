-- ============================================================================
-- RECUPERAÇÃO GLOBAL DE AUTORIA REMOTA — descobrir e GRAVAR o nome real.
-- ----------------------------------------------------------------------------
-- Não é mitigação de tela. O objetivo é recuperar a identidade de CADA evento
-- remoto histórico sem user_id, em TODAS as fazendas, e gravá-la.
--
-- Esta migration entrega:
--   1. catálogo dinâmico das fontes de autoria que EXISTEM no schema;
--   2. busca de candidatos por evento, em todas as fontes (a–g);
--   3. agrupamento em lotes + tabela de decisão;
--   4. fila de reconciliação em LOTE (uma escolha aplica o lote inteiro);
--   5. aplicação com travas (congela ids, aborta se mudar, audita).
--
-- NADA é alterado na criação. As funções de análise são read-only; a de
-- aplicação só age quando chamada explicitamente com os ids conferidos.
--
-- Observação verificada no schema: NÃO existe `user_activity_log`. As trilhas
-- reais são automation_audit_log, device_audit_log, whatsapp_audit_log,
-- whatsapp_message_log, command_verifications, login_attempts e afins — por
-- isso o catálogo é DINÂMICO, e não uma lista fixa que envelhece.
-- ============================================================================

-- ── 1) CATÁLOGO DINÂMICO DE FONTES ──────────────────────────────────────────
-- Descobre toda tabela do schema public que tenha uma coluna de identidade
-- (user_id/email/actor/operator/requested_by/created_by/command_id) e uma
-- coluna temporal — ou seja, tudo que PODE testemunhar autoria.
CREATE OR REPLACE FUNCTION public.authorship_source_catalog()
RETURNS TABLE (tabela text, coluna_identidade text, tipo text, coluna_tempo text, coluna_farm text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.table_name::text,
         c.column_name::text,
         c.data_type::text,
         (SELECT t2.column_name FROM information_schema.columns t2
           WHERE t2.table_schema='public' AND t2.table_name=c.table_name
             AND t2.data_type LIKE 'timestamp%'
           ORDER BY CASE t2.column_name WHEN 'occurred_at' THEN 1 WHEN 'created_at' THEN 2 ELSE 3 END
           LIMIT 1)::text,
         (SELECT t3.column_name FROM information_schema.columns t3
           WHERE t3.table_schema='public' AND t3.table_name=c.table_name
             AND t3.column_name = 'farm_id' LIMIT 1)::text
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.column_name IN ('user_id','user_email','email','actor','actor_label','operator',
                           'operator_name','requested_by','created_by','command_id','last_changed_by')
     AND c.table_name <> 'automation_log'
     AND EXISTS (SELECT 1 FROM information_schema.columns t4
                  WHERE t4.table_schema='public' AND t4.table_name=c.table_name
                    AND t4.data_type LIKE 'timestamp%')
   ORDER BY c.table_name, c.column_name;
$$;
GRANT EXECUTE ON FUNCTION public.authorship_source_catalog() TO authenticated, service_role;

-- ── 2) CANDIDATOS POR EVENTO — fontes (a) a (f) ─────────────────────────────
-- Devolve, para um evento remoto sem autor, todo usuário humano que qualquer
-- fonte aponta, com a força da evidência. NÃO decide nada.
CREATE OR REPLACE FUNCTION public.remote_event_authorship_candidates(_log_id uuid, _window interval DEFAULT interval '10 minutes')
RETURNS TABLE (user_id uuid, nome text, email text, fonte text, forca text, evidencia text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE ev public.automation_log%ROWTYPE; r record; sql text; n int;
BEGIN
  SELECT * INTO ev FROM public.automation_log WHERE id = _log_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- (a) command_audit — vínculo explícito
  RETURN QUERY
  SELECT ca.user_id, p.full_name, ca.user_email, 'command_audit'::text, 'forte'::text,
         'command_id=' || ca.command_id::text
    FROM public.command_audit ca LEFT JOIN public.profiles p ON p.id = ca.user_id
   WHERE ca.user_id IS NOT NULL AND ca.farm_id = ev.farm_id
     AND ( ca.command_id::text = ev.details->>'command_id'
        OR (ev.client_event_id IS NOT NULL AND ca.client_event_id = ev.client_event_id)
        OR (ca.equipment_id = ev.equipment_id
            AND ca.command_created_at BETWEEN ev.occurred_at - _window AND ev.occurred_at + _window));

  -- (b) commands ainda existentes
  RETURN QUERY
  SELECT c.created_by, p.full_name, p.email, 'commands'::text, 'forte'::text,
         'commands.id=' || c.id::text
    FROM public.commands c LEFT JOIN public.profiles p ON p.id = c.created_by
   WHERE c.created_by IS NOT NULL AND c.farm_id = ev.farm_id
     AND (c.equipment_id = ev.equipment_id OR c.id::text = ev.details->>'command_id')
     AND COALESCE(c.sent_at, c.created_at) BETWEEN ev.occurred_at - _window AND ev.occurred_at + _window;

  -- (c) qualquer UUID/e-mail dentro do próprio details
  RETURN QUERY
  SELECT p.id, p.full_name, p.email, 'details_json'::text, 'forte'::text,
         'details.' || k
    FROM jsonb_each_text(COALESCE(ev.details,'{}'::jsonb)) AS d(k, v)
    JOIN public.profiles p
      ON p.id::text = d.v OR p.email = d.v
   WHERE d.k IN ('user_id','user_email','actor','requested_by','created_by','email','operator');

  -- (e) operador de WhatsApp vinculado
  RETURN QUERY
  SELECT w.user_id, p.full_name, p.email, 'whatsapp_operator'::text, 'forte'::text,
         'source_device=' || COALESCE(ev.source_device,'')
    FROM public.whatsapp_operators w LEFT JOIN public.profiles p ON p.id = w.user_id
   WHERE w.user_id IS NOT NULL
     AND lower(COALESCE(ev.source_device,'')) LIKE 'whatsapp%'
     AND (w.farm_id = ev.farm_id OR w.farm_id IS NULL)
     AND lower(COALESCE(ev.source_device,'')) LIKE '%' || lower(w.name) || '%';

  -- (d)+(f) varredura DINÂMICA das demais trilhas do schema, na janela e fazenda
  FOR r IN SELECT * FROM public.authorship_source_catalog()
           WHERE coluna_identidade = 'user_id' AND coluna_tempo IS NOT NULL AND coluna_farm IS NOT NULL
  LOOP
    BEGIN
      sql := format(
        'SELECT t.%I::uuid FROM public.%I t WHERE t.%I IS NOT NULL AND t.%I = $1 '
        || 'AND t.%I BETWEEN $2 - $3 AND $2 + $3 LIMIT 50',
        r.coluna_identidade, r.tabela, r.coluna_identidade, r.coluna_farm, r.coluna_tempo);
      RETURN QUERY EXECUTE
        format('SELECT q.uid, p.full_name, p.email, %L::text, %L::text, %L::text
                  FROM (%s) q(uid) JOIN public.profiles p ON p.id = q.uid',
               r.tabela, 'temporal', r.tabela || '.' || r.coluna_identidade || ' em ±janela', sql)
        USING ev.farm_id, ev.occurred_at, _window;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- tabela sem permissão/formato inesperado: ignora, nunca quebra a análise
    END;
  END LOOP;
END; $$;
GRANT EXECUTE ON FUNCTION public.remote_event_authorship_candidates(uuid, interval) TO authenticated, service_role;

-- ── 3) LOTES + TABELA DE DECISÃO (item 6) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.remote_authorship_decision(
  _farm_id uuid DEFAULT NULL, _gap interval DEFAULT interval '5 minutes')
RETURNS TABLE (
  fazenda text, batch_id text, inicio_brt text, fim_brt text, acao text,
  eventos int, sem_nome int,
  pessoa_candidata text, candidata_user_id uuid,
  evidencias text, conflito boolean, candidatas int,
  acao_proposta text, ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH base AS (
  SELECT al.*, CASE WHEN al.action IN ('turn_on','pump_on') THEN 'ligar' ELSE 'desligar' END AS intencao
    FROM public.automation_log al
   WHERE al.noise_reason IS NULL AND al.origin = 'remote'::public.event_origin
     AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND (_farm_id IS NULL OR al.farm_id = _farm_id)
), marc AS (
  SELECT b.*, CASE WHEN lag(b.occurred_at) OVER w IS NULL
                    OR b.occurred_at - lag(b.occurred_at) OVER w > _gap THEN 1 ELSE 0 END AS novo
    FROM base b WINDOW w AS (PARTITION BY b.farm_id, b.intencao ORDER BY b.occurred_at)
), num AS (
  SELECT m.*, sum(m.novo) OVER (PARTITION BY m.farm_id, m.intencao ORDER BY m.occurred_at
                                ROWS UNBOUNDED PRECEDING) AS g FROM marc m
), agg AS (
  SELECT n.farm_id, n.intencao, n.g,
         min(n.occurred_at) ini, max(n.occurred_at) fim,
         count(*)::int total, count(*) FILTER (WHERE n.user_id IS NULL)::int sem_nome,
         array_agg(n.id) ids,
         array_agg(DISTINCT n.user_id) FILTER (WHERE n.user_id IS NOT NULL) humanos,
         string_agg(DISTINCT n.details->>'authorship_source', ', ') fontes
    FROM num n GROUP BY n.farm_id, n.intencao, n.g
)
SELECT f.name,
  to_char(a.ini AT TIME ZONE 'America/Sao_Paulo','YYYYMMDD-HH24MISS') || '-' || a.intencao,
  to_char(a.ini AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
  to_char(a.fim AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
  a.intencao, a.total, a.sem_nome,
  p.full_name, (a.humanos)[1],
  COALESCE(a.fontes,'—')
    || CASE WHEN EXISTS (
         SELECT 1 FROM public.automation_log x WHERE x.farm_id = a.farm_id
          AND x.origin IN ('auto'::public.event_origin,'local'::public.event_origin)
          AND x.noise_reason IS NULL AND x.occurred_at BETWEEN a.ini AND a.fim)
       THEN ' | JANELA CONTAMINADA (auto/local)' ELSE '' END,
  COALESCE(array_length(a.humanos,1),0) > 1,
  COALESCE(array_length(a.humanos,1),0),
  CASE
    WHEN a.sem_nome = 0 THEN 'nada a fazer — lote completo'
    WHEN COALESCE(array_length(a.humanos,1),0) = 1 THEN 'RECONCILIAR lote inteiro com a pessoa única do lote'
    WHEN COALESCE(array_length(a.humanos,1),0) > 1 THEN 'ESCOLHA ADMINISTRATIVA — mais de uma pessoa no lote'
    ELSE 'BUSCAR candidatos nas trilhas (remote_event_authorship_candidates) e escolher'
  END,
  a.ids
FROM agg a
JOIN public.farms f ON f.id = a.farm_id
LEFT JOIN public.profiles p ON p.id = (a.humanos)[1]
WHERE a.sem_nome > 0
ORDER BY a.ini DESC;
$$;
GRANT EXECUTE ON FUNCTION public.remote_authorship_decision(uuid, interval) TO authenticated, service_role;

-- ── 4) LOTES + FILA DE RECONCILIAÇÃO ────────────────────────────────────────
-- authorship_reconciliation_batches: registro APPEND-ONLY do lote operacional
-- (o "o que foi decidido"). remote_reconciliation_queue: o estado de trabalho
-- (o "o que falta decidir"). Separadas de propósito: a fila é consumida, o
-- registro do lote permanece para auditoria.
CREATE TABLE IF NOT EXISTS public.authorship_reconciliation_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id        uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  batch_id       text NOT NULL,
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz NOT NULL,
  intent         text NOT NULL,
  event_ids      uuid[] NOT NULL,
  events_total   int NOT NULL,
  applied_user   uuid,
  applied_email  text,
  applied_actor  text,
  applied_by     uuid,
  applied_at     timestamptz NOT NULL DEFAULT now(),
  evidence       text,
  confidence     text,
  source         text NOT NULL DEFAULT 'batch_reconciliation'
);
CREATE INDEX IF NOT EXISTS idx_arb_farm ON public.authorship_reconciliation_batches (farm_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_arb_batch ON public.authorship_reconciliation_batches (batch_id);
ALTER TABLE public.authorship_reconciliation_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS arb_select ON public.authorship_reconciliation_batches;
CREATE POLICY arb_select ON public.authorship_reconciliation_batches
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));
-- Sem policy de INSERT/UPDATE/DELETE: só o RPC SECURITY DEFINER escreve.

COMMENT ON TABLE public.authorship_reconciliation_batches IS
  'Registro append-only de cada reconciliação de autoria aplicada em lote: quem decidiu, quando, com que evidência e sobre quais ids.';

-- ── 4.1) FILA DE RECONCILIAÇÃO EM LOTE (item 8) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.remote_reconciliation_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id         uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  batch_id        text NOT NULL,
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz NOT NULL,
  intent          text NOT NULL,
  event_ids       uuid[] NOT NULL,
  events_total    int NOT NULL,
  events_unnamed  int NOT NULL,
  suggested_user  uuid,
  candidates      jsonb NOT NULL DEFAULT '[]'::jsonb,
  status          text NOT NULL DEFAULT 'pending',   -- pending | applied | dismissed
  applied_user    uuid,
  applied_by      uuid,
  applied_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rrq_batch_uniq UNIQUE (farm_id, batch_id),
  CONSTRAINT rrq_status_chk CHECK (status IN ('pending','applied','dismissed'))
);
CREATE INDEX IF NOT EXISTS idx_rrq_pending ON public.remote_reconciliation_queue (farm_id, started_at DESC) WHERE status = 'pending';
ALTER TABLE public.remote_reconciliation_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rrq_select ON public.remote_reconciliation_queue;
CREATE POLICY rrq_select ON public.remote_reconciliation_queue
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));

-- Popula/atualiza a fila a partir da análise. Idempotente por (farm, batch).
CREATE OR REPLACE FUNCTION public.enqueue_remote_reconciliation(_farm_id uuid DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n int := 0; v_cand jsonb;
BEGIN
  FOR r IN SELECT * FROM public.remote_authorship_decision(_farm_id) LOOP
    -- candidatos das trilhas para o PRIMEIRO evento sem nome do lote
    SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
             'user_id', c.user_id, 'nome', c.nome, 'email', c.email,
             'fonte', c.fonte, 'forca', c.forca)), '[]'::jsonb)
      INTO v_cand
      FROM public.automation_log al
      CROSS JOIN LATERAL public.remote_event_authorship_candidates(al.id) c
     WHERE al.id = ANY(r.ids) AND al.user_id IS NULL;

    INSERT INTO public.remote_reconciliation_queue (
      farm_id, batch_id, started_at, ended_at, intent, event_ids,
      events_total, events_unnamed, suggested_user, candidates)
    SELECT al.farm_id, r.batch_id, min(al.occurred_at), max(al.occurred_at), r.acao,
           r.ids, r.eventos, r.sem_nome,
           CASE WHEN r.candidatas = 1 THEN r.candidata_user_id
                WHEN jsonb_array_length(v_cand) = 1 THEN (v_cand->0->>'user_id')::uuid
                ELSE NULL END,
           v_cand
      FROM public.automation_log al WHERE al.id = ANY(r.ids)
     GROUP BY al.farm_id
    ON CONFLICT (farm_id, batch_id) DO UPDATE SET
      event_ids = EXCLUDED.event_ids, events_unnamed = EXCLUDED.events_unnamed,
      suggested_user = EXCLUDED.suggested_user, candidates = EXCLUDED.candidates
      WHERE public.remote_reconciliation_queue.status = 'pending';
    n := n + 1;
  END LOOP;
  RETURN n;
END; $$;
GRANT EXECUTE ON FUNCTION public.enqueue_remote_reconciliation(uuid) TO service_role;

-- ── 5) APLICAÇÃO COM TRAVAS (item 7) ────────────────────────────────────────
-- Congela os ids esperados; aborta se quantidade OU conjunto mudarem; grava
-- autoria + evidência + executor; fecha só as pendências desses ids.
CREATE OR REPLACE FUNCTION public.apply_remote_reconciliation(
  _queue_id uuid, _user_id uuid, _expected_ids uuid[], _executor uuid, _evidence text DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE q public.remote_reconciliation_queue%ROWTYPE; v_now uuid[]; n int; v_email text; v_nome text;
BEGIN
  IF _executor IS NULL THEN RAISE EXCEPTION 'ABORTADO: executor obrigatório'; END IF;
  SELECT * INTO q FROM public.remote_reconciliation_queue WHERE id = _queue_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ABORTADO: lote % inexistente', _queue_id; END IF;
  IF q.status <> 'pending' THEN RAISE EXCEPTION 'ABORTADO: lote já % (anti-replay)', q.status; END IF;

  SELECT p.email, p.full_name INTO v_email, v_nome FROM public.profiles p WHERE p.id = _user_id;
  IF v_nome IS NULL AND v_email IS NULL THEN
    RAISE EXCEPTION 'ABORTADO: user_id % não existe em profiles', _user_id;
  END IF;

  -- conjunto ATUAL de eventos sem nome do lote
  SELECT array_agg(al.id ORDER BY al.id) INTO v_now
    FROM public.automation_log al
   WHERE al.id = ANY(q.event_ids) AND al.user_id IS NULL;

  IF COALESCE(array_length(v_now,1),0) <> COALESCE(array_length(_expected_ids,1),0)
     OR NOT (v_now @> _expected_ids AND _expected_ids @> v_now) THEN
    RAISE EXCEPTION 'ABORTADO: conjunto mudou desde a conferência (esperado %, atual %). Nada alterado.',
      COALESCE(array_length(_expected_ids,1),0), COALESCE(array_length(v_now,1),0);
  END IF;

  UPDATE public.automation_log al
     SET user_id = _user_id, user_email = v_email, actor_label = COALESCE(v_nome, v_email),
         details = COALESCE(al.details,'{}'::jsonb) || jsonb_build_object(
           'authorship_source','batch_reconciliation',
           'authorship_confidence','strong',
           'authorship_evidence', COALESCE(_evidence, 'reconciliação de lote ' || q.batch_id),
           'authorship_batch_id', q.batch_id,
           'authorship_verified_at', now(),
           'authorship_verified_by', _executor)
   WHERE al.id = ANY(_expected_ids)
     AND al.origin = 'remote'::public.event_origin;   -- nunca local/automação
  GET DIAGNOSTICS n = ROW_COUNT;

  UPDATE public.authorship_pending_review r
     SET resolved_at = now(), resolved_by = _executor
   WHERE r.automation_log_id = ANY(_expected_ids) AND r.resolved_at IS NULL;

  UPDATE public.remote_reconciliation_queue
     SET status='applied', applied_user=_user_id, applied_by=_executor, applied_at=now()
   WHERE id = _queue_id;

  -- registro append-only do que foi decidido (permanece após a fila esvaziar)
  INSERT INTO public.authorship_reconciliation_batches (
    farm_id, batch_id, started_at, ended_at, intent, event_ids, events_total,
    applied_user, applied_email, applied_actor, applied_by, evidence, confidence)
  VALUES (q.farm_id, q.batch_id, q.started_at, q.ended_at, q.intent,
          _expected_ids, COALESCE(array_length(_expected_ids,1),0),
          _user_id, v_email, COALESCE(v_nome, v_email), _executor,
          COALESCE(_evidence, 'reconciliação de lote ' || q.batch_id), 'strong');

  RETURN n;
END; $$;
GRANT EXECUTE ON FUNCTION public.apply_remote_reconciliation(uuid, uuid, uuid[], uuid, text) TO service_role;

-- ============================================================================
-- USO (nada é alterado pelas consultas de análise)
--   SELECT * FROM public.authorship_source_catalog();          -- fontes existentes
--   SELECT * FROM public.remote_authorship_decision();         -- TABELA DE DECISÃO global
--   SELECT * FROM public.remote_authorship_decision('<farm>'); -- Semear primeiro
--   SELECT * FROM public.remote_event_authorship_candidates('<log_id>');  -- por evento
--   SELECT public.enqueue_remote_reconciliation();             -- monta a fila
--   SELECT public.apply_remote_reconciliation('<queue_id>','<user>','{ids}'::uuid[],'<admin>');
-- ============================================================================
