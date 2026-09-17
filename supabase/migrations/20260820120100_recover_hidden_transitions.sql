-- ============================================================================
-- RECUPERAÇÃO DO HISTÓRICO — TODAS as fazendas. Idempotente e reversível.
-- ----------------------------------------------------------------------------
-- Devolve ao relatório oficial as transições físicas REAIS que foram escondidas
-- por `pending_authorship_review`, `origin=system` ou rótulo técnico.
--
-- NUNCA inventa nome humano. Sem prova de pessoa, a linha volta como Local
-- (que é o que uma transição física sem comando de fato é) — jamais como texto
-- genérico, e jamais permanece escondida.
--
-- Cada alteração vai para automation_cleanup_audit: antes, depois, evidência,
-- executor e horário.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.automation_cleanup_audit (
  id bigserial PRIMARY KEY, run_id uuid NOT NULL, event_id uuid NOT NULL,
  farm_id uuid, equipment_id uuid, phase_a_category text NOT NULL,
  action text NOT NULL, before_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb, evidence_source text,
  confidence text, reason text NOT NULL, executed_by text NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.automation_cleanup_audit ENABLE ROW LEVEL SECURITY;

-- ── Inventário read-only: o que está escondido e por quê ───────────────────
CREATE OR REPLACE FUNCTION public.hidden_physical_transitions(_hours int DEFAULT 1440)
RETURNS TABLE (fazenda text, motivo text, origem text, linhas bigint,
               com_command_audit bigint, sem_prova bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.name, al.noise_reason, al.origin::text, count(*),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.command_audit ca
            WHERE ca.equipment_id = al.equipment_id AND ca.user_id IS NOT NULL
              AND ca.command_created_at BETWEEN al.occurred_at - interval '3 minutes'
                                            AND al.occurred_at + interval '3 minutes')),
         count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM public.command_audit ca
            WHERE ca.equipment_id = al.equipment_id AND ca.user_id IS NOT NULL
              AND ca.command_created_at BETWEEN al.occurred_at - interval '3 minutes'
                                            AND al.occurred_at + interval '3 minutes'))
    FROM public.automation_log al JOIN public.farms f ON f.id = al.farm_id
   WHERE al.noise_reason IS NOT NULL
     AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND al.result = 'success'::public.event_result
     AND al.occurred_at > now() - make_interval(hours => _hours)
   GROUP BY 1,2,3 ORDER BY 4 DESC;
$$;
GRANT EXECUTE ON FUNCTION public.hidden_physical_transitions(int) TO authenticated, service_role;

-- ── A recuperação ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recover_hidden_transitions(
  _hours int DEFAULT 1440, _farm_id uuid DEFAULT NULL)
