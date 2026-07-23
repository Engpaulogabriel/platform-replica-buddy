---
name: Automation Guard
description: Bomba que desliga fora do horário programado tem o automático desativado na nuvem; badge AUTO vira alerta clicável que reativa. Tudo em automation_guards.
type: feature
---
Quando uma bomba está em modo Automático e estava ligada, mas passa para desligada SEM que o motor da nuvem (`run_automation_tick`) tenha disparado um comando de "off" no horário programado (janela de 3 minutos consultando `automation_fired` por `|off@HH:MM`), o sistema dispara o `automationGuard`:

- Desativa todas as programações ativas daquele equipmentId em `automation_schedules` (nuvem).
- Persiste o evento em `automation_guards` (nuvem) com `silenced_schedule_ids` para permitir rollback.
- O badge AUTO no `PumpTable` muda de info (Bot icon) para destructive pulsante (AlertTriangle) com tooltip explicando.
- Clique no badge alerta chama `clearAutomationGuard(farmId, equipmentId)` que reativa todas as programações silenciadas e apaga o registro.

Não dispara quando: bomba está em `pending` (ligando/desligando), está `offline`, ou nunca esteve em `running:true` durante a sessão.

Detecção fica no `Dashboard.tsx` via `useRef<Map<id, boolean>>` que guarda o `running` anterior por equipamento. Hook `useAutomationGuards` expõe Set reativo (Realtime na tabela `automation_guards`) dos equipamentos com guard ativo. Tabela tem RLS por farm + Realtime habilitado.
