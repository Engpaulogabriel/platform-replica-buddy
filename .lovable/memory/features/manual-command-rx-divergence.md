---
name: Comandos manuais e RX divergente
description: Backend nunca deve marcar comando manual como erro por RX divergente; Electron decide timeout após reforço.
type: feature
---
`apply_pump_telemetry` e triggers do backend não podem marcar `commands.type='manual'` como `error` por divergência entre RX de polling e payload esperado.

Durante reforço, RX divergente é telemetria intermediária normal. O Electron/agente local é o único responsável por confirmar sucesso ou marcar timeout/erro após a janela operacional de reforço (120s) e executar safety-off quando necessário.