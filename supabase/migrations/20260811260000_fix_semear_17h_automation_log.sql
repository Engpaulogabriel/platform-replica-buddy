-- Correção DEFINITIVA da atribuição do desligamento 17h Semear (11/08/2026).
-- ─────────────────────────────────────────────────────────────────────────────
-- O Relatório de Automação lê a tabela public.automation_log (ver
-- src/lib/automationLog.ts: loadAutomationLogRange). Mapeamento no frontend:
--   • Origem exibida vem de automation_log.origin (enum event_origin):
--       'auto'  → "Automático"/"Automação"   'local' → "Manual"/"Local"
--       'system'→ "Sistema"
--   • Usuário exibido vem de automation_log.actor_label (prioridade em resolveUser).
--   • Data/Hora vêm de automation_log.occurred_at (rowToEntry usa occurred_at).
--
-- POR QUE OS BACKFILLS ANTERIORES NÃO PEGARAM:
--   • usavam EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Bahia') = 17,
--     o que IGNORA as linhas de 16:59 BRT (hora=16); e filtravam por created_at
--     enquanto o relatório exibe por occurred_at.
--
-- Correção: janela precisa 16:59–17:06 BRT = 19:59–20:06 UTC sobre
-- COALESCE(occurred_at, created_at). Reatribui origin='auto' + actor_label.
UPDATE public.automation_log
   SET origin = 'auto'::public.event_origin,
       actor_label = 'Desligamento 17h Semear'
 WHERE farm_id IN (SELECT id FROM public.farms WHERE name ILIKE '%semear%')
   AND COALESCE(occurred_at, created_at) >= TIMESTAMPTZ '2026-08-11 19:59:00+00'
   AND COALESCE(occurred_at, created_at) <= TIMESTAMPTZ '2026-08-11 20:06:00+00'
   AND action IN ('pump_off'::public.event_action, 'turn_off'::public.event_action)
   AND origin IN ('local'::public.event_origin, 'system'::public.event_origin);