RETURNS TABLE (run_id uuid, recuperados int, remoto int, whatsapp int,
               automacao int, local_real int, mantidos_privados int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run uuid := gen_random_uuid(); r record; c record;
        n int := 0; nr int := 0; nw int := 0; na int := 0; nl int := 0; np int := 0;
        v_tem_evidencia_remota boolean;
BEGIN
  FOR r IN
    SELECT al.* FROM public.automation_log al
     WHERE al.noise_reason IN ('pending_authorship_review','no_authorship','system_origin')
       AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
       AND al.result = 'success'::public.event_result
       AND al.occurred_at > now() - make_interval(hours => _hours)
       AND (_farm_id IS NULL OR al.farm_id = _farm_id)
  LOOP
    -- mesma ordem do writer: automação → comando → local
    SELECT * INTO c FROM public.classify_physical_transition(
      r.equipment_id, r.farm_id,
      r.action IN ('turn_on','pump_on'), r.occurred_at);

    -- ── TRAVA: evidência de REMOTO sem pessoa recuperável ──────────────────
    -- Ausência de autoria não é prova de atuação local. Se a linha carrega
    -- marca de comando remoto (details.origin remote-cmd/remote-desired,
    -- command_id, command_pending) e a classificação não achou pessoa, ela
    -- PERMANECE fora do relatório oficial, só na auditoria técnica privada.
    -- Nunca inventamos pessoa e nunca a convertemos em Local.
    v_tem_evidencia_remota := (
         COALESCE(r.details->>'origin','')      IN ('remote-cmd','remote-desired','remote')
      OR COALESCE(r.details->>'command_id','')  <> ''
      OR COALESCE(r.details->>'command_pending','') IN ('true','t')
      OR r.origin = 'remote'::public.event_origin
      OR EXISTS (SELECT 1 FROM public.commands cmd
                  WHERE cmd.equipment_id = r.equipment_id
                    AND cmd.type = 'manual'::public.command_type
                    AND cmd.created_at BETWEEN r.occurred_at - interval '3 minutes'
                                           AND r.occurred_at + interval '3 minutes'));

    IF c.origin = 'local'::public.event_origin AND v_tem_evidencia_remota THEN
      INSERT INTO public.automation_cleanup_audit
        (run_id, event_id, farm_id, equipment_id, phase_a_category, action,
         before_value, after_value, evidence_source, confidence, reason, executed_by)
      VALUES (v_run, r.id, r.farm_id, r.equipment_id, 'REMOTE_NO_PERSON', 'kept_technical_only',
        jsonb_build_object('origin', r.origin::text, 'actor_label', r.actor_label,
                           'noise_reason', r.noise_reason),
        jsonb_build_object('kept_out_of_official', true),
        'none', 'none',
        'evidência de remoto sem pessoa recuperável — mantido só na auditoria técnica',
        'recover_hidden_transitions');
      np := np + 1;
      CONTINUE;                       -- não altera a linha; segue escondida
    END IF;

    INSERT INTO public.automation_cleanup_audit
      (run_id, event_id, farm_id, equipment_id, phase_a_category, action,
       before_value, after_value, evidence_source, confidence, reason, executed_by)
    VALUES (v_run, r.id, r.farm_id, r.equipment_id, 'HIDDEN_PHYSICAL', 'recovered',
      jsonb_build_object('origin', r.origin::text, 'actor_label', r.actor_label,
                         'user_id', r.user_id, 'noise_reason', r.noise_reason),
      jsonb_build_object('origin', c.origin::text, 'actor_label', c.actor_label,
                         'user_id', c.user_id, 'noise_reason', NULL),
      c.authorship_source, 'evidencia',
      'transição física real estava escondida do relatório oficial',
      'recover_hidden_transitions');

    UPDATE public.automation_log al
       SET origin = c.origin, actor_label = c.actor_label,
           user_id = c.user_id, user_email = c.user_email,
           noise_reason = NULL,
           details = COALESCE(al.details,'{}'::jsonb) || jsonb_build_object(
                       'authorship_source', c.authorship_source,
                       'command_id', c.command_id,
                       'recovered_run', v_run)
     WHERE al.id = r.id;

    n := n + 1;
    IF    c.origin = 'remote'::public.event_origin   THEN nr := nr + 1;
    ELSIF c.origin = 'whatsapp'::public.event_origin THEN nw := nw + 1;
    ELSIF c.origin = 'auto'::public.event_origin     THEN na := na + 1;
    ELSE  nl := nl + 1; END IF;
  END LOOP;

  RETURN QUERY SELECT v_run, n, nr, nw, na, nl, np;
END; $$;
GRANT EXECUTE ON FUNCTION public.recover_hidden_transitions(int, uuid) TO service_role;

-- ── Antes/depois por fazenda e origem ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.report_origin_breakdown(_hours int DEFAULT 1440)
RETURNS TABLE (fazenda text, origem text, oficial bigint, escondido bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.name, al.origin::text,
         count(*) FILTER (WHERE al.noise_reason IS NULL),
         count(*) FILTER (WHERE al.noise_reason IS NOT NULL)
    FROM public.automation_log al JOIN public.farms f ON f.id = al.farm_id
   WHERE al.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND al.result = 'success'::public.event_result
     AND al.occurred_at > now() - make_interval(hours => _hours)
   GROUP BY 1,2 ORDER BY 1,2;
$$;
GRANT EXECUTE ON FUNCTION public.report_origin_breakdown(int) TO authenticated, service_role;

-- ── Desfazer um run ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rollback_recovery_run(_run_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE public.automation_log al
     SET origin = (a.before_value->>'origin')::public.event_origin,
         actor_label = a.before_value->>'actor_label',
         user_id = NULLIF(a.before_value->>'user_id','')::uuid,
         noise_reason = a.before_value->>'noise_reason'
    FROM public.automation_cleanup_audit a
   WHERE a.run_id = _run_id AND a.action = 'recovered' AND al.id = a.event_id;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END; $$;

-- ── O que ficará fora do oficial mesmo após a recuperação ─────────────────
CREATE OR REPLACE FUNCTION public.remote_without_person(_hours int DEFAULT 1440)
RETURNS TABLE (fazenda text, equipamento text, evento_id uuid, ocorrido timestamptz,
               acao text, evidencia text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.name, al.equipment_name, al.id, al.occurred_at, al.action::text,
         CASE WHEN COALESCE(al.details->>'command_id','') <> '' THEN 'command_id em details'
              WHEN COALESCE(al.details->>'origin','') IN ('remote-cmd','remote-desired','remote')
                   THEN 'details.origin=' || (al.details->>'origin')
              WHEN al.origin = 'remote'::public.event_origin THEN 'origin=remote'
              ELSE 'comando compatível na janela' END
    FROM public.automation_log al JOIN public.farms f ON f.id = al.farm_id
   WHERE al.noise_reason IS NOT NULL
     AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND al.result = 'success'::public.event_result
     AND al.occurred_at > now() - make_interval(hours => _hours)
     AND NOT EXISTS (SELECT 1 FROM public.command_audit ca
                      WHERE ca.equipment_id = al.equipment_id AND ca.user_id IS NOT NULL
                        AND ca.command_created_at BETWEEN al.occurred_at - interval '3 minutes'
                                                     AND al.occurred_at + interval '3 minutes')
     AND (COALESCE(al.details->>'origin','') IN ('remote-cmd','remote-desired','remote')
          OR COALESCE(al.details->>'command_id','') <> ''
          OR al.origin = 'remote'::public.event_origin)
   ORDER BY al.occurred_at DESC;
$$;
GRANT EXECUTE ON FUNCTION public.remote_without_person(int) TO authenticated, service_role;

-- ============================================================================
-- USO
--   SELECT * FROM public.hidden_physical_transitions(48);   -- inventário
--   SELECT * FROM public.report_origin_breakdown(48);       -- antes
--   SELECT * FROM public.recover_hidden_transitions(1440);  -- recupera tudo
--   SELECT * FROM public.report_origin_breakdown(48);       -- depois
--   SELECT public.rollback_recovery_run('<run_id>');        -- desfaz
-- ============================================================================
