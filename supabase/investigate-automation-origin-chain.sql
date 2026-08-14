-- ============================================================================
-- INVESTIGAÇÃO — cadeia de correlação da automação. SOMENTE LEITURA.
-- Nada aqui altera dado. Substitua :farm pelo uuid da Semear.
-- ============================================================================
-- \set farm '00000000-0000-0000-0000-000000000000'

-- ── 3) TODOS os equipamentos que receberam a ação da regra em 14/08 BRT ─────
-- A prova durável por equipamento é o COMANDO criado por
-- enqueue_reset_pump_command, cujo source_device carrega o motivo.
-- `targeted` NÃO entra aqui: ele é sobrescrito a cada tentativa.
SELECT
  e.id                                   AS equipment_id,
  e.name                                 AS equipamento,
  to_char(c.created_at AT TIME ZONE 'America/Bahia','DD/MM HH24:MI:SS') AS comando_brt,
  c.id                                   AS command_id,
  c.source_device,                        -- backend-reset:scheduled_shutdown_aN[_forced]
  substring(c.source_device from 'scheduled_shutdown_a([0-9]+)') AS tentativa,
  (c.source_device LIKE '%_forced')      AS foi_forcado,
  c.status::text                         AS status_comando,
  e.last_changed_by                      AS regra_gravada_no_equipamento,
  sa.id                                  AS automation_id,
  sa.name                                AS regra
FROM public.commands c
JOIN public.equipments e ON e.id = c.equipment_id
LEFT JOIN public.scheduled_automations sa
       ON sa.farm_id = c.farm_id AND sa.is_active
      AND btrim(sa.name) = btrim(COALESCE(e.last_changed_by,''))
WHERE c.farm_id = :'farm'
  AND c.source_device LIKE 'backend-reset:scheduled_shutdown%'
  AND (c.created_at AT TIME ZONE 'America/Bahia')::date = DATE '2026-08-14'
ORDER BY c.created_at, e.name;

-- ── 4) Estado atual desses equipamentos + evento físico correspondente ──────
WITH acionados AS (
  SELECT DISTINCT c.equipment_id, min(c.created_at) AS primeiro_comando
    FROM public.commands c
   WHERE c.farm_id = :'farm'
     AND c.source_device LIKE 'backend-reset:scheduled_shutdown%'
     AND (c.created_at AT TIME ZONE 'America/Bahia')::date = DATE '2026-08-14'
   GROUP BY c.equipment_id
)
SELECT
  e.name                                  AS equipamento,
  e.last_actuation_origin                 AS origem_no_dashboard,
  e.last_changed_by                        AS por,
  e.last_outputs_state                     AS estado_fisico,
  to_char(a.primeiro_comando AT TIME ZONE 'America/Bahia','HH24:MI:SS') AS comando_brt,
  to_char(al.occurred_at   AT TIME ZONE 'America/Bahia','HH24:MI:SS')   AS evento_brt,
  al.origin::text                          AS origem_no_relatorio,
  al.actor_label                           AS quem_o_relatorio_mostra,
  al.details->>'scheduled_shutdown'        AS marcado_como_automacao,
  al.details->>'via'                       AS caminho_da_correlacao
FROM acionados a
JOIN public.equipments e ON e.id = a.equipment_id
LEFT JOIN LATERAL (
  SELECT * FROM public.automation_log l
   WHERE l.equipment_id = a.equipment_id
     AND l.action IN ('turn_off','pump_off')
     AND l.occurred_at BETWEEN a.primeiro_comando - interval '2 minutes'
                           AND a.primeiro_comando + interval '30 minutes'
   ORDER BY l.occurred_at LIMIT 1) al ON true
ORDER BY e.name;

-- ── 2) Contraprova: o que `targeted` REALMENTE contém naquele dia ───────────
-- Deve vir MENOR que a lista da consulta 3 — é ele que está incompleto.
SELECT s.run_date, s.attempt, s.status,
       to_char(s.last_attempt_at AT TIME ZONE 'America/Bahia','HH24:MI:SS') AS ultima_tentativa,
       jsonb_array_length(COALESCE(s.targeted,'[]'::jsonb))  AS n_targeted,
       jsonb_array_length(COALESCE(s.remaining,'[]'::jsonb)) AS n_remaining,
       s.steps_done, s.targeted
  FROM public.scheduled_shutdowns s
 WHERE s.farm_id = :'farm' AND s.run_date = DATE '2026-08-14';

-- ── 5) A regra da JANELA (caminho B do Relatório), sem depender de comando ──
-- É este fallback que faz o Relatório acertar mesmo quando o comando expirou.
SELECT sa.id, sa.name, sa.time_brt, sa.days_of_week,
       sa.max_retries, sa.retry_interval_min,
       ((substring(sa.time_brt from '^([0-9]{1,2})')::int) * 60
        + (substring(sa.time_brt from ':([0-9]{2})')::int)) - 5           AS janela_inicio_min,
       ((substring(sa.time_brt from '^([0-9]{1,2})')::int) * 60
        + (substring(sa.time_brt from ':([0-9]{2})')::int))
        + (COALESCE(sa.max_retries,3) * COALESCE(sa.retry_interval_min,5)) + 5 AS janela_fim_min
  FROM public.scheduled_automations sa
 WHERE sa.farm_id = :'farm' AND sa.is_active;

-- ── Divergência: quem o Relatório diz Automação e o dashboard diz Local ─────
SELECT e.name, e.last_actuation_origin AS dashboard, al.origin::text AS relatorio,
       al.actor_label, to_char(al.occurred_at AT TIME ZONE 'America/Bahia','DD/MM HH24:MI') AS quando
  FROM public.automation_log al
  JOIN public.equipments e ON e.id = al.equipment_id
 WHERE al.farm_id = :'farm'
   AND al.origin = 'auto'::public.event_origin
   AND al.occurred_at > now() - interval '3 days'
   AND e.last_actuation_origin = 'local'
 ORDER BY al.occurred_at DESC;
