---
name: Critical Bell Alerts
description: Alertas no sino (farm_notifications) gerados 24/7 na nuvem. Toggle por fazenda em farms.bell_alerts_enabled. kind=failure|system separa as abas.
type: feature
---
Sino reativado em junho/2026 com toggle por fazenda (`farms.bell_alerts_enabled` — default false). O `NotificationContext` lê esse boolean por farm + Realtime; quando false o sino aparece em cinza (BellOff) e nenhuma carga/subscribe é feito. UI: `NotificationCenter` 100% baseado em `farm_notifications`, abas filtradas por `kind` (failure | system). Resolved (`resolved_at`) renderiza com opacity reduzida + label "resolvido".

Tabela `farm_notifications` ganhou colunas: `kind` ('failure'|'system' default 'failure'), `equipment_id` (FK equipments), `resolved_at`. Index `(farm_id, kind, created_at DESC)`.

Edge `critical-alerts-tick` (pg_cron a cada 1 min, CRON_SECRET) gera:
- **failure #1 equipamento_offline**: `last_communication > 15 min`. Dedup por (farm_id, source, source_ref=equipment_id). Quando volta online: marca `resolved_at` e DELETA para permitir re-disparo.
- **failure #5 automatico_nao_obedecido**: automation_log automático success em 60–180s atrás cujo `last_outputs_state[saida]` ≠ esperado. source_ref = automation_log.id.
- **failure #6 falta_energia**: ≥4 equipamentos da MESMA farm cujo last_communication caiu numa janela de 60s. Cooldown de 5 min por farm.
- **failure #7 safety_timer_fired**: agent_logs com `message ILIKE %safety_timer%` nos últimos 5 min. source_ref = agent_logs.id.
- **system #8 peak_hour_start / peak_hour_end**: dispara 1x/dia/fazenda quando hora America/Sao_Paulo == 18 ou 21. source_ref = UUID determinístico SHA-256(source:farm:date).
- **system #9 ota_applied**: agent_update_history com status='success' nos últimos 5 min. source_ref = agent_update_history.id.

Histórico completo: aba "Histórico do Sino" em `/alarmes` (componente `BellHistoryPanel`), com filtros por tipo, período (24h/7d/30d/90d) e busca textual.

Toggle por fazenda: card "Módulos opcionais" em `/platform` → Controle Remoto, item separado do bloco modules JSON (vai direto em `farms.bell_alerts_enabled`).
