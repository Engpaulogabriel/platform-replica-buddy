---
name: Agent Hardware Fingerprint (Phase B)
description: Verificação de hardware do PC do agente (MAC/disk/BIOS/CPU) — política híbrida ok/warning/blocked com reautorização por platform_admin.
type: feature
---
# Hardware Fingerprint híbrido (Camada 5)

Tabelas: `agent_hardware` (1:1 farm_id) e `agent_hardware_history`. RPC `reset_agent_hardware(farm_id)` (platform_admin) marca `reset_requested=true` para o agente regravar no próximo boot.

## Política
4 componentes contam: `mac_address`, `disk_serial`, `bios_uuid`, `cpu_id`.
- 0 mudanças → `ok`
- 1 mudança → `warning` (continua rodando, registra em history + reportTampering warn)
- 2+ → `blocked` → `app.exit(2)` + `dialog.showErrorBox` + reportTampering critical

`hostname` e `os_install_date` são informativos. Falha de leitura (wmic null) ignora aquele componente.

## Agente
`collectHardwareFingerprint()` usa `os.networkInterfaces()` para MAC e `wmic` para disk/BIOS/CPU/install_date. `awaitAndVerifyHardware(cfg)` em `startAgent` espera supabase autenticar (até 30s) e roda 1 verificação. Se `reset_requested=true`, regrava sem comparar.

## UI
`src/components/HardwareSecurityPanel.tsx` — aba "Hardware" em `/suporte-tecnico`. Tabela com badge ok/warning/blocked, componentes alterados, última verificação, versão. Botão "Reautorizar" (chama `reset_agent_hardware`) só para platform_admin. Histórico das últimas 50 mudanças.
