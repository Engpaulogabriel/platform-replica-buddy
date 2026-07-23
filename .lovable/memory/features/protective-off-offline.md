---
name: Proteção offline (TX OFF de segurança)
description: Após 30 min sem comunicação, se o último estado conhecido era LIGADA, a nuvem enfileira um TX OFF de segurança PELA SERIAL. NÃO altera desired_running e NÃO registra no Relatório de Automação. Se a comunicação voltar e desired_running ainda for true, o agente religa pelo próximo ciclo.
type: feature
---

## Regra ABSOLUTA
`desired_running` **só** pode ser alterado por:
1. Ação humana explícita (toggle no dashboard / API autenticada)
2. Agente serial reportando acionamento físico via RX da PLC
3. Automação configurada pelo usuário (scheduler `automation-tick`)

Nunca por timeout, offline, cleanup ou "safety" automático.

## Função `enqueue_protective_off_for_offline_pumps` (atual)
Roda em `automation-tick` a cada 1 min:
- Threshold: **30 minutos** sem comunicação (era 15)
- Só age se `last_outputs_state` indica bomba LIGADA na sua `saida`
- Enfileira `[TSNN_1_]{PAYLOAD}[TSNN_ETX_]\r` com payload combinado OFF para a saída, `priority=0`, `timeout=2h`, `source_device='cloud-protective-off'`
- **NÃO altera `desired_running`** (permanece `true`)
- **NÃO insere em `automation_log`** (não é ação de usuário)
- Loga em `agent_logs` (category=safety, level=warn) para auditoria técnica
- Idempotente por `source_device='cloud-protective-off'` pendente

Resultado natural: o agente envia o OFF; se o `desired_running` continuar `true`, o próximo ciclo de polling religa a bomba.

## Função removida
`purge_on_commands_for_offline_pumps` foi **DROPada** em 2026-05-26. Violava a regra absoluta (zerava `desired_running` automaticamente). Não recriar.

## Trigger no Relatório (`enforce_automation_log_actor_rule`)
BEFORE INSERT em `automation_log`:
- `source_device LIKE 'cloud-%'` → passa (automação rastreada)
- `origin='remote'` + `user_id IS NULL`:
  - Se `source_device LIKE 'serial-bridge%'` → reclassifica para `origin='local'`
  - Senão → **descarta o insert** (RETURN NULL)
- Garante que **nunca** aparece "Desligada/Ligada · Remoto · Sistema" no relatório
