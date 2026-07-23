// ─────────────────────────────────────────────────────────────────────────────
// RemotePortControl — abre/fecha/lista/troca a porta serial do Agent remoto
// ─────────────────────────────────────────────────────────────────────────────
// Comandos enfileirados em `agent_commands` (kind=open_port|close_port|
// change_port|list_ports|hard_reset_bridge). O Agent Electron na fazenda
// escuta via Realtime e executa.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Plug,
  Unplug,
  RefreshCw,
  RotateCw,
  Loader2,
  CheckCircle2,
  XCircle,
  Usb,
  AlertTriangle,
} from "lucide-react";
import { notify } from "@/lib/notify";
import { enqueueAgentCommand, runAgentCommand, type AgentCmdKind, type AgentCmdResult } from "@/lib/agentCommands";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useSiteHealth } from "@/hooks/useSiteHealth";

interface PortInfo {
  path: string;
  description?: string;
}

interface PendingState {
  label: string;
  result?: AgentCmdResult;
}

const RemotePortControl = () => {
  const farmId = useDefaultFarmId();
  const health = useSiteHealth(farmId);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState<string>("");
  const [pending, setPending] = useState<PendingState | null>(null);
  const isWorking = pending !== null && !pending.result;

  // Pré-seleciona a porta atualmente em uso pelo agent
  useEffect(() => {
    if (health.comPort && !selectedPort) setSelectedPort(health.comPort);
  }, [health.comPort, selectedPort]);

  const run = async (label: string, kind: AgentCmdKind, payload?: Record<string, unknown>, timeoutMs = 15_000) => {
    if (!farmId) {
      notify.fail("Porta Remota", "Fazenda não identificada");
      return;
    }
    setPending({ label });
    try {
      const { result } = await runAgentCommand({ farmId, kind, payload, timeoutMs });
      setPending({ label, result });
      if (result.status === "done") {
        notify.ok("Porta Remota", `${label} OK`);
        // Se foi list_ports, popula o select
        const data = result.result?.data as { ports?: PortInfo[] } | undefined;
        if (kind === "list_ports" && data?.ports) {
          setPorts(data.ports);
          if (data.ports.length === 0) notify.warn("Porta Remota", "Nenhuma porta COM detectada no Agent");
        }
      } else {
        notify.fail("Porta Remota", `${label}: ${result.error_message ?? result.status}`);
      }
    } catch (e) {
      setPending({ label, result: { status: "error", error_message: e instanceof Error ? e.message : String(e) } });
      notify.fail("Porta Remota", e instanceof Error ? e.message : String(e));
    }
  };

  const handleListPorts = () => run("Listar portas", "list_ports", undefined, 10_000);
  const handleOpen = () => {
    if (!selectedPort) return notify.fail("Porta Remota", "Selecione uma porta COM");
    run(`Abrir ${selectedPort}`, "open_port", { port: selectedPort }, 15_000);
  };
  const handleClose = () => run("Fechar porta", "close_port", undefined, 10_000);
  const handleChange = () => {
    if (!selectedPort) return notify.fail("Porta Remota", "Selecione uma porta COM");
    if (selectedPort === health.comPort) return notify.tip("Porta Remota", "Esta já é a porta ativa");
    if (!confirm(`Trocar para ${selectedPort}? A porta atual será fechada.`)) return;
    run(`Trocar para ${selectedPort}`, "change_port", { port: selectedPort }, 20_000);
  };
  const handleHardReset = () => {
    if (!confirm("Executar o reset remoto do Agent? A ponte serial será reiniciada e a comunicação ficará indisponível por alguns segundos.")) return;
    if (farmId) void enqueueAgentCommand({ farmId, kind: "agent_restart", payload: {}, expiresInSec: 300 });
    run("Reset remoto do Agent", "hard_reset_bridge", undefined, 20_000);
  };

  const agentOnline = (!!health.lastHeartbeat) && health.state === "online";
  const portConnected = health.comConnected;

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Usb className="h-4 w-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">Porta Serial — Controle Remoto</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Abre, fecha, troca a porta COM ou executa o reset remoto do Agent instalado na fazenda
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border ${
              agentOnline
                ? "bg-primary/15 text-primary border-primary/30"
                : "bg-muted text-muted-foreground border-border"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${agentOnline ? "bg-primary animate-pulse" : "bg-muted-foreground"}`} />
            Agent {agentOnline ? "online" : "offline"}
          </span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border ${
              portConnected
                ? "bg-primary/15 text-primary border-primary/30"
                : "bg-warning/15 text-warning border-warning/30"
            }`}
          >
            {portConnected ? (
              <>
                <Plug className="h-3 w-3" /> {health.comPort ?? "?"} aberta
              </>
            ) : (
              <>
                <Unplug className="h-3 w-3" /> Porta fechada
              </>
            )}
          </span>
        </div>
      </div>

      {!agentOnline && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div className="text-foreground">
            <p className="font-medium">Agent offline</p>
            <p className="text-muted-foreground">
              Os comandos serão enfileirados e executados quando o Agent voltar a se conectar (em até{" "}
              {Math.round((60 / 60) * 60)}s antes de expirar).
            </p>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
        Se o Agent travar, use <span className="font-medium text-foreground">Reset remoto do Agent</span> para reiniciar a ponte serial à distância sem precisar ir ao Windows.
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="space-y-1.5">
          <Label className="text-xs">Porta COM</Label>
          <div className="flex gap-2">
            <Select value={selectedPort} onValueChange={setSelectedPort} disabled={isWorking}>
              <SelectTrigger className="flex-1 font-mono">
                <SelectValue placeholder="Selecione…" />
              </SelectTrigger>
              <SelectContent>
                {ports.length === 0 && health.comPort && (
                  <SelectItem value={health.comPort}>{health.comPort} (atual)</SelectItem>
                )}
                {ports.length === 0 && !health.comPort && (
                  <SelectItem value="_none" disabled>
                    Clique em "Listar"
                  </SelectItem>
                )}
                {ports.map((p) => (
                  <SelectItem key={p.path} value={p.path}>
                    <span className="font-mono">{p.path}</span>
                    {p.description ? <span className="text-muted-foreground"> • {p.description}</span> : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" disabled={isWorking} onClick={handleListPorts} title="Listar portas COM no PC do Agent">
              <RefreshCw className={`h-4 w-4 ${pending?.label === "Listar portas" && !pending.result ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Button
          variant="default"
          size="sm"
          disabled={isWorking || !selectedPort || portConnected}
          onClick={handleOpen}
          className="gap-2 justify-start"
        >
          <Plug className="h-4 w-4" /> Abrir
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={isWorking || !portConnected}
          onClick={handleClose}
          className="gap-2 justify-start"
        >
          <Unplug className="h-4 w-4" /> Fechar
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={isWorking || !selectedPort || selectedPort === health.comPort}
          onClick={handleChange}
          className="gap-2 justify-start"
        >
          <RotateCw className="h-4 w-4" /> Trocar
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={isWorking}
          onClick={handleHardReset}
          className="gap-2 justify-start"
        >
          <RotateCw className="h-4 w-4" /> Reset remoto
        </Button>
      </div>

      {pending && (
        <div className="rounded-lg border border-border bg-secondary/40 p-3 space-y-1.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            {!pending.result ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Executando: <span className="font-mono">{pending.label}</span>
              </>
            ) : pending.result.status === "done" ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-primary" />
                {pending.label} — sucesso
                {pending.result.duration_ms ? ` (${(pending.result.duration_ms / 1000).toFixed(1)}s)` : ""}
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4 text-destructive" />
                {pending.label} — {pending.result.error_message ?? pending.result.status}
              </>
            )}
          </div>
          {pending.result?.result?.data ? (
            <pre className="font-mono text-xs text-foreground bg-background rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap max-h-40">
              {JSON.stringify(pending.result.result.data, null, 2)}
            </pre>
          ) : null}
        </div>
      )}
    </div>
  );
};

export default RemotePortControl;
