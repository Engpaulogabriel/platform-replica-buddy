-- ============================================================================
-- DIAGNÓSTICO DE LATÊNCIA DE COMUNICAÇÃO — SOMENTE LEITURA.
-- ----------------------------------------------------------------------------
-- Nada aqui altera dado, comando, relé ou estado de bomba.
-- Substitua :farm pelo uuid da fazenda antes de rodar.
-- ============================================================================
-- \set farm '00000000-0000-0000-0000-000000000000'

-- ── 1) PANORAMA POR EQUIPAMENTO ─────────────────────────────────────────────
-- Idade da leitura, endereço/rádio, e contadores de comando na última hora.
WITH eq AS (
  SELECT e.id, e.name, e.hw_id,
         COALESCE(NULLIF(pg.hw_id,''), substring(e.hw_id from 1 for 4)) AS tsnn,
         e.rf_radio, e.rf_via_rep, e.last_communication, e.last_polling_at,
         e.last_outputs_state, e.updated_at
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
   WHERE e.farm_id = :'farm' AND e.active = true
), cmd1h AS (
  SELECT c.equipment_id,
         count(*) FILTER (WHERE c.type='polling')                        AS polls_1h,
         count(*) FILTER (WHERE c.status='timeout')                      AS timeouts_1h,
         count(*) FILTER (WHERE c.status='error')                        AS erros_1h,
         count(*) FILTER (WHERE c.type='manual')                         AS manuais_1h,
         max(c.sent_at)                                                  AS ultimo_tx,
         max(c.responded_at)                                             AS ultimo_rx
    FROM public.commands c
   WHERE c.farm_id = :'farm' AND c.created_at > now() - interval '1 hour'
   GROUP BY c.equipment_id
)
SELECT
  eq.name                                   AS equipamento,
  eq.tsnn                                   AS endereco_plc,
  eq.rf_radio                               AS radio,
  eq.rf_via_rep                             AS via_repetidora,
  to_char(eq.last_communication AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI:SS') AS ultima_leitura_brt,
  ROUND(EXTRACT(EPOCH FROM (now() - eq.last_communication))/60.0, 1)     AS idade_leitura_min,
  to_char(c.ultimo_tx AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS')     AS ultimo_tx_brt,
  to_char(c.ultimo_rx AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS')     AS ultimo_rx_brt,
  COALESCE(c.polls_1h,0)                    AS tentativas_1h,
  COALESCE(c.timeouts_1h,0)                 AS timeouts_1h,
  COALESCE(c.erros_1h,0)                    AS erros_1h,
  COALESCE(c.manuais_1h,0)                  AS manuais_1h,
  -- taxa de retorno: quanto do que saiu efetivamente voltou
  CASE WHEN COALESCE(c.polls_1h,0) = 0 THEN NULL
       ELSE ROUND(100.0 * (c.polls_1h - COALESCE(c.timeouts_1h,0)) / c.polls_1h, 1) END AS taxa_retorno_pct,
  CASE
    WHEN eq.last_communication IS NULL                                   THEN 'nunca comunicou'
    WHEN COALESCE(c.polls_1h,0) = 0                                      THEN 'NAO FOI POLADO na ultima hora (fila/agenda)'
    WHEN COALESCE(c.timeouts_1h,0) >= GREATEST(1, c.polls_1h * 0.5)      THEN 'TX sai, RX nao volta (uplink/retorno do PLC)'
    WHEN EXTRACT(EPOCH FROM (now()-eq.last_communication))/60.0 > 5      THEN 'polado, mas leitura velha (verificar bridge/serial)'
    ELSE 'saudavel'
  END                                       AS causa_provavel
FROM eq LEFT JOIN cmd1h c ON c.equipment_id = eq.id
ORDER BY idade_leitura_min DESC NULLS FIRST;

-- ── 2) DISTRIBUIÇÃO DA IDADE DE LEITURA (a fazenda inteira) ─────────────────
SELECT count(*)                                                          AS pocos,
       ROUND(MIN(EXTRACT(EPOCH FROM (now()-last_communication))/60.0),1) AS min_min,
       ROUND(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (now()-last_communication))/60.0)::numeric,1) AS mediana_min,
       ROUND(percentile_cont(0.95) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (now()-last_communication))/60.0)::numeric,1) AS p95_min,
       ROUND(MAX(EXTRACT(EPOCH FROM (now()-last_communication))/60.0),1) AS max_min
  FROM public.equipments
 WHERE farm_id = :'farm' AND active = true AND last_communication IS NOT NULL;

-- ── 3) INTERVALOS REAIS ENTRE LEITURAS (60 min) ────────────────────────────
-- Usa os comandos de polling respondidos como proxy do RX por equipamento.
WITH r AS (
  SELECT c.equipment_id, c.responded_at,
         lag(c.responded_at) OVER (PARTITION BY c.equipment_id ORDER BY c.responded_at) AS anterior
    FROM public.commands c
   WHERE c.farm_id = :'farm' AND c.type='polling' AND c.responded_at IS NOT NULL
     AND c.responded_at > now() - interval '60 minutes'
)
SELECT e.name AS equipamento,
       count(*)                                                              AS leituras_60min,
       ROUND(AVG(EXTRACT(EPOCH FROM (r.responded_at - r.anterior))),0)        AS intervalo_medio_s,
       ROUND(MAX(EXTRACT(EPOCH FROM (r.responded_at - r.anterior))),0)        AS maior_lacuna_s
  FROM r JOIN public.equipments e ON e.id = r.equipment_id
 WHERE r.anterior IS NOT NULL
 GROUP BY e.name ORDER BY maior_lacuna_s DESC;

