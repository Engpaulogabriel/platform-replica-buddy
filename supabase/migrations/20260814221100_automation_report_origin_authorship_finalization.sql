-- ============================================================================
-- FASE B.2 — ORIGEM E AUTORIA FINAIS. Dados, não texto de tela.
-- ----------------------------------------------------------------------------
-- Alvos reais medidos na Fase A:
--   A (origin='system') ...............     56
--   B (rótulo genérico/técnico) .......  3.156
--   D (Local com comando remoto) ......      1
--   437 remotos sem autor → 262 lotes; 60 lotes com candidato corroborated_batch
--
-- PRINCÍPIO: nunca inventar pessoa. Sem prova suficiente, a linha SAI do
-- relatório oficial e entra na fila administrativa. Não fica texto genérico.
-- Quando o platform_admin confirmar o lote, a linha VOLTA ao oficial.
-- ============================================================================

-- ── 1) EVIDÊNCIA DE ORIGEM/AUTORIA, EM ORDEM ────────────────────────────────
-- Devolve a melhor prova disponível para UMA linha. Só isso decide.
CREATE OR REPLACE FUNCTION public.resolve_event_authorship(_log_id uuid)
RETURNS TABLE (
  origin_final text, user_id uuid, user_email text, actor_label text,
  evidence_source text, confidence text, evidence jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE al public.automation_log%ROWTYPE; v_intent text; r record;
BEGIN
  SELECT * INTO al FROM public.automation_log WHERE id = _log_id;
  IF NOT FOUND THEN RETURN; END IF;
  v_intent := CASE WHEN al.action IN ('turn_on','pump_on') THEN 'turn_on' ELSE 'turn_off' END;

  -- (1) command_audit correlacionado: a prova mais forte que existe.
  SELECT ca.user_id, ca.user_email, ca.actor_label, ca.command_id
    INTO r
    FROM public.command_audit ca
   WHERE ca.equipment_id = al.equipment_id
     AND ca.user_id IS NOT NULL
     AND ca.intent = v_intent
     AND ca.command_created_at BETWEEN al.occurred_at - interval '180 seconds'
                                   AND al.occurred_at + interval '180 seconds'
   ORDER BY abs(extract(epoch FROM (ca.command_created_at - al.occurred_at)))
   LIMIT 1;
  IF FOUND AND r.user_id IS NOT NULL THEN
    RETURN QUERY SELECT 'remote', r.user_id, r.user_email,
      COALESCE(NULLIF(btrim(r.actor_label),''),
               (SELECT p.full_name FROM public.profiles p WHERE p.id = r.user_id)),
      'command_audit', 'strong',
      jsonb_build_object('command_id', r.command_id, 'intent', v_intent);
    RETURN;
  END IF;

  -- (2) vínculo direto de comando ainda vivo em `commands`.
  SELECT c.created_by AS user_id, p.email, p.full_name, c.id AS command_id
    INTO r
    FROM public.commands c
    LEFT JOIN public.profiles p ON p.id = c.created_by
   WHERE c.equipment_id = al.equipment_id AND c.created_by IS NOT NULL
     AND c.created_at BETWEEN al.occurred_at - interval '180 seconds'
                          AND al.occurred_at + interval '180 seconds'
   ORDER BY abs(extract(epoch FROM (c.created_at - al.occurred_at))) LIMIT 1;
  IF FOUND AND r.user_id IS NOT NULL THEN
    RETURN QUERY SELECT 'remote', r.user_id, r.email, r.full_name,
      'commands', 'strong', jsonb_build_object('command_id', r.command_id);
    RETURN;
  END IF;

  -- (3) autoria estruturada no próprio details.
  IF public.parse_user_uuid(al.details->>'user_id') IS NOT NULL
     OR public.parse_user_uuid(al.details->>'requested_by') IS NOT NULL
     OR public.parse_user_uuid(al.details->>'created_by') IS NOT NULL THEN
    SELECT p.id, p.email, p.full_name INTO r
      FROM public.profiles p
     WHERE p.id = COALESCE(public.parse_user_uuid(al.details->>'user_id'),
                           public.parse_user_uuid(al.details->>'requested_by'),
                           public.parse_user_uuid(al.details->>'created_by'));
    IF FOUND THEN
      RETURN QUERY SELECT 'remote', r.id, r.email, r.full_name,
        'details_structured', 'strong', jsonb_build_object('from','details');
      RETURN;
    END IF;
  END IF;

  -- (4) automação identificada: a regra é o autor.
  IF al.details->>'rule_name' IS NOT NULL OR al.details->>'schedule_id' IS NOT NULL THEN
    RETURN QUERY SELECT 'auto', NULL::uuid, NULL::text,
      COALESCE(al.details->>'rule_name',
               (SELECT s.name FROM public.scheduled_automations s
                 WHERE s.id::text = al.details->>'schedule_id')),
      'automation_rule', 'strong',
      jsonb_build_object('schedule_id', al.details->>'schedule_id');
    RETURN;
  END IF;

  -- (5) TX espontâneo CONFIRMA um Local já declarado — nunca INVENTA um.
  --     Ausência de comando não é prova de botoeira: `commands` é tabela de
  --     trabalho e sofre delete (foi por isso que command_audit existe). Então
  --     só usamos esta regra para RATIFICAR uma linha que já se diz local. Uma
  --     linha 'system' sem prova nenhuma vai para a fila administrativa, não
  --     vira Local por eliminação.
  IF al.origin = 'local'::public.event_origin AND NOT EXISTS (
        SELECT 1 FROM public.command_audit ca
         WHERE ca.equipment_id = al.equipment_id
           AND ca.command_created_at BETWEEN al.occurred_at - interval '180 seconds'
                                         AND al.occurred_at + interval '180 seconds')
     AND NOT EXISTS (
        SELECT 1 FROM public.commands c
         WHERE c.equipment_id = al.equipment_id
           AND c.created_at BETWEEN al.occurred_at - interval '180 seconds'
                                AND al.occurred_at + interval '180 seconds')
     AND (al.result = 'success'::public.event_result
          OR al.details->>'state_confirmed' = 'true') THEN
    RETURN QUERY SELECT 'local', NULL::uuid, NULL::text, 'Acionamento local'::text,
      'spontaneous_tx', 'strong',
      jsonb_build_object('rule','transição física confirmada sem comando compatível na janela');
    RETURN;
  END IF;

  -- (6) sem prova suficiente. NÃO inventa pessoa.
  RETURN QUERY SELECT NULL::text, NULL::uuid, NULL::text, NULL::text,
    'none', 'none', jsonb_build_object('rule','nenhuma evidência suficiente');
END; $$;
GRANT EXECUTE ON FUNCTION public.resolve_event_authorship(uuid) TO authenticated, service_role;

-- ── 2) APLICAÇÃO: corrige o que tem prova, enfileira o resto ────────────────
CREATE OR REPLACE FUNCTION public.finalize_origin_and_authorship(
  _run_id uuid, _farm_id uuid DEFAULT NULL)
