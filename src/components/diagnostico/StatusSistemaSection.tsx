import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Activity, Radio, Server, Droplets, RefreshCw } from "lucide-react";
import { notify } from "@/lib/notify";
import ServerControlPanel from "./ServerControlPanel";
import RepeaterControlPanel from "./RepeaterControlPanel";
import RemotePortControl from "./RemotePortControl";

interface StatusRowProps {
  label: string;
  value: string;
  status?: "ok" | "warning" | "error";
}

const StatusRow = ({ label, value, status = "ok" }: StatusRowProps) => (
  <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
    <span className="text-sm text-muted-foreground">{label}</span>
    <div className="flex items-center gap-2">
      <span className="text-sm font-mono font-medium text-foreground">{value}</span>
      <div className={`h-2 w-2 rounded-full ${
        status === "ok" ? "bg-primary" : status === "warning" ? "bg-warning" : "bg-destructive"
      }`} />
    </div>
  </div>
);

const StatusSistemaSection = () => {
  const handleRefresh = () => {
    notify.tip("Status do Sistema", "Atualizando status do sistema...");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Status do Sistema</h2>
          <p className="text-sm text-muted-foreground">Centro de Comando — Servidor e Repetidor (via fila de comandos)</p>
        </div>
        <Button variant="outline" className="gap-2" onClick={handleRefresh}>
          <RefreshCw className="h-4 w-4" /> Atualizar Tudo
        </Button>
      </div>

      <RemotePortControl />

      <div className="grid gap-4 lg:grid-cols-2">
        <ServerControlPanel />
        <RepeaterControlPanel />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Droplets className="h-4 w-4 text-primary" /> Bombas
          </h3>
          <Badge variant="secondary" className="text-xs">Use o módulo Cadastros para CFG remoto por equipamento</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Comandos CFG por bomba (PING, STATUS, DUMP, SET_TSEM, SET_TX_GUARD, SAVE, REBOOT, FACTORY_RESET) ficam disponíveis
          no botão <span className="font-medium text-foreground">Configurar</span> de cada equipamento da lista de Cadastros.
          Todos os comandos são enfileirados com prioridade 2 e seguem a fila de TX da Serial.
        </p>
      </div>
    </div>
  );
};

export default StatusSistemaSection;