-- ── 4) FILA DE POLLING AGORA (head-of-line blocking) ───────────────────────
-- A RPC enqueue_polling_for_due_equipments só enfileira UM PLC por vez e
-- devolve 0 enquanto existir QUALQUER polling pending/sent na fazenda.
-- Se aparecer linha aqui com idade alta, ela está segurando a fazenda inteira.
SELECT c.id, e.name AS equipamento, c.type::text, c.status::text,
       c.source_device,
       ROUND(EXTRACT(EPOCH FROM (now() - c.created_at)),0) AS idade_s,
       c.timeout_ms
  FROM public.commands c LEFT JOIN public.equipments e ON e.id = c.equipment_id
 WHERE c.farm_id = :'farm' AND c.status IN ('pending','sent')
 ORDER BY c.created_at;

-- ── 5) COMANDO MANUAL PENDENTE — bloqueia TODO o polling ───────────────────
-- tickEnqueuePolling (main.cjs:7513-7520) retorna cedo se houver QUALQUER
-- manual 'pending' na fazenda. Um manual preso para o polling inteiro.
SELECT c.id, e.name AS equipamento, c.status::text, c.source_device, c.created_by,
       ROUND(EXTRACT(EPOCH FROM (now() - c.created_at)),0) AS preso_ha_s
  FROM public.commands c LEFT JOIN public.equipments e ON e.id = c.equipment_id
 WHERE c.farm_id = :'farm' AND c.type='manual' AND c.status='pending'
 ORDER BY c.created_at;

-- ── 6) COMPARAÇÃO POR RÁDIO/CANAL — rota ou endereço? ──────────────────────
-- Se TODOS do mesmo rádio degradam junto, é rota/canal/repetidora.
-- Se só um endereço degrada, é o PLC/antena daquele poço.
SELECT COALESCE(e.rf_radio,'(sem rádio)') AS radio,
       COALESCE(e.rf_via_rep,false)       AS via_repetidora,
       count(*)                           AS pocos,
       ROUND(AVG(EXTRACT(EPOCH FROM (now()-e.last_communication))/60.0),1) AS idade_media_min,
       ROUND(MAX(EXTRACT(EPOCH FROM (now()-e.last_communication))/60.0),1) AS idade_max_min,
       string_agg(e.name || ' (' ||
         ROUND(EXTRACT(EPOCH FROM (now()-e.last_communication))/60.0,1) || 'min)', ', '
         ORDER BY e.last_communication) AS detalhe
  FROM public.equipments e
 WHERE e.farm_id = :'farm' AND e.active = true
 GROUP BY 1,2 ORDER BY idade_media_min DESC;

-- ── 7) AGENTE / BRIDGE / INTERNET VIVOS? ───────────────────────────────────
SELECT sh.agent_status, sh.com_connected AS bridge_pronta, sh.com_port,
       sh.last_error, sh.agent_version,
       to_char(sh.last_heartbeat AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI:SS') AS ultimo_heartbeat_brt,
       ROUND(EXTRACT(EPOCH FROM (now() - sh.last_heartbeat)),0) AS heartbeat_idade_s,
       CASE
         WHEN now() - sh.last_heartbeat > interval '5 minutes' THEN 'AGENTE/INTERNET fora'
         WHEN sh.com_connected = false THEN 'BRIDGE morta (agente vivo)'
         WHEN sh.last_error IS NOT NULL THEN 'agente vivo, com erro: ' || sh.last_error
         ELSE 'agente e bridge vivos'
       END AS leitura
  FROM public.site_health sh WHERE sh.farm_id = :'farm';

-- ── 8) REINÍCIOS DE AGENTE/BRIDGE NA ÚLTIMA HORA ───────────────────────────
SELECT to_char(al.created_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS brt,
       al.level, al.category, left(al.message, 160) AS mensagem
  FROM public.agent_logs al
 WHERE al.farm_id = :'farm' AND al.created_at > now() - interval '1 hour'
   AND (al.message ILIKE '%watchdog%' OR al.message ILIKE '%bridge%'
        OR al.message ILIKE '%reinic%' OR al.message ILIKE '%ciclo completo%'
        OR al.message ILIKE '%safety%' OR al.message ILIKE '%sem resposta%')
 ORDER BY al.created_at DESC LIMIT 100;

-- ── 9) TEMPO DE CICLO REAL (log do próprio agente) ─────────────────────────
-- O agente loga "[POLLING] Ciclo completo em Ns" a cada rodada (main.cjs:7537).
-- É a medida direta de quanto demora para voltar ao mesmo poço.
SELECT to_char(al.created_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS brt,
       al.message
  FROM public.agent_logs al
 WHERE al.farm_id = :'farm' AND al.message LIKE '%Ciclo completo%'
   AND al.created_at > now() - interval '2 hours'
 ORDER BY al.created_at DESC LIMIT 40;