RETURNS TABLE (corrigidos int, enfileirados int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; ev record; v_fix int := 0; v_q int := 0;
BEGIN
  FOR r IN
    SELECT c.id, c.farm_id, c.equipment_id, c.issue
      FROM public.automation_row_classified c
     WHERE c.issue IN ('A_origem_indefinida','B_usuario_tecnico',
                       'C_remoto_sem_autor','D_local_com_comando','E_auto_sem_regra')
       AND (_farm_id IS NULL OR c.farm_id = _farm_id)
  LOOP
    SELECT * INTO ev FROM public.resolve_event_authorship(r.id);

    IF ev.confidence = 'strong' THEN
      INSERT INTO public.automation_cleanup_audit
        (run_id, event_id, farm_id, equipment_id, phase_a_category, action,
         before_value, after_value, evidence, evidence_source, confidence, reason, executed_by)
      VALUES (_run_id, r.id, r.farm_id, r.equipment_id, r.issue, 'origin_changed',
        public.automation_row_snapshot(r.id),
        jsonb_build_object('origin', ev.origin_final, 'user_id', ev.user_id,
                           'user_email', ev.user_email, 'actor_label', ev.actor_label),
        ev.evidence, ev.evidence_source, ev.confidence,
        'origem/autoria resolvida por evidência', 'finalize_origin_and_authorship');

      UPDATE public.automation_log al
         SET origin      = ev.origin_final::public.event_origin,
             user_id     = ev.user_id,
             user_email  = ev.user_email,
             actor_label = ev.actor_label,
             details     = al.details
                           || jsonb_build_object('authorship_source', ev.evidence_source,
                                                 'authorship_confidence', ev.confidence)
       WHERE al.id = r.id;
      v_fix := v_fix + 1;

    ELSE
      -- SEM PROVA: sai do oficial e vai para a fila administrativa.
      -- Não fica "Origem em apuração" em lugar nenhum do relatório.
      INSERT INTO public.automation_cleanup_audit
        (run_id, event_id, farm_id, equipment_id, phase_a_category, action,
         before_value, after_value, evidence_source, confidence, reason, executed_by)
      VALUES (_run_id, r.id, r.farm_id, r.equipment_id, r.issue, 'queued',
        public.automation_row_snapshot(r.id),
        jsonb_build_object('noise_reason','pending_authorship_review'),
        'none', 'none',
        'transição sem prova de origem/autoria — decisão administrativa', 'finalize_origin_and_authorship');

      UPDATE public.automation_log
         SET noise_reason = 'pending_authorship_review'
       WHERE id = r.id AND noise_reason IS NULL;

      INSERT INTO public.authorship_pending_review (farm_id, automation_log_id, reason)
      VALUES (r.farm_id, r.id, 'pending_authorship_review')
      ON CONFLICT (automation_log_id) DO NOTHING;
      v_q := v_q + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_fix, v_q;
END; $$;
GRANT EXECUTE ON FUNCTION public.finalize_origin_and_authorship(uuid, uuid) TO service_role;

-- ── 3) LOTES `corroborated_batch` — NUNCA automáticos ───────────────────────
-- Os 60 lotes cujo único indício é "esse nome já aparece no lote" permanecem
-- CANDIDATOS. A fonte é registrada como legado, e só o platform_admin decide.
CREATE OR REPLACE FUNCTION public.mark_corroborated_candidates(_run_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int;
BEGIN
  UPDATE public.authorship_reconciliation_batches b
     SET candidate_source = 'nome_ja_presente_no_lote:legado_sem_fonte',
         candidate_confidence = 'corroborated',
         requires_admin_decision = true
   WHERE b.applied_at IS NULL
     AND COALESCE(b.candidate_source,'') IN ('', 'corroborated_batch');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;

-- Colunas de apoio (idempotentes) para a decisão administrativa.
ALTER TABLE public.authorship_reconciliation_batches
  ADD COLUMN IF NOT EXISTS candidate_source        text,
  ADD COLUMN IF NOT EXISTS candidate_confidence    text,
  ADD COLUMN IF NOT EXISTS requires_admin_decision boolean NOT NULL DEFAULT false;

-- ── 4) CONFIRMAÇÃO EM LOTE PELO platform_admin ──────────────────────────────
-- Reintroduz no oficial SOMENTE os IDs congelados, com autoria auditável.
CREATE OR REPLACE FUNCTION public.confirm_authorship_batch(
  _batch_id uuid, _user_id uuid, _admin_id uuid, _expected_count int)
