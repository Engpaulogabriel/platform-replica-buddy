---
name: Offline thresholds (UI vs Relatório)
description: Duas camadas distintas — relatório de comunicação registra desde a 1ª falha, badge OFFLINE da UI só após 15 min
type: feature
---
Duas camadas independentes para "offline" de equipamento:

1. **Relatório de Comunicação** (agente Electron, `electron-agent/app/main.cjs`):
   - Grava `automation_log` com `action='status_read'` + `details.tipo_evento='equipamento_offline'` na **1ª falha consecutiva** de polling (`b.failures === 1`).
   - Grava `equipamento_online` ao voltar, com `tempo_total_offline_segundos = now - offlineSince` (instante da 1ª falha).
   - Coluna `equipments.communication_status='offline'` só vira na **3ª falha** consecutiva.
   - Propósito: dado completo para análise técnica/relatório.

2. **Badge OFFLINE da UI** (`src/hooks/useDashboardEquipment.ts`):
   - `ONLINE_WINDOW_MS = 15 * 60_000`.
   - Marca offline apenas após **15 min** sem `last_communication`.
   - Mesma regra usada na edge function `critical-alerts-tick` (notificação "Equipamento sem comunicação").
   - Propósito: evitar alarme falso para o operador em falhas curtas.

**Não unificar essas camadas.** São propositais. Se o cliente reportar "vi OFFLINE antes de 15 min", suspeitar de:
- Barra de sinal RF apagada (latência >8s no último comando — outro indicador).
- Popover de detalhes mostrando "última leitura há X min" (texto informativo, não badge).
- Bridge inativa / sem internet (badges separados).

A aba **Comunicação** vive em /suporte-tecnico (não mais em /relatorios).
