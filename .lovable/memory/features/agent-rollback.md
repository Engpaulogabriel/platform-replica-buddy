---
name: Agent Rollback 1-Clique
description: Rollback remoto da versão do agente via comando force_rollback. Usa app.asar.bak local (instantâneo <5s) ou fallback OTA. Botão por fazenda + Rollback todas + badge de rollback automático detectado.
type: feature
---

# Rollback 1-clique do agente Electron

## Banco
- `farms.agent_previous_version` (text) — gravado pelo agente ANTES de relaunch após OTA bem-sucedido (em `downloadAndInstallAsarUpdate`).
- `agent_update_status.auto_rollback_detected` (bool) — marca quando o agente reportou versão = previous após um push (cenário watchdog restaurando `.bak`).
- Enum `agent_cmd_kind` ganhou `'force_rollback'`.

## Agente (`electron-agent/main.cjs`)
Handler `force_rollback`:
1. Se existe `resources/app.asar.bak`: swap rename (`.asar → .tmp`, `.bak → .asar`, unlink tmp). Status `installing`, history `rolled_back`, `relaunch+exit`. <5s total.
2. Senão: fallback `downloadAndInstallAsarUpdate(targetVersion, null, null)`.

Payload esperado: `{ target_version: string }`.

## UI `/platform → Atualizações` (`PlatformUpdates.tsx`)
- Botão `⏪ Rollback` por linha de fazenda (vermelho), aparece quando `agent_previous_version != null` e ≠ versão atual. Confirm dialog mostra de→para.
- Botão `⏪ Rollback todas` no header do card "Versão instalada por fazenda".
- `dispatchRollback(farmId, targetVersion)` enfileira `agent_commands(kind=force_rollback)` + upsert `agent_update_status` com `target_version` + status `pending`.
- `AgentUpdateStatusPanel` mostra badge amarelo `Rollback automático` quando `auto_rollback_detected = true`.

## Notas
- Agente precisa de novo OTA para o handler entrar em vigor (versão atual em produção: 3.10.7).
- `RemoteBridgeControl.KIND_LABEL` precisa do label `force_rollback`.
- Watchdog `renov-agent-watchdog.bat` já cobre boot-failure restaurando `.bak` automaticamente.