RETURNS TABLE (restaurados int, run_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids uuid[]; v_run uuid := gen_random_uuid(); v_n int;
        v_email text; v_nome text;
BEGIN
  IF NOT public.is_platform_admin(_admin_id) THEN
    RAISE EXCEPTION 'somente platform_admin pode confirmar autoria em lote';
  END IF;

  SELECT array_agg(DISTINCT e.eid) INTO v_ids
    FROM public.remote_reconciliation_queue q
    CROSS JOIN LATERAL unnest(q.event_ids) AS e(eid)
   WHERE q.batch_id = _batch_id AND q.applied_at IS NULL;

  -- trava de contagem: o lote não pode ter mudado desde a análise
  IF COALESCE(array_length(v_ids,1),0) <> _expected_count THEN
    RAISE EXCEPTION 'lote mudou: esperado %, encontrado %',
      _expected_count, COALESCE(array_length(v_ids,1),0);
  END IF;

  SELECT p.email, p.full_name INTO v_email, v_nome
    FROM public.profiles p WHERE p.id = _user_id;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'usuário % não existe em profiles — não se inventa pessoa', _user_id;
  END IF;

  INSERT INTO public.automation_cleanup_audit
    (run_id, event_id, farm_id, equipment_id, phase_a_category, action,
     before_value, after_value, evidence_source, confidence, reason, executed_by)
  SELECT v_run, al.id, al.farm_id, al.equipment_id, 'C_remoto_sem_autor', 'authorship_set',
         public.automation_row_snapshot(al.id),
         jsonb_build_object('origin','remote','user_id',_user_id,
                            'user_email',v_email,'actor_label',v_nome,
                            'noise_reason', NULL),
         'admin_decision', 'admin',
         'confirmação administrativa do lote ' || _batch_id::text, 'confirm_authorship_batch'
    FROM public.automation_log al WHERE al.id = ANY(v_ids);

  UPDATE public.automation_log al
     SET origin       = 'remote'::public.event_origin,
         user_id      = _user_id,
         user_email   = v_email,
         actor_label  = v_nome,
         noise_reason = NULL,                    -- volta ao relatório oficial
         details      = al.details || jsonb_build_object(
                          'authorship_source','admin_decision',
                          'authorship_confidence','admin',
                          'decided_by', _admin_id, 'batch_id', _batch_id)
   WHERE al.id = ANY(v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.remote_reconciliation_queue
     SET applied_at = now() WHERE batch_id = _batch_id AND applied_at IS NULL;
  UPDATE public.authorship_pending_review
     SET resolved_at = now(), resolved_by = _admin_id
   WHERE automation_log_id = ANY(v_ids);

  RETURN QUERY SELECT v_n, v_run;
END; $$;
GRANT EXECUTE ON FUNCTION public.confirm_authorship_batch(uuid, uuid, uuid, int) TO authenticated, service_role;

-- ============================================================================
-- USO
--   SELECT * FROM public.finalize_origin_and_authorship(gen_random_uuid());
--   SELECT public.mark_corroborated_candidates(gen_random_uuid());
--   SELECT * FROM public.confirm_authorship_batch('<batch>','<user>','<admin>', 7);
-- ============================================================================
