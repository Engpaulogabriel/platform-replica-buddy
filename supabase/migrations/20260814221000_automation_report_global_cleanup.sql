-- ============================================================================
-- FASE B.1 — LIMPEZA GLOBAL AUDITÁVEL do Relatório de Automação.
-- ----------------------------------------------------------------------------
-- Baseline REAL medido pela Fase A em produção:
--   F (técnico/ruído no oficial) ....... 66.065
--   B (rótulo genérico/técnico) ........  3.156
--   A (origin='system') ................     56
--   duplicidades .......................     30
--   D (Local com comando remoto) .......      1
--   C = 0, E = 0, G = 0
--
-- NADA É APAGADO. Linha excluída do oficial recebe `noise_reason` e continua
-- inteira na tabela, acessível pela auditoria técnica. Toda mudança é gravada
-- antes de acontecer, com valor anterior, evidência e razão.
--
-- Idempotente e reversível. Não toca agente, rádio, bridge, dashboard, relés,
-- FASE 2/3, OTA, automações, WhatsApp, energia nem INEMA.
-- ============================================================================

-- ── 1) TRILHA IMUTÁVEL ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.automation_cleanup_audit (
  id             bigserial PRIMARY KEY,
  run_id         uuid        NOT NULL,
  event_id       uuid        NOT NULL,
  farm_id        uuid,
  equipment_id   uuid,
  phase_a_category text      NOT NULL,   -- A_/B_/D_/F_/G_/DUP
  action         text        NOT NULL,   -- noise_marked | origin_changed | authorship_set | queued | restored
  before_value   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  after_value    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  evidence       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  evidence_source text,
  confidence     text,                   -- strong | corroborated | none
  reason         text        NOT NULL,
  executed_by    text        NOT NULL,   -- migration/função que executou
  executed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cleanup_audit_run   ON public.automation_cleanup_audit (run_id);
CREATE INDEX IF NOT EXISTS idx_cleanup_audit_event ON public.automation_cleanup_audit (event_id);
CREATE INDEX IF NOT EXISTS idx_cleanup_audit_farm  ON public.automation_cleanup_audit (farm_id, executed_at DESC);

ALTER TABLE public.automation_cleanup_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cleanup_audit_select ON public.automation_cleanup_audit;
CREATE POLICY cleanup_audit_select ON public.automation_cleanup_audit
  FOR SELECT TO authenticated USING (public.is_platform_staff(auth.uid()));
-- Sem policy de INSERT/UPDATE/DELETE: só funções SECURITY DEFINER escrevem.
-- Append-only reforçado por trigger:
CREATE OR REPLACE FUNCTION public.cleanup_audit_is_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'automation_cleanup_audit é append-only: % não é permitido', TG_OP;
END; $$;
DROP TRIGGER IF EXISTS trg_cleanup_audit_append_only ON public.automation_cleanup_audit;
CREATE TRIGGER trg_cleanup_audit_append_only
BEFORE UPDATE OR DELETE ON public.automation_cleanup_audit
FOR EACH ROW EXECUTE FUNCTION public.cleanup_audit_is_append_only();

COMMENT ON TABLE public.automation_cleanup_audit IS
  'Trilha imutável da Fase B: o que cada linha do relatório era antes, o que virou, com que evidência e por quê. Permite desfazer qualquer run.';

-- Snapshot do estado de uma linha, para gravar em before/after.
CREATE OR REPLACE FUNCTION public.automation_row_snapshot(_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'origin', al.origin::text, 'action', al.action::text, 'result', al.result::text,
    'actor_label', al.actor_label, 'user_id', al.user_id, 'user_email', al.user_email,
    'noise_reason', al.noise_reason, 'occurred_at', al.occurred_at,
    'equipment_name', al.equipment_name,
    'confirmation_method', al.details->>'confirmation_method',
    'authorship_source', al.details->>'authorship_source')
  FROM public.automation_log al WHERE al.id = _id;
$$;

-- ── 2) MARCAÇÃO COMO RUÍDO, SEMPRE COM TRILHA ───────────────────────────────
-- Único caminho de escrita. Grava a trilha ANTES do UPDATE.
CREATE OR REPLACE FUNCTION public.mark_automation_noise(
  _ids uuid[], _reason text, _category text, _run_id uuid,
  _evidence jsonb DEFAULT '{}'::jsonb, _executed_by text DEFAULT 'fase_b')
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int;
BEGIN
  IF _ids IS NULL OR array_length(_ids,1) IS NULL THEN RETURN 0; END IF;

  INSERT INTO public.automation_cleanup_audit
    (run_id, event_id, farm_id, equipment_id, phase_a_category, action,
     before_value, after_value, evidence, reason, executed_by)
  SELECT _run_id, al.id, al.farm_id, al.equipment_id, _category, 'noise_marked',
         public.automation_row_snapshot(al.id),
         jsonb_build_object('noise_reason', _reason),
         _evidence, _reason, _executed_by
    FROM public.automation_log al
   WHERE al.id = ANY(_ids) AND al.noise_reason IS NULL;   -- idempotente

  UPDATE public.automation_log al
     SET noise_reason = _reason
   WHERE al.id = ANY(_ids) AND al.noise_reason IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;
GRANT EXECUTE ON FUNCTION public.mark_automation_noise(uuid[], text, text, uuid, jsonb, text) TO service_role;

