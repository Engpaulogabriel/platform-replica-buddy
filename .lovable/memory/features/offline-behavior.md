---
name: Comportamento de equipamento offline
description: Regras absolutas de o que acontece (e o que NÃO acontece) quando uma bomba perde comunicação RX. Offline afeta apenas horímetro (pausa) e dashboard (mostra offline). NUNCA muda desired_running, NUNCA gera registro no relatório, NUNCA desliga nada no banco.
type: feature
---

## Regra geral
**Offline = perda de comunicação, NÃO é desligamento.**

## O que offline FAZ
1. **Horímetro pausa** — sessões abertas em `pump_runtime` param de contar no instante do último RX. Implementado em `get_horimetro_daily` e `get_horimetro_month_total`: para sessões com `ended_at IS NULL`, o "fim efetivo" é `LEAST(now(), last_communication)` quando `last_communication > now() - 60s`, senão congela em `last_communication`.
2. **Dashboard mostra "Sem comunicação"** — badge OFFLINE quando `last_communication < now() - 15 min` (ver `offline-thresholds`).
3. **Após 30 min offline com último estado=LIGADA**: nuvem enfileira TX OFF de segurança pela serial (`enqueue_protective_off_for_offline_pumps`). Ver `protective-off-offline`.

## O que offline NÃO FAZ
- **NÃO altera `desired_running`** — permanece no último valor definido por usuário/automação.
- **NÃO registra desligamento em `automation_log`** — perda de comunicação não é evento de operação.
- **NÃO desliga `pump_runtime`** — sessão fica aberta; quando RX voltar com estado=LIGADA, retoma sem abrir nova sessão.
- **NÃO cancela comandos pendentes** — função `purge_on_commands_for_offline_pumps` foi DROPada em 2026-05-26.

## Retomada automática
Quando RX volta:
1. `last_communication` avança → horímetro retoma contagem.
2. Se `desired_running = true` e RX confirma `OFF`, o agente envia TX ON no próximo ciclo de polling.
3. Se `desired_running = true` e RX confirma `ON`, nada a fazer.
Operação restaurada sem intervenção humana.

## Relatório de Automação — invariantes
- `origin='remote'` SEMPRE exige `user_id` real OU `source_device LIKE 'cloud-%'`. Trigger `enforce_automation_log_actor_rule` descarta o resto.
- Inserts vindos de `serial-bridge` sem `user_id` são reclassificados para `origin='local'` (acionamento físico detectado pela PLC).
- "Sistema" não é mais usado como autor; fallback é "Acionamento Local" ou "Automação".
