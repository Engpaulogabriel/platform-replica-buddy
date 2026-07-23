---
name: TSNN Shared Communication Status
description: Status de comunicação na UI é compartilhado por TSNN — equipamentos do mesmo plc_group_id usam MAX(last_communication) do grupo.
type: feature
---

## Regra
Dois equipamentos do mesmo PLC (ex.: Booster 01 e Booster 02 no TSNN 2302)
DEVEM mostrar o MESMO status de comunicação. Toda RX em qualquer saída prova
que o PLC está vivo. Não faz sentido o Booster 02 aparecer offline porque
nunca atuou, enquanto o Booster 01 está respondendo no mesmo rádio.

## Implementação
- `src/hooks/useDashboardEquipment.ts` expõe:
  - `buildTsnnLastCommMap(equipments)` → `Map<plc_group_id, ISO>` com o
    timestamp mais recente do grupo.
  - `effectiveLastComm(eq, tsnnMap)` → max entre `eq.last_communication`
    e o do grupo.
- Todos os 3 cálculos de `communicationStatus` no hook passam por
  `effectiveLastComm`. `lastReading` (texto) continua individual.
- O backend (`apply_pump_telemetry`) NÃO precisou mudar: cada equipamento
  segue tendo seu próprio `last_communication`; a unificação é só na UI.
