---
name: Protocolo Renov Oficial
description: Linkagem definitiva UI↔Electron↔firmware. Frames com \r. Payload depende de plc_groups.output_count: 1 saída = posicional; multi-saída = combinado preservando bits das outras.
type: feature
---
## Frame
`[TSNN_CMD_]{PAYLOAD}[TSNN_ETX_]\r` (TX e RX SEMPRE com `\r`).

## Payload — depende do total de saídas da PLC (`plc_groups.output_count`, default 6)

### PLC com 1 saída (`output_count = 1`) — POSICIONAL
Mantém o comportamento antigo (compatibilidade com poços standalone):
- Saída 1 ON `{1}` / OFF `{0}`
- Saída 2 ON `{01}` / OFF `{00}` (apenas se a PLC realmente só tem essa saída como única usada)

### PLC multi-saída (`output_count > 1`, padrão 6) — COMBINADO
O payload SEMPRE tem `output_count` dígitos. Preserva o estado físico atual das demais saídas e altera APENAS o bit da saída alvo.

Ex PLC 2102 (output_count=6), estado atual `{010001}`:
- Ligar saída 3 → `{011001}`
- Desligar saída 3 → `{010001}`

Isto resolve o bug em que ligar a Bomba 1 do PLC 2102 enviava `{001}` (3 dígitos) e o firmware não confirmava — disparando o safety, que então desligava todas via `{000}`.

## Implementação (2026-05)
- Coluna `plc_groups.output_count smallint NOT NULL DEFAULT 6 CHECK (1..6)`.
- Helper SQL `renov_combined_payload(state, saida, on, total)`.
- Helper TS `buildCombinedPayload` em `src/lib/rfRouting.ts`.
- `commandQueue.ts` usa `resolvePlcContext` + `buildOutputPayload` (combinado se total>1, posicional se =1) em: `enqueueManualPumpCommand`, `enqueueResetPumpCommand`, `enqueueManualStatusRead`, `enqueueManualLevelRead`.
- SQL atualizado: `enqueue_reset_pump_command`, `enqueue_protective_off_for_offline_pumps`, `run_automation_tick` (cloud-automation), `enqueue_polling_for_due_equipments_internal`.

## Backend `apply_pump_telemetry`
Aceita RX de 1, 2..5 ou 6 dígitos. Desambiguação por `plc_groups.output_count`:
- 6 dígitos → bitfield combinado (atualiza todas as posições).
- 2..5 dígitos AND `length(payload) = output_count` AND `output_count > 1` → bitfield combinado curto (ex: PLC 2302 "Bombeamento 2B" com `output_count=2` recebe `{10}` = Booster 01 ON, Booster 02 OFF). Armazena padronizado em 6 dígitos via `rpad(_, 6, '0')`.
- 2..5 dígitos restantes → posicional (length = saída, último dígito = estado), preservando demais.
- 1 dígito → posicional, saída deduzida do comando pendente ou do equipamento alvo.

## Janela de RX atrasado (Electron Agent)
- Serial timeout manual: ~13s.
- `LATE_RX_MATCH_WINDOW_MS = 120_000`.
- RX intermediário divergente em comando manual NÃO chama `applySpontaneousImmediately`.

## CFG remoto
Detalhes em `cfg-response-matching` e `advanced-cfg-equipments`.
