-- ============================================================================
-- SYKUE / POÇO 12 R6 — 14/08/2026, 14:53:00–15:00:00 BRT.
-- PARTE A é SOMENTE LEITURA. PARTE B está comentada e só roda depois que a
-- lista de IDs for congelada e a contagem conferir.
-- ============================================================================
-- \set farm '00000000-0000-0000-0000-000000000000'

-- ── PARTE A.1 — Tudo que existe na janela, com a classificação da Fase A ────
SELECT
  to_char(al.occurred_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS.MS') AS brt,
  al.id, al.action::text, al.origin::text, al.result::text,
  al.actor_label, al.user_email,
  al.noise_reason,
  public.automation_row_issue(al.id)          AS categoria_fase_a,
  al.details->>'confirmation_method'          AS metodo,
  al.details->>'state_confirmed'              AS confirmado,
  al.details->>'command_id'                   AS command_id
FROM public.automation_log al
JOIN public.equipments e ON e.id = al.equipment_id
WHERE e.name ILIKE '%12%R6%' AND al.farm_id = :'farm'
  AND al.occurred_at >= '2026-08-14 14:53:00-03'
  AND al.occurred_at <  '2026-08-14 15:00:00-03'
ORDER BY al.occurred_at;

-- ── PARTE A.2 — Qual é a evidência real de cada uma dessas linhas? ──────────
-- Não decide nada: só mostra o que resolve_event_authorship enxerga.
SELECT
  to_char(al.occurred_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS brt,
  al.id, al.origin::text AS origem_hoje, al.actor_label AS ator_hoje,
  ev.origin_final AS origem_provada, ev.actor_label AS pessoa_provada,
  ev.evidence_source, ev.confidence, ev.evidence
FROM public.automation_log al
JOIN public.equipments e ON e.id = al.equipment_id
CROSS JOIN LATERAL public.resolve_event_authorship(al.id) ev
WHERE e.name ILIKE '%12%R6%' AND al.farm_id = :'farm'
  AND al.occurred_at >= '2026-08-14 14:53:00-03'
  AND al.occurred_at <  '2026-08-14 15:00:00-03'
ORDER BY al.occurred_at;

-- ── PARTE A.3 — Comandos da janela (a prova, se existir) ────────────────────
SELECT ca.command_id, ca.intent, ca.user_email, ca.actor_label, ca.status_final,
       to_char(ca.command_created_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS criado_brt,
       to_char(ca.responded_at      AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS respondido_brt
  FROM public.command_audit ca
  JOIN public.equipments e ON e.id = ca.equipment_id
 WHERE e.name ILIKE '%12%R6%' AND ca.farm_id = :'farm'
   AND ca.command_created_at >= '2026-08-14 14:50:00-03'
   AND ca.command_created_at <  '2026-08-14 15:03:00-03'
 ORDER BY ca.command_created_at;

-- ── PARTE A.4 — Contagem para a TRAVA ───────────────────────────────────────
SELECT count(*) FILTER (WHERE public.automation_row_issue(al.id) <> 'OK') AS a_corrigir,
       count(*)                                                          AS total_janela
  FROM public.automation_log al
  JOIN public.equipments e ON e.id = al.equipment_id
 WHERE e.name ILIKE '%12%R6%' AND al.farm_id = :'farm'
   AND al.occurred_at >= '2026-08-14 14:53:00-03'
   AND al.occurred_at <  '2026-08-14 15:00:00-03'
   AND al.noise_reason IS NULL;

-- ============================================================================
-- PARTE B — CORREÇÃO. Descomente SOMENTE depois de conferir A.1–A.4.
-- Não reclassifica Local verdadeiro: `finalize_origin_and_authorship` só muda
-- para 'remote' quando há command_audit/commands correlacionado. Linha sem
-- prova sai do oficial e vai para a fila administrativa — nunca vira texto
-- genérico e nunca ganha pessoa inventada.
-- ============================================================================
-- DO $$
-- DECLARE v_ids uuid[]; v_run uuid := gen_random_uuid(); v_esperado int := 0;  -- ← preencha
-- BEGIN
--   SELECT array_agg(al.id) INTO v_ids
--     FROM public.automation_log al
--     JOIN public.equipments e ON e.id = al.equipment_id
--    WHERE e.name ILIKE '%12%R6%'
--      AND al.occurred_at >= '2026-08-14 14:53:00-03'
--      AND al.occurred_at <  '2026-08-14 15:00:00-03'
--      AND al.noise_reason IS NULL
--      AND public.automation_row_issue(al.id) <> 'OK';
--
--   IF COALESCE(array_length(v_ids,1),0) <> v_esperado THEN
--     RAISE EXCEPTION 'TRAVA: esperado % linhas, encontrado % — nada foi alterado',
--       v_esperado, COALESCE(array_length(v_ids,1),0);
--   END IF;
--
--   PERFORM public.finalize_origin_and_authorship(v_run, (SELECT farm_id FROM public.equipments e2
--            WHERE e2.name ILIKE '%12%R6%' LIMIT 1));
--   RAISE NOTICE 'run_id = % (rollback: SELECT public.rollback_cleanup_run(''%''))', v_run, v_run;
-- END $$;
-- ============================================================================
