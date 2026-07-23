---
name: Water Balance Indicator
description: Indicador de Balanço Hídrico no Dashboard com estados específicos por horário de ponta + alerta crítico de violação tarifária + alertas no sino
type: feature
---
- RPC `get_water_balance(_farm_id)` cruza `level_history` (últimos 30 min, anchor 25-90 min atrás) com bombas de captação (`poco`/`bombeamento`). Retorna `status`, `rate_per_hour` (%/h), `sensor_rate_per_hour`, `avg_level_percent`, `active_pumps/total_pumps`, `prediction_hours`. Quando `active_pumps == 0`, força `rate_per_hour=0` e `status='parada'` (mantém leitura crua em `sensor_rate_per_hour` para exibir como "inércia").
- UI: `WaterBalanceCard` em `src/components/dashboard/WaterBalanceCard.tsx`, polling 60s. Estados visuais decididos no client cruzando `active_pumps` com `isPeakNow()` (de `src/lib/tariff.ts`, 18:00–21:00 dias úteis):
  - `positiva`/`equilibrada`/`insuficiente`/`sem_captacao` — bombas ligadas, fora da ponta
  - `pausada_ponta` (azul) — 0 bombas dentro da ponta (esperado)
  - `parada_fora` (amarelo) — 0 bombas fora da ponta (atenção)
  - `ponta_violacao` (vermelho pulsante) — bombas ligadas DENTRO da ponta. Mostra lista de bombas (nome + kW + "ligada há X min" via automation_log action='on'), consumo total kW e custo extra/min = `Σ kW × (tariff_peak − tariff_reserved) / 60`.
- NUNCA mostra "Sem dados suficientes" quando bombas estão desligadas — sempre comunica "pausada" ou "parada".
- NUNCA promete religamento automático — exibe apenas "Horário de ponta termina às 21:00" como informação.
- Alertas no sino (cron 1min via `automation-tick` → RPC `check_water_balance_alerts`): tabela `water_balance_state` rastreia `status_since` + `last_alert_*_at`. Insere `farm_notifications` (source=`water_balance`) quando: bomba na ponta (qualquer ativa, severity=critical, com lista de nomes e custo/min), insuficiente ≥30min, sem_captacao ≥15min, crítico (prediction <2h). Re-dispara cada alerta no máximo 1x/hora.
