---
name: Security Hardening 2026-06 (v3.10.7)
description: Hardening final anticlone — gate de fingerprint pré-bridge, license kill-switch a cada heartbeat (72h grace), verificação de ofuscação, OTA hash reporta tampering, badges + histórico de segurança no /platform.
type: feature
---

# Hardening final v3.10.7 (junho/2026)

Pacote único cobrindo agente Electron + UI /platform → Dispositivos.

## Agente (electron-agent/app/main.cjs e electron-agent/main.cjs)

1. **Fingerprint gate pré-bridge** — `startAgent()` agora aguarda `connectCloudServices` e `awaitAndVerifyHardware` ANTES de abrir `startBridge`. Se `level === "blocked"` (≥2 componentes alterados) → `reportTampering("hardware_changed", critical)` + `dialog.showErrorBox` + `app.exit(2)`. Bridge nunca abre.

2. **License kill-switch a cada heartbeat (30s)** — `sendHeartbeat()` chama `validateLicenseHeartbeat(cfg)`:
   - POST `license-validate` com `Authorization: Bearer licenseToken`.
   - `403` ou `error in {revoked, farm_suspended}` → `stopAllPumpsBeforeExit()` envia frame `[TSNN_1_]{000000}[TSNN_ETX_]\r` para cada PLC distinto, marca `desired_running=false`, `reportTampering("config_replaced", critical)`, depois `app.exit(1)` após 1.5s.
   - Grace offline: persistido em `userData/license-grace.json`. Sem resposta válida por > **72h** → mesmo fluxo de kill-switch. Entre 0–72h continua operando (mantém polling/leitura).
   - Flag `licenseKillSwitchTriggered` impede dupla execução; `sendHeartbeat` aborta cedo após disparo.

3. **Verificação de ofuscação** — `verifyAgentObfuscation(cfg)` roda só em `app.isPackaged` após bridge. Lê 200KB do próprio `__filename` e procura padrões do javascript-obfuscator (`_0xXXXX`, `var _0x... = [`, string arrays hex). Sem marcadores → `reportTampering("unsigned_binary", warn)`. Continua rodando (warn-only).

4. **OTA integrity** — pontos de hash mismatch em `downloadAndInstallAsarUpdate` e `downloadAndInstallUpdate` agora chamam `reportTampering("integrity_check_failed", critical)` com `expected_hash`/`actual_hash` antes de rejeitar. Update nunca é aplicado se hash não bater.

5. **Tabelas usadas** — apenas existentes: `device_licenses`, `agent_hardware`, `tampering_events`. Nenhuma mudança de schema.

## UI /platform → Dispositivos (src/components/platform/PlatformDevices.tsx)

- Fetch paralelo de `tampering_events` (últimos 500) + `agent_hardware` + devices.
- Coluna "Segurança" por dispositivo com badges calculados:
  - 🔴 **Licença revogada** (`device_licenses.revoked_at` definido)
  - 🔴 **Máquina não autorizada** (`agent_hardware.alert_level = "blocked"`)
  - 🟡 **Hardware alterado** (`alert_level = "warning"`)
  - 🟡 **Código não-ofuscado** (`tampering_events.kind = "unsigned_binary"` últimos 7d, não-ack)
  - 🟡 **Update rejeitado (hash inválido)** (`kind = "integrity_check_failed"` últimos 7d, não-ack)
- Card de stat "Alertas críticos" mostra `tampering_events` não-ack com `level=critical`.
- Botão de histórico (ícone `History`) abre dialog com timeline completa dos eventos da fazenda.
- **Realtime**: canal `platform-tampering` em `tampering_events` INSERT → toast (`notify.fail` para crítico, `notify.warn` para warn) + refresh.

## Comportamento confirmado pelo usuário

- **Grace offline = 72h, mantendo leitura/telemetria** entre 0–72h. Só para automação/comandos quando exit dispara.
- **Licença revogada → desliga todas as bombas via RS-232 antes de exit(1)** (não deixa bomba ligada sem supervisão).

## Versão

`AGENT_VERSION = "3.10.7"` (bumped em ambos main.cjs e package.json).

## Próximos passos sugeridos (não implementados)

- Botão "Confirmar alerta" no histórico (UPDATE `tampering_events.acknowledged_at`).
- Cron diário deletando `tampering_events` ack > 90d para limitar custo.
