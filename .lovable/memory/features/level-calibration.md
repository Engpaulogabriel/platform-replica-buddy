---
name: Level Calibration 1 ponto
description: Calibração de 1 ponto (regra de três) da leitura digital N1/N2 vinda do payload do PLC para metros + %
type: feature
---
- Frame RX do PLC com nível: `_[TSNN_0_]{outputs}_N1<raw>N1__N2<raw>N2_[TSNN_ETX_]\r`. O sufixo `_N<idx><raw>N<idx>_` é independente das chaves `{outputs}`.
- Agente Electron (`main.cjs`): regex `RX_LEVEL_RE = /_N([12])(\d{1,5})N\1_/g` em `processLevelReadings(frame, plcHwId)`, chamado em `processTelemFrame`. Cada N1/N2 vira RPC `apply_level_telemetry`.
- RPC `apply_level_telemetry(_farm_id, _plc_hw_id, _sensor_index, _raw_value, _raw_response)`: localiza o N-ésimo equipamento de nível do PLC (ordem `created_at ASC` → 1º=N1, 2º=N2) e atualiza `level_last_raw`, `level_last_raw_at`, `level_sensor_index`, `last_communication`. SECURITY DEFINER + `can_write_farm`.
- Calibração 1 ponto em `equipments`: `level_last_raw`, `level_last_raw_at`, `level_cal_digital`, `level_cal_meters`, `level_max_meters`, `level_sensor_index`. Os antigos `level_cal_raw_min/max` e `level_cal_meters_min/max` foram removidos.
- Conversão (`src/lib/levelCalibration.ts`): regra de três simples — `metros = (raw / cal_digital) * cal_meters`, `percent = (metros / max_meters) * 100`. Sem calibração → fallback de % bruta sobre `max_height`.
- UI: `LevelCalibrationCard` (compartilhado) usado em Cadastros (editar equipamento nível, modo `compact`) e Diagnóstico (aba "Nível" com `NivelSection`). Mostra leitura ao vivo + 3 campos (digital ref, metros ref, nível máximo). Botão Crosshair captura `level_last_raw` para o campo digital ref.
- Dashboard: `useDashboardEquipment` aplica `calibrateLevel` em `buildReservoirFromCloud` e no update inline; `Reservoir.level` mostra metros (ex "1.61"), `percent` calibrado.
- Polling inclui `'nivel'`: `enqueue_polling_for_due_equipments_internal` agora considera tipo `nivel` no rodízio de PLCs e no cálculo de `v_max_saida`. Para saídas onde só há sensor de nível, envia `'0'` (não controla relé — só leitura). O frame RX trará o sufixo N1/N2 que o agente parseia.
- Compatibilidade: agente antigo que não envia N1/N2 → equipamento de nível mostra "—" até atualizar o .exe. Nada quebra.
- Histórico: até 2026-04-30 a calibração era de 2 pontos (min/max + interpolação linear). Em 2026-05-01 trocada para 1 ponto após constatar que reservatórios reais só precisam de uma referência + nível máximo conhecido.
