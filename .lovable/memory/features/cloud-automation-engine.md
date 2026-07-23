---
name: Cloud Automation Engine
description: Motor de automação 24/7 na nuvem. Edge function automation-tick rodada por pg_cron a cada minuto, evaluando automation_schedules + automation_engine + automation_holiday_configs. Frame idêntico ao manual da web (rf_routing por farm).
type: feature
---
O automático NÃO depende mais do navegador. Toda a lógica vive na nuvem:

**Tabelas**
- `automation_schedules` — programações por equipamento (mode `both|on-only|off-only`, days, time_on, time_off, active). RLS por farm.
- `automation_engine` — flag global por farm (1 linha) com `enabled` boolean. Permite pausar todo o automático sem apagar programações.
- `automation_holiday_configs` — overrides para feriados nacionais (modo `free-demand` ignora; `special-schedule` aplica horário especial).
- `automation_fired` — dedup de disparos por minuto (`schedule_id, fired_key=YYYY-MM-DD|on@HH:MM`). Limpa registros >2d a cada tick.
- `automation_guards` — guard automático quando bomba desliga fora do horário (ver memória `automation-guard`).
- `rf_routing` — 1 linha por farm (`radio` R1/R2/R3, `via_repetidor` bool). Lida pelo `run_automation_tick` para montar o frame com prefixo `REP:R3:TX:Rx:` quando aplicável, IGUAL ao botão manual da web. Front sincroniza via `pullRfRoutingFromCloud(farmId)` no AppLayout e `saveRfRoutingCloud()` ao alterar.

**Motor**
- Edge function `automation-tick` (verify_jwt=false) chama `run_automation_tick()`.
- `pg_cron` agenda chamada via `net.http_post` a cada minuto.
- A SPL function evalua TODAS as programações ativas de TODAS as fazendas por iteração:
  - Liga: dentro da janela `time_on..time_off`, sem comando pendente, bomba desligada, não em local lock.
  - Desliga: exatamente no minuto `time_off`, bomba ligada.
  - Insere comando `manual` em `commands` (priority=1, `source_device='cloud-automation'`) com frame montado por `buildLoRaFrame` + roteamento da `rf_routing` — o agente Electron consome igualzinho a um clique manual.

**UI**
- Hook `useCloudAutomation` (Realtime nas 3 tabelas) é fonte única em `Automatico.tsx`.
- Migração one-shot `migrateLegacyAutomationToCloud(farmId)` roda no AppLayout para puxar dados antigos do localStorage. Marca flag `automation_legacy_migrated_<farmId>` para nunca repetir.
- Arquivo `src/lib/automationScheduler.ts` foi REMOVIDO. Não existe mais lógica de scheduling no cliente.
