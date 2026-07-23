// ErrorBoundary genérico para páginas — evita "tela branca" em caso de crash
// e mostra o erro real para o usuário/desenvolvedor.
import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props { children: React.ReactNode; pageName?: string }
interface State { error: Error | null }

export class PageErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[PageErrorBoundary${this.props.pageName ? ":" + this.props.pageName : ""}]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 max-w-3xl mx-auto mt-6">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <h2 className="text-lg font-semibold text-destructive">
              Erro ao carregar {this.props.pageName ?? "esta página"}
            </h2>
          </div>
          <p className="text-sm text-muted-foreground mb-3">
            Algo falhou ao renderizar. Detalhes técnicos abaixo:
          </p>
          <pre className="text-xs bg-background border border-border rounded-md p-3 overflow-auto max-h-64 whitespace-pre-wrap break-all">
            {this.state.error.name}: {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack?.split("\n").slice(0, 8).join("\n")}
          </pre>
          <div className="flex gap-2 mt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => this.setState({ error: null })}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-2" /> Tentar novamente
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { window.location.href = "/home"; }}
            >
              Voltar ao Início
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
