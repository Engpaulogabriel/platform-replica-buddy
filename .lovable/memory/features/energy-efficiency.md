---
name: Energy Efficiency Card
description: Card 24h no Dashboard com índice de eficiência em min-bomba (multiplicativo) + alertas pré/pós-ponta
type: feature
---
- **Conceito central: MIN-BOMBA (multiplicativo).** Tempo perdido = minutos × nº bombas afetadas. Ex: 20 bombas × 17 min = 340 min-bomba. NÃO usa m³ (sem medição real de vazão).
- **Fonte canônica = `pump_runtime`** (sessões reais de hardware). `automation_log` é APENAS auditoria (quem/via/origem) e pode estar incompleto (acionamentos locais nem sempre logam). NUNCA usar `automation_log` para decidir se bomba operou, first_on, last_off ou peak_minutes.
- Tabela `energy_efficiency_daily` (farm_id × date): `lost_minutes` agora armazena MIN-BOMBA total (= atraso pós-ponta por bomba + paradas/gaps + min na ponta). Sem write policies — só funções `SECURITY DEFINER`.
- **Universo do ciclo:** APENAS bombas que efetivamente operaram no ciclo (drop `scheduled_for_cycle`). Não ligou = não conta.
- **Pós-ponta (nova regra 2026-07-09):** janela FIXA `[cycle_start, cycle_start+3h]` (21:00-00:00 do dia de abertura). Só entram bombas que ligaram nessa janela. `late_min = first_on - cycle_start`; status: `ok` (≤8min) / `late` (>8min). Bombas que ligaram depois de 00:00 (madrugada, manhã, tarde) são acionamento por demanda — NÃO são pós-ponta. Não existe mais `not_started`.
- **Pré-ponta (nova regra 2026-07-09):** janela FIXA `[peak_start-2h, peak_start]` (16:00-18:00). Só entram bombas que desligaram nessa janela. Alvo = `peak_start-15min` (17:45). Desligamento antes das 16:00 = operação normal, não conta.
- **Dias livres (sábados/domingos/feriados):** sem ponta/pré/pós; perdido = apenas gaps; capacidade = bombas × 1440.
- **Rodízio NÃO penaliza:** gap só conta se a MESMA bomba desligou e depois religou.
- Cálculo: `lost = post_lost + gap + peak`. Capacidade = `pumps_operated × 1260`. Eficiência = 100 − lost*100/capacidade.
- Cores do total perdido: <100 verde · 100-500 amarelo · >500 vermelho.
- `check_peak_efficiency_alerts()` 17:55/21:05/21:15. Dedup por title+today.
- Janela ciclo = 21h ontem→18h hoje. Janela ponta = 18:00-21:00 do `cycle_date` (dia de desligamento); ponta usa sessões reais de `pump_runtime`.

- Card: `src/components/dashboard/EnergyEfficiencyCard.tsx`. Polling 60s. Mostra: header status (operadas/agora/desde 21h), 3 eventos (pós-ponta, pré-ponta, paradas), TOTAL min-bomba destacado, acumulado 7d/30d em min-bomba + média % 7d/30d.
