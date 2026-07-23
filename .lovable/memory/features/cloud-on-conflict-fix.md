---
name: ON CONFLICT em pump_runtime resolvido (v3.8.0)
description: Trigger track_pump_runtime usava ON CONFLICT (equipment_id) WHERE ended_at IS NULL — sintaxe inválida em PG. Reescrita com IF NOT EXISTS. Polling do agente também não trava mais por 120s em RX divergente.
type: feature
---

# Bug ON CONFLICT em apply_pump_telemetry (resolvido em 30/04/2026)

## Causa raiz
Trigger `track_pump_runtime` (em `equipments`) fazia:
```sql
INSERT INTO pump_runtime ... ON CONFLICT (equipment_id) WHERE ended_at IS NULL DO NOTHING;
```
Postgres não aceita predicado `WHERE` no `ON CONFLICT` — só aceita índice nomeado. Mesmo com índice parcial existente (`pump_runtime_one_open_per_equipment`), a sintaxe quebra com:
> there is no unique or exclusion constraint matching the ON CONFLICT specification

O erro só aparecia em mudança de estado (1→0 ou 0→1) porque a função só roda nesse caminho.

## Correção
- Função `track_pump_runtime` reescrita usando `IF NOT EXISTS (...)` em vez de `ON CONFLICT`. Mantém comportamento idempotente sem depender do índice parcial.
- Triggers órfãs com mesmo procedimento são dropadas via `DO $$` antes do `CREATE OR REPLACE`.

## Bug paralelo no agente (.exe v3.8.0)
RX intermediário divergente em comando manual mantinha `inflightCmd` por até 120s, travando a fila serial. Corrigido em `electron-agent/main.cjs` (`processTelemFrame`): ao detectar leitura intermediária, libera `inflightCmd/Timer/Tsnn` e chama `processNextCommand` para o polling reenviar `desired_running` a cada 13s.
