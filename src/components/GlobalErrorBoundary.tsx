// Boundary global de último recurso — evita "tela branca" total quando algo
// crasha acima do nível das páginas (ex.: Realtime/WebSocket suspenso pelo
// Safari ao trocar de aba, erro em provider, etc).
// Mostra mensagem amigável e recarrega a página em 2s.
import React from "react";
import { Loader2 } from "lucide-react";

interface Props { children: React.ReactNode }
interface State { error: Error | null }

export class GlobalErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };
  private reloadTimer: number | null = null;

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[GlobalErrorBoundary]", error, info.componentStack);
  }

  componentDidUpdate(_prev: Props, prevState: State) {
    if (!prevState.error && this.state.error) {
      // Agenda recarga automática para sair do estado quebrado
      this.reloadTimer = window.setTimeout(() => {
        try { window.location.reload(); } catch {}
      }, 2000);
    }
  }

  componentWillUnmount() {
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fixed inset-0 flex flex-col items-center justify-center bg-background text-foreground gap-3 p-6 text-center">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <p className="text-sm font-medium">Ocorreu um erro. Recarregando…</p>
          <p className="text-xs text-muted-foreground max-w-md break-words">
            {this.state.error.message}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

// Hook: ao voltar para a aba, se o root estiver vazio (React caiu sem boundary
// capturar — ex.: erro em microtask de WebSocket), recarrega a página.
export function useVisibilityRecovery() {
  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const root = document.getElementById("root");
      if (root && root.children.length === 0) {
        try { window.location.reload(); } catch {}
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    // Também captura erros não tratados (promise rejections de WS) — só loga
    const onUnhandled = (e: PromiseRejectionEvent) => {
      console.warn("[unhandledrejection]", e.reason);
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("unhandledrejection", onUnhandled);
    };
  }, []);
}
