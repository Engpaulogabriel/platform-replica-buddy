---
name: RF Signal Measurement
description: Regra de medição da barra de sinal RF (4 barrinhas) baseada em latência de resposta a comandos via RS-232, com cronômetro implementado e persistência na nuvem.
type: feature
---

# Medição do Sinal RF

## Princípio
A barra de sinal RF **NÃO** é uma medição contínua. Ela é calculada pela **latência da resposta** ao último comando enviado (Ligar / Desligar / Atualizar Status agora).

Comunicação via **rádio RS-232** a partir do PC com Electron .exe — não depende de internet. A barra RF é o único indicador visual de "online" no Dashboard.

## Tabela de conversão latência → barras
| Tempo de resposta | Barras cheias | Intensidade |
|---|---|---|
| ≤ 4s | 4 (todas) | 100% |
| ≤ 5s | 3 (esq. p/ dir.) | 75% |
| ≤ 6s | 2 | 50% |
| ≤ 8s | 1 | 25% |
| > 8s ou sem resposta | 0 (apagada) | 0% — sem sinal |

## Implementação atual (Fase 1 + 2 — cronômetro + protocolo real)
- Helper puro `src/lib/rfSignal.ts`: `measureSignalBars(latencyMs)`, `barsToPercent(bars)`, `simulateLatency()`, constante `RF_TIMEOUT_MS=8000`.
- Helper `src/lib/rfRouting.ts`: persiste `radio` (R1/R2/R3) + `viaRepetidor` em localStorage; mapeia comando lógico para protocolo (`turn_on→cmd=1,payload=1` / `turn_off→cmd=1,payload=0` / `status_read→cmd=CFG,payload=STATUS`); `buildEquipmentFrame({hwId,command})` monta linha completa com `buildLoRaFrame` + `buildDirectToServer`/`buildViaRepetidorTx`.
- Hook `src/hooks/useRfMeasurement.ts`: `measure({equipmentId, equipmentName, command, frame?, expectedHwId?})` cronometra envio→resposta. Modo real só ativa quando bridge presente + frame montado + porta aberta (`serialAPI.isOpen()`); senão cai em simulação 800-9500ms. `waitForRealResponse(expectedHwId)` filtra linhas via `[<hwId>_` ou `_[<hwId>_` (ignora respostas de outras bombas no barramento). Timeout: 8.2s.
- Persistência por medição:
  - **`equipments.last_signal_bars`** (smallint 0-4, check constraint) + `last_communication=now()` (só se não timedOut).
  - **`automation_log` insert**: `action=status_read|turn_on|turn_off`, `origin=reading|remote`, `result=success|timeout`, `details={ latency_ms, bars, simulated, command }`.
- Wire-up no Dashboard: `togglePump` e `refreshPumpStatus` chamam `measureRf` com `frame` real (via `buildEquipmentFrame`) e `expectedHwId=pump.hwId`. UI atualiza `signalRF=barsToPercent(bars)` e `online=bars>0`.

## TODO Fase 3 (configurar roteamento na UI)
- Hoje `loadRfRouting()` lê do localStorage com defaults `radio="R1", viaRepetidor=false`. Falta tela de Configurações que use `saveRfRouting()` para o admin escolher por fazenda. Por enquanto, o operador pode editar manualmente em DevTools ou usar a Diagnóstico → BombaSection que já tem switches.
