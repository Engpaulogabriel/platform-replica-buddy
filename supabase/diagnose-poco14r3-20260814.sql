-- ============================================================================
-- DIAGNÓSTICO — POÇO 14 R3 · Fazenda Semear · 14/08/2026 06:49:00–06:51:59 BRT
-- ----------------------------------------------------------------------------
-- SOMENTE LEITURA. Nada é classificado como ruído e nada é alterado.
-- Objetivo: ver a evidência com SEGUNDOS antes de decidir se o Ligada/Desligada
-- no mesmo minuto foi mudança física real e rápida ou duplicidade.
-- ============================================================================

-- ── 0) Identificação do equipamento (confira o id antes de seguir) ──────────
SELECT id, name, farm_id, last_actuation_origin, last_changed_by, last_confirmed_state
  FROM public.equipments
 WHERE farm_id = '0b1d53df-6d5c-4674-8517-9299aac3ec18'
   AND name ILIKE '%14%R3%';

-- ── 1) automation_log — TUDO na janela, inclusive o marcado como ruído ──────
SELECT
  al.id,
  to_char(al.occurred_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS.MS') AS ocorrido_brt,
  to_char(al.created_at  AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS.MS')            AS gravado_brt,
  al.action::text  AS acao,
  al.origin::text  AS origem,
  al.result::text  AS resultado,
  al.actor_label   AS ator,
  al.user_id, al.user_email,
  al.new_state, al.source_device,
  al.noise_reason,
  al.details->>'origin'               AS origem_declarada_agente,
  al.details->>'confirmation_method'  AS confirmation_method,
  al.details->>'authorship_source'    AS autoria_fonte,
  al.details->>'command_id'           AS command_id,
  al.details                          AS details_completo
FROM public.automation_log al
JOIN public.equipments e ON e.id = al.equipment_id
WHERE e.farm_id = '0b1d53df-6d5c-4674-8517-9299aac3ec18'
  AND e.name ILIKE '%14%R3%'
  AND al.occurred_at >= (TIMESTAMP '2026-08-14 06:49:00' AT TIME ZONE 'America/Sao_Paulo')
  AND al.occurred_at <= (TIMESTAMP '2026-08-14 06:51:59' AT TIME ZONE 'America/Sao_Paulo')
ORDER BY al.occurred_at, al.created_at;

-- ── 2) equipment_state_events (fonte canônica, se já existir na base) ───────
-- Se a tabela ainda não existir, esta consulta falha — ignore e siga.
SELECT
  ese.id,
  to_char(ese.occurred_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS.MS') AS ocorrido_brt,
  ese.previous_running AS estado_anterior,
  ese.current_running  AS estado_novo,
  ese.origin::text     AS origem,
  ese.actor_label      AS ator,
  ese.confirmation_method,
  ese.rx_source,
  ese.plc_tsnn,
  ese.raw_frame        AS evidencia_frame,
  ese.details
FROM public.equipment_state_events ese
JOIN public.equipments e ON e.id = ese.equipment_id
WHERE e.farm_id = '0b1d53df-6d5c-4674-8517-9299aac3ec18'
  AND e.name ILIKE '%14%R3%'
  AND ese.occurred_at >= (TIMESTAMP '2026-08-14 06:49:00' AT TIME ZONE 'America/Sao_Paulo')
  AND ese.occurred_at <= (TIMESTAMP '2026-08-14 06:51:59' AT TIME ZONE 'America/Sao_Paulo')
ORDER BY ese.occurred_at;

-- ── 3) Telemetria bruta (amostras do piloto canônico, se existirem) ─────────
SELECT
  to_char(ets.occurred_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS.MS') AS rx_agente_brt,
  to_char(ets.received_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS.MS') AS recebido_servidor_brt,
  ets.decoded_bit, ets.rx_source::text, ets.plc_tsnn, ets.plc_saida,
  ets.raw_frame, ets.payload, ets.inflight_kind, ets.agent_boot_id, ets.seq
FROM public.equipment_telemetry_samples ets
JOIN public.equipments e ON e.id = ets.equipment_id
WHERE e.farm_id = '0b1d53df-6d5c-4674-8517-9299aac3ec18'
  AND e.name ILIKE '%14%R3%'
  AND ets.occurred_at >= (TIMESTAMP '2026-08-14 06:49:00' AT TIME ZONE 'America/Sao_Paulo')
  AND ets.occurred_at <= (TIMESTAMP '2026-08-14 06:51:59' AT TIME ZONE 'America/Sao_Paulo')
ORDER BY ets.occurred_at, ets.seq;

-- ── 4) Comandos na janela ESTENDIDA (±10 min) — pendentes e próximos ───────
SELECT
  c.id,
  to_char(COALESCE(c.sent_at, c.created_at) AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS enviado_brt,
  to_char(c.responded_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS')                    AS respondido_brt,
  c.type::text AS tipo, c.status::text AS status, c.frame, c.source_device, c.created_by
FROM public.commands c
JOIN public.equipments e ON e.id = c.equipment_id
WHERE e.farm_id = '0b1d53df-6d5c-4674-8517-9299aac3ec18'
  AND e.name ILIKE '%14%R3%'
  AND COALESCE(c.sent_at, c.created_at) >= (TIMESTAMP '2026-08-14 06:39:00' AT TIME ZONE 'America/Sao_Paulo')
  AND COALESCE(c.sent_at, c.created_at) <= (TIMESTAMP '2026-08-14 07:01:59' AT TIME ZONE 'America/Sao_Paulo')
ORDER BY COALESCE(c.sent_at, c.created_at);

-- ── 5) Mesma janela em command_audit (autoria durável, se já aplicada) ──────
SELECT ca.command_id,
       to_char(ca.command_created_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS criado_brt,
       ca.intent, ca.origin_kind, ca.user_id, ca.user_email, ca.actor_label, ca.status_final
FROM public.command_audit ca
JOIN public.equipments e ON e.id = ca.equipment_id
WHERE e.farm_id = '0b1d53df-6d5c-4674-8517-9299aac3ec18'
  AND e.name ILIKE '%14%R3%'
  AND ca.command_created_at >= (TIMESTAMP '2026-08-14 06:39:00' AT TIME ZONE 'America/Sao_Paulo')
  AND ca.command_created_at <= (TIMESTAMP '2026-08-14 07:01:59' AT TIME ZONE 'America/Sao_Paulo')
ORDER BY ca.command_created_at;

-- ── 6) Diagnóstico técnico registrado na janela ─────────────────────────────
SELECT to_char(ate.occurred_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS brt,
       ate.kind, ate.details
FROM public.agent_technical_events ate
WHERE ate.farm_id = '0b1d53df-6d5c-4674-8517-9299aac3ec18'
  AND ate.occurred_at >= (TIMESTAMP '2026-08-14 06:49:00' AT TIME ZONE 'America/Sao_Paulo')
  AND ate.occurred_at <= (TIMESTAMP '2026-08-14 06:51:59' AT TIME ZONE 'America/Sao_Paulo')
ORDER BY ate.occurred_at;

-- ============================================================================
-- COMO LER (sem concluir por suposição):
--  • Se (1) mostrar dois eventos com SEGUNDOS distintos e (3) trouxer dois RX
--    com decoded_bit alternando (1 depois 0) e rx_source='spontaneous_tx',
--    é ATUAÇÃO LOCAL REAL rápida — os dois devem permanecer no relatório.
--  • Se os dois eventos tiverem o MESMO segundo, ou (3) mostrar rx_source de
--    poll/eco/retry, é DUPLICIDADE — mas nada deve ser marcado antes de você ver.
--  • `gravado_brt` muito depois de `ocorrido_brt` indica telemetria atrasada,
--    o que muda a leitura da ordem dos eventos.
-- ============================================================================
