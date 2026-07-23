---
name: Polling Backoff por PLC
description: Backoff in-memory no Electron para PLCs sem resposta — reduz frequencia de polling de PLCs mortas economizando ciclo da RS-232.
type: feature
---
# Polling Backoff (Electron Agent v3.8.18+)

In-memory map `pollingBackoffByTsnn` em `electron-agent/main.cjs`. NAO persiste no banco.

## Regras
- 0-4 falhas consecutivas (timeout em comando type=polling): polling normal toda rodada.
- 5-9 falhas: polling 1x a cada 3 rodadas (pula 2). Log warn ao entrar.
- 10+ falhas: polling 1x a cada 10 rodadas (pula 9). Log warn ao entrar.
- Qualquer RX casado pelo TSNN (em `processTelemFrame`) zera o contador via `noteBackoffSuccess` e loga "polling retomado normal".

## Importante
- Backoff aplica APENAS a `cmd.type === "polling"`. Comandos `manual`, `config`, `service_test`, `reset` NUNCA sao bloqueados.
- Quando uma rodada eh pulada, o registro `commands` correspondente eh marcado `cancelled` com `error_message` indicando backoff (mantem rastreabilidade no Relatorio de Automacao se necessario filtrar).
- A PLC nunca eh removida do ciclo: quando o contador de pulos atinge `skipEvery-1`, o proximo polling passa para detectar volta online.
- v3.11.6: timeout serial reduzido a 5s para QUALQUER comando (manual/polling/reset) destinado a TSNN com failures > 5 — NAO depende de cmd.type nem de isBackendResetCommand (bug v3.11.5: exigia source_device "backend-reset:" e nunca casava com RESET da UI → 120s de trava).
- v3.11.6: `seedBackoffFromCloud()` no startup semeia failures=6 para TSNNs com `equipments.communication_status='offline'` no banco — backoff nao zera mais com restart do agente. 1º RX real zera via noteBackoffSuccess.


## UI
Indicador de "Sem comunicacao ha X min" ja existia via `useDashboardEquipment` (>=20min sem `last_communication` = offline). Backoff acelera a deteccao indireta porque PLCs mortas nao consomem mais 13s/ciclo.
