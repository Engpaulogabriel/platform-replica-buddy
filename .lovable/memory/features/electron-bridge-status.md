---
name: Electron Bridge Status
description: Indicador global (badge no header + card no Dashboard) do status da bridge Electron .exe (RS-232) com heartbeat de 30s.
type: feature
---

# Status da Bridge Electron (.exe)

## Por quê
A comunicação com bombas é via rádio RS-232 do PC com Electron .exe — não via internet. O usuário precisa saber se a bridge desktop está viva e se a porta COM está aberta. Web (sem .exe) não controla bombas.

## Implementação
- **Hook**: `src/hooks/useElectronBridgeStatus.ts` — assina `serialAPI.onData/onStatus`, atualiza `lastBeatAt`, faz polling de 5s para `isOpen()` e re-avaliar staleness.
- **Badge global**: `src/components/BridgeStatusBadge.tsx` — fica no header `AppLayout`, ao lado de NotificationCenter.
- **Card detalhado**: `src/components/dashboard/BridgeStatusCard.tsx` — dentro do popover "Centro de Comando" do Dashboard.

## Estados
| status | quando | cor |
|---|---|---|
| `ok` | bridge presente + porta COM aberta + heartbeat < 30s | primary (verde), com pulse |
| `no-port` | bridge presente, porta fechada | warning |
| `stale` | bridge presente, porta aberta, sem heartbeat há > 30s | warning |
| `error` | `serialAPI.health().serialLoadError` retornou algo | destructive |
| `no-bridge` | `window.serialAPI` ausente (rodando no browser web) | muted |

Heartbeat = qualquer evento `onData` ou `onStatus` (open/close/error/data) atualiza `lastBeatAt`.
