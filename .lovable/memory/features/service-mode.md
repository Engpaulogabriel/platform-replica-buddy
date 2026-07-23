---
name: Modo Serviço (/platform)
description: Aba admin-only no /platform para diagnóstico individual de PLCs via comando service_test.
type: feature
---
- Aba "Modo Serviço" em /platform, visível só para platform_admin.
- Insere `commands.type='service_test'` (enum estendido), priority=2, source_device='platform-service'. Não altera desired_running e não vira telemetria.
- Tabela `service_mode_locks(farm_id, tsnn, expires_at)` com PK composta. Lock de 5 min, refresh por heartbeat de 60s da UI; auto-release por inatividade.
- `enqueue_polling_for_due_equipments_internal` pula PLCs com lock ativo (NOT EXISTS service_mode_locks WHERE expires_at > now()).
- Agente Electron (electron-agent/main.cjs) trata `service_test` como round-trip puro: marca executed com response+error_message=`latency_ms=N`, sem safety timer e sem reforço.
- Frontend usa Realtime + fallback poll 2s na linha do command para preencher histórico (até 50 entradas em sessão). Frame TX em azul, RX em verde, timeout em vermelho.
