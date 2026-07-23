---
name: Agent OTA Manual (v3.11.4)
description: OTA do agente Electron é 100% manual. Admin dispara update por fazenda (ou em todas) via /platform → Atualizações. Agente NUNCA verifica versão sozinho — só executa `agent_commands.update_agent`.
type: feature
---

# OTA do agente Electron — v3.11.4 (Manual-Only)

## Mudança crítica vs v3.10.6

**REMOVIDO:** verificação periódica de `get_agent_target_version` no heartbeat.
Antes, marcar uma release como `is_latest=true` (ou pinar uma versão na fazenda) fazia o agente baixar e instalar sozinho em até 30s. Isso causou um incidente em jun/2026 onde a v3.11.3 com bug derrubou toda a rede simultaneamente.

**AGORA:** o agente só atualiza quando recebe um `agent_commands` com `kind='update_agent'`. O admin precisa clicar explicitamente em "Atualizar agora" por fazenda, ou "Forçar update em todas" com confirmação dupla.

## Fluxo

1. Admin abre `/platform → Atualizações → Nova release` e faz upload do `app.asar` (ou `.exe`). Hash SHA-256 é calculado no browser, arquivo vai pro bucket privado `agent-releases`. **Publicar não dispara update em ninguém.**
2. Tabela "Versão instalada por fazenda" mostra cada agente, sua versão, status (online/offline) e a release de referência.
3. Botão "Atualizar agora" (por linha) só fica habilitado quando o agente está online e tem versão diferente da release alvo. Insere `agent_commands.update_agent` para aquele `farm_id`.
4. Botão "Forçar update em todas" envia o comando em loop para todas as fazendas com confirmação dupla.
5. Agente processa o comando: baixa via URL assinada, valida SHA-256, faz backup `app.asar.bak`, troca, `relaunch()`.
6. Rollback continua disponível (`force_rollback` agent_command) e watchdog faz rollback automático se o novo binário não subir.

## O que continua igual

- Bucket privado `agent-releases` + edge function `agent-release-signed-url`.
- Validação SHA-256 + tamanho mínimo 1 MB no agente.
- Backup `resources/app.asar.bak` antes de trocar.
- `agent_update_status` + `agent_update_history` para telemetria de progresso.
- Watchdog `renov-agent-watchdog.bat` faz rollback se o agente novo crashar.

## O que é apenas informativo agora

- `agent_releases.is_latest` — só serve de "versão de referência" mostrada no painel. Não dispara update.
- `farms.target_agent_version` (pin) — idem, apenas indica qual versão a fazenda deveria rodar. Botão "Atualizar agora" usa essa referência.
- RPC `get_agent_target_version` continua existindo mas o agente não chama mais. Pode ser usado pela UI ou removida em limpeza futura.
