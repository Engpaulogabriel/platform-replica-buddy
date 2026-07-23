---
name: last_communication é RX-only
description: equipments.last_communication SÓ pode ser atualizado quando um frame RX real é recebido (apply_pump_telemetry). NUNCA em TX, safety, timeout ou qualquer caminho sem resposta do rádio.
type: constraint
---
`equipments.last_communication` é a fonte do badge Online/Offline da web
(ONLINE_WINDOW_MS = 15 min em `useDashboardEquipment.ts`, e o Fix 5 propaga
o MAX do `plc_group_id` para todo o TSNN).

**Proibido** atualizar esse campo em qualquer fluxo que não tenha RX real:
- `fireSafetyOff` (safety 60s) — bug corrigido em 2026-06-09: renovava o
  timestamp a cada TX sem resposta, fazendo bombas mortas aparecerem
  "Online"/"Ligadas" na web (incidente TSNN 2302 Booster 01/02).
- Qualquer UPDATE manual, seed ou edge function.

**Único caminho válido:** RPC `apply_pump_telemetry` chamada pelo agente ao
receber frame `_[TSNN_0_]{...}` válido.

**Por quê:** TX não prova que o PLC está vivo; só RX prova. Violador clássico
de Fix 5 — se o cliente reportar "bomba offline aparece Online", procurar
primeiro um escritor indevido de `last_communication`.
