---
name: Toasts & Confirmações Padronizados
description: Helpers centralizados para notificações (notify.ts) e modais de confirmação (confirmDialog.tsx). Toaster top-right, máx 3, dedup por id.
type: feature
---
- `<Toaster richColors closeButton position="top-right" visibleToasts={3} expand={false} />` no App.tsx.
- Módulo `src/lib/notify.ts` exporta `notifyCommand`, `notifyComm`, `notifyLevel`, `notifySecurity`, `notifyAutomation`. Cada chamada usa um `id` estável (ex: `cmd-on:<equipName>`) para deduplicar repetições. Durações: info/success=5s, warning=10s, error=Infinity (persistente, fecha manualmente).
- Mensagens com prefixo emoji (✅ 🔴 ⚠️ ℹ️ 🤖 ⏳) e SEMPRE incluem nome do equipamento + o que aconteceu. Nunca "Erro" / "Sucesso" genéricos.
- `src/lib/confirmDialog.tsx` expõe `confirmAction({ title, description?, confirmLabel?, variant? })` retornando `Promise<boolean>`. Usado em: ligar/desligar bomba (Dashboard.togglePump) e iniciar Modo Serviço (PlatformServiceMode).
- BridgeStatusBadge dispara `notifyComm.bridgeDown()` em `stale|error` e `notifyComm.bridgeUp()` ao voltar para `ok` (toast persistente é encerrado por `toast.dismiss("bridge-down")`).