-- ── 3.A) CATEGORIA F — técnico/ruído (baseline 66.065) ──────────────────────
CREATE OR REPLACE FUNCTION public.cleanup_technical_events(_run_id uuid, _farm_id uuid DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids uuid[];
BEGIN
  SELECT array_agg(c.id) INTO v_ids
    FROM public.automation_row_classified c
   WHERE c.issue = 'F_tecnico' AND (_farm_id IS NULL OR c.farm_id = _farm_id);
  RETURN public.mark_automation_noise(
    v_ids, 'technical_not_a_transition', 'F_tecnico', _run_id,
    jsonb_build_object('rule','ação não-operacional (polling/status_read/mode_change/reset) ou origin=reading'),
    'cleanup_technical_events');
END; $$;

-- ── 3.B) RESULTADO FALHO/TIMEOUT SEM CONFIRMAÇÃO FÍSICA ─────────────────────
-- "Desligada | Falhou" não é transição física. Sai do oficial preservando
-- usuário, command_id e details para investigação (a linha continua inteira).
CREATE OR REPLACE FUNCTION public.cleanup_unconfirmed_commands(_run_id uuid, _farm_id uuid DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids uuid[];
BEGIN
  SELECT array_agg(al.id) INTO v_ids
    FROM public.automation_log al
   WHERE al.noise_reason IS NULL
     AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND al.result IN ('fail'::public.event_result, 'timeout'::public.event_result,
                       'pending'::public.event_result)
     AND COALESCE(al.details->>'state_confirmed','') <> 'true'
     AND (_farm_id IS NULL OR al.farm_id = _farm_id);
  RETURN public.mark_automation_noise(
    v_ids, 'command_not_confirmed', 'G_sem_prova', _run_id,
    jsonb_build_object('rule','result fail/timeout/pending sem state_confirmed=true',
                       'preserved','user_id, user_email, command_id e details permanecem na linha'),
    'cleanup_unconfirmed_commands');
END; $$;

-- ── 3.C) DUPLICIDADES (baseline 30) ─────────────────────────────────────────
-- Só marca a SEGUNDA de duas linhas consecutivas com o MESMO estado alvo no
-- mesmo equipamento. Nunca elimina atuação local real só por ser rápida:
-- se houver telemetria física com estado DIFERENTE entre as duas, houve
-- transição intermediária e as duas linhas são legítimas.
CREATE OR REPLACE FUNCTION public.cleanup_duplicate_transitions(_run_id uuid, _farm_id uuid DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids uuid[];
BEGIN
  WITH seq AS (
    SELECT c.id, c.equipment_id, c.occurred_at, c.target_state,
           lag(c.target_state) OVER w AS prev_state,
           lag(c.occurred_at)  OVER w AS prev_at
      FROM public.automation_row_classified c
     WHERE c.equipment_id IS NOT NULL
       AND c.action IN ('turn_on','turn_off','pump_on','pump_off')
       AND (_farm_id IS NULL OR c.farm_id = _farm_id)
    WINDOW w AS (PARTITION BY c.equipment_id ORDER BY c.occurred_at, c.created_at, c.id)
  )
  SELECT array_agg(s.id) INTO v_ids
    FROM seq s
   WHERE s.prev_state IS NOT NULL
     AND s.target_state = s.prev_state
     -- não houve transição física intermediária comprovada entre as duas
     AND NOT EXISTS (
       SELECT 1 FROM public.agent_technical_events t
        WHERE t.equipment_id = s.equipment_id
          AND t.occurred_at > s.prev_at AND t.occurred_at < s.occurred_at
          AND t.details->>'state' IS NOT NULL
          AND (t.details->>'state')::int <> s.target_state);

  RETURN public.mark_automation_noise(
    v_ids, 'duplicate_same_target_state', 'DUP', _run_id,
    jsonb_build_object('rule','2ª linha consecutiva com o mesmo estado alvo, sem transição física intermediária'),
    'cleanup_duplicate_transitions');
END; $$;

-- ── 4) DESFAZER UM RUN INTEIRO ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rollback_cleanup_run(_run_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int;
BEGIN
  UPDATE public.automation_log al
     SET noise_reason = (a.before_value->>'noise_reason')
    FROM public.automation_cleanup_audit a
   WHERE a.run_id = _run_id AND a.action = 'noise_marked' AND al.id = a.event_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  INSERT INTO public.automation_cleanup_audit
    (run_id, event_id, farm_id, equipment_id, phase_a_category, action,
     before_value, after_value, reason, executed_by)
  SELECT _run_id, a.event_id, a.farm_id, a.equipment_id, a.phase_a_category, 'restored',
         a.after_value, a.before_value, 'rollback do run', 'rollback_cleanup_run'
    FROM public.automation_cleanup_audit a
   WHERE a.run_id = _run_id AND a.action = 'noise_marked';
  RETURN v_n;
END; $$;

-- ── 5) EXECUÇÃO DA LIMPEZA (um run, tudo ou nada) ───────────────────────────
CREATE OR REPLACE FUNCTION public.run_phase_b_cleanup(_farm_id uuid DEFAULT NULL)
RETURNS TABLE (run_id uuid, tecnicos int, nao_confirmados int, duplicidades int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run uuid := gen_random_uuid(); a int; b int; c int;
BEGIN
  a := public.cleanup_technical_events(v_run, _farm_id);
  b := public.cleanup_unconfirmed_commands(v_run, _farm_id);
  c := public.cleanup_duplicate_transitions(v_run, _farm_id);
  RETURN QUERY SELECT v_run, a, b, c;
END; $$;
GRANT EXECUTE ON FUNCTION public.run_phase_b_cleanup(uuid) TO service_role;

-- ============================================================================
-- USO
--   SELECT * FROM public.run_phase_b_cleanup();          -- todas as fazendas
--   SELECT * FROM public.run_phase_b_cleanup('<farm>');  -- uma fazenda
--   SELECT * FROM public.automation_cleanup_audit WHERE run_id = '<run>';
--   SELECT public.rollback_cleanup_run('<run>');         -- desfaz o run
-- ============================================================================
