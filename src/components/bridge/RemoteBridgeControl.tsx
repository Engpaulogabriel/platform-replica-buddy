// ─────────────────────────────────────────────────────────────────────────────
// RemoteBridgeControl — controle remoto do agente Electron via agent_commands
// ─────────────────────────────────────────────────────────────────────────────
// Permite ao operador, pelo interface web, executar ações no .exe instalado no PC
// da fazenda sem precisar de acesso físico:
//   • Reset / reinicialização da bridge (hard_reset_bridge)
//   • Reabrir porta COM (close + open)
//   • Listar portas COM disponíveis (preenche painel inline)
//   • Trocar porta COM — clique "Usar esta porta" em cada linha (admin)
//   • Pausar / retomar polling
//
// Fluxo de troca de porta:
//   1) "Listar portas COM" → preenche painel inline com as portas detectadas
//      no PC da fazenda. A porta atual é destacada com badge "ATUAL".
//   2) "Usar esta porta" em uma porta diferente → modal de confirmação.
//   3) Confirmar → UPDATE agent_config (fonte da verdade) +
//      comando change_port para reconexão IMEDIATA (não espera hot-reload 60s).

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  RefreshCw, Power, RotateCw, ListChecks, PauseCircle, PlayCircle,
  Loader2, ArrowRightLeft, CheckCircle2, Usb,
} from "lucide-react";
import { enqueueAgentCommand, runAgentCommand, type AgentCmdKind, type AgentCmdResult } from "@/lib/agentCommands";
import { notify } from "@/lib/notify";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFarmAccess } from "@/hooks/useFarmAccess";

interface Props {
  farmId: string | null;
  comPort: string | null;
}

const KIND_LABEL: Record<AgentCmdKind, string> = {
  open_port: "Abrir porta",
  close_port: "Fechar porta",
  change_port: "Trocar porta",
  hard_reset_bridge: "Reset da bridge",
  set_log_level: "Nível de log",
  send_manual_frame: "Frame manual",
  pause_polling: "Pausar polling",
  resume_polling: "Retomar polling",
  list_ports: "Listar portas",
  agent_restart: "Reiniciar agente",
  update_agent: "Atualizar agente",
  force_reboot: "Reboot forçado",
  force_rollback: "Rollback",
  start_log_stream: "Iniciar stream de logs",
  renew_log_stream: "Renovar stream de logs",
  stop_log_stream: "Parar stream de logs",
};

interface PortInfo {
  device: string;
  description?: string;
}

function parsePorts(data: unknown): PortInfo[] {
  if (!data || typeof data !== "object") return [];
  const d = data as { ports?: unknown };
  const list = Array.isArray(d.ports) ? d.ports : [];
  const out: PortInfo[] = [];
  for (const p of list) {
    if (typeof p === "string") {
      if (p) out.push({ device: p });
    } else if (p && typeof p === "object") {
      const o = p as { device?: string; path?: string; name?: string; description?: string; manufacturer?: string };
      const dev = o.device ?? o.path ?? o.name ?? "";
      if (dev) out.push({ device: dev, description: o.description ?? o.manufacturer });
    }
  }
  return out;
}

export default function RemoteBridgeControl({ farmId, comPort }: Props) {
  const [running, setRunning] = useState<AgentCmdKind | null>(null);
  const [lastResult, setLastResult] = useState<{ kind: AgentCmdKind; result: AgentCmdResult } | null>(null);
  const { role, isPlatformAdmin } = useFarmAccess();
  const canChangePort = isPlatformAdmin || role === "supervisor";

  // Porta atualmente em uso (atualizada após troca bem-sucedida, sem precisar de reload).
  const [currentPort, setCurrentPort] = useState<string | null>(comPort);
  const [availablePorts, setAvailablePorts] = useState<PortInfo[] | null>(null);
  const [portsListedAt, setPortsListedAt] = useState<Date | null>(null);

  // Estado do modal de confirmação.
  const [confirmPort, setConfirmPort] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function dispatch(kind: AgentCmdKind, payload: Record<string, unknown> = {}, timeoutMs = 20_000) {
    if (!farmId) {
      notify.fail("Bridge", "Fazenda não identificada");
      return null;
    }
    setRunning(kind);
    try {
      const { result } = await runAgentCommand({ farmId, kind, payload, timeoutMs });
      setLastResult({ kind, result });
      if (result.status === "done") {
        notify.ok("Bridge", `${KIND_LABEL[kind]} executado em ${result.duration_ms ?? "?"} ms`);
      } else if (result.status === "expired") {
        notify.fail("Bridge", `${KIND_LABEL[kind]}: agente não respondeu (offline?)`);
      } else {
        notify.fail("Bridge", `${KIND_LABEL[kind]} falhou: ${result.error_message ?? "erro desconhecido"}`);
      }
      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.fail("Bridge", `Falha ao enviar: ${msg}`);
      return null;
    } finally {
      setRunning(null);
    }
  }

  async function handleListPorts() {
    const result = await dispatch("list_ports", {}, 15_000);
    if (result?.status === "done") {
      const ports = parsePorts(result?.result?.data);
      setAvailablePorts(ports);
      setPortsListedAt(new Date());
    }
  }

  async function confirmChangePort() {
    if (!confirmPort || !farmId) return;
    setConfirming(true);
    try {
      // 1) Persiste em agent_config (fonte da verdade — sobrevive a restart e hot-reload de 60s).
      const { supabase } = await import("@/integrations/supabase/client");
      const { error: upErr } = await supabase
        .from("agent_config")
        .upsert(
          { farm_id: farmId, serial_port: confirmPort, updated_at: new Date().toISOString() },
          { onConflict: "farm_id" },
        );
      if (upErr) {
        notify.fail("Bridge", `Falha ao salvar nova porta: ${upErr.message}`);
        return;
      }
      // 2) Dispara comando para reconexão IMEDIATA (sem esperar o ciclo de 60s).
      const result = await dispatch("change_port", { port: confirmPort }, 25_000);
      if (result?.status === "done") {
        notify.ok("Bridge", `Porta alterada para ${confirmPort} — bridge reconectada`);
        setCurrentPort(confirmPort);
      } else if (result?.status === "expired") {
        notify.ok("Bridge", `Porta ${confirmPort} salva — agente aplicará em até 60s ao reconectar`);
        setCurrentPort(confirmPort);
      } else {
        // erro real (ex: rollback do agente) — não atualiza currentPort
        notify.fail("Bridge", `Troca para ${confirmPort} falhou — ${result?.error_message ?? "agente reverteu"}`);
      }
      setConfirmPort(null);
    } finally {
      setConfirming(false);
    }
  }

  const isRunning = (k: AgentCmdKind) => running === k;
  const anyRunning = running !== null;

  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-primary" />
            Controle remoto da Bridge
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Execute ações no agente <strong>.exe</strong> instalado no PC da fazenda sem acesso físico.
            Útil quando a porta COM travou ou após troca de cabo USB.
          </p>
        </div>
        <span className="text-[11px] text-muted-foreground font-mono">
          Porta atual: <span className="text-foreground font-semibold">{currentPort ?? "—"}</span>
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <Button
          variant="destructive"
          onClick={async () => {
            if (farmId) void enqueueAgentCommand({ farmId, kind: "agent_restart", payload: {}, expiresInSec: 300 });
            void dispatch("force_reboot", {}, 30_000);
            await dispatch("hard_reset_bridge");
          }}
          disabled={anyRunning}
          className="justify-start"
        >
          {isRunning("hard_reset_bridge") || isRunning("force_reboot") ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
          Reset / Reiniciar bridge
        </Button>

        <Button
          variant="secondary"
          onClick={async () => {
            await dispatch("close_port");
            if (currentPort) await dispatch("open_port", { path: currentPort });
          }}
          disabled={anyRunning}
          className="justify-start"
        >
          {isRunning("close_port") || isRunning("open_port") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
          Reabrir porta COM
        </Button>

        <Button
          variant="outline"
          onClick={handleListPorts}
          disabled={anyRunning}
          className="justify-start"
        >
          {isRunning("list_ports") ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}
          Listar portas COM
        </Button>

        <Button
          variant="outline"
          onClick={() => dispatch("pause_polling")}
          disabled={anyRunning}
          className="justify-start"
        >
          {isRunning("pause_polling") ? <Loader2 className="h-4 w-4 animate-spin" /> : <PauseCircle className="h-4 w-4" />}
          Pausar polling
        </Button>

        <Button
          variant="outline"
          onClick={() => dispatch("resume_polling")}
          disabled={anyRunning}
          className="justify-start"
        >
          {isRunning("resume_polling") ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
          Retomar polling
        </Button>
      </div>

      {/* Lista inline de portas (após clicar "Listar portas COM") */}
      {availablePorts !== null && (
        <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Usb className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold">Portas disponíveis no PC da fazenda</span>
            </div>
            {portsListedAt && (
              <span className="text-[10px] text-muted-foreground font-mono">
                consultado às {portsListedAt.toLocaleTimeString("pt-BR")}
              </span>
            )}
          </div>

          {availablePorts.length === 0 ? (
            <p className="text-sm text-destructive">
              Nenhuma porta COM detectada. Verifique se o cabo USB do Servidor está conectado.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {availablePorts.map((p) => {
                const isCurrent = p.device === currentPort;
                return (
                  <li
                    key={p.device}
                    className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 ${
                      isCurrent
                        ? "border-primary/50 bg-primary/5"
                        : "border-border bg-background/40 hover:bg-background/70"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isCurrent ? (
                        <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                      ) : (
                        <span className="h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-foreground">{p.device}</span>
                          {isCurrent && (
                            <Badge className="bg-primary text-primary-foreground text-[10px] px-1.5 py-0">
                              ATUAL
                            </Badge>
                          )}
                        </div>
                        {p.description && (
                          <p className="text-[11px] text-muted-foreground truncate">{p.description}</p>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={isCurrent ? "ghost" : "outline"}
                      disabled={isCurrent || anyRunning || !canChangePort}
                      onClick={() => setConfirmPort(p.device)}
                      title={
                        !canChangePort
                          ? "Apenas administradores podem trocar a porta"
                          : isCurrent
                          ? "Esta é a porta em uso"
                          : `Trocar para ${p.device}`
                      }
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
                      {isCurrent ? "Em uso" : "Usar esta porta"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          {!canChangePort && availablePorts.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Você está em modo somente leitura. Apenas administradores podem trocar a porta.
            </p>
          )}
        </div>
      )}

      {lastResult && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-foreground">
              Último: {KIND_LABEL[lastResult.kind]}
            </span>
            <span
              className={
                lastResult.result.status === "done"
                  ? "text-primary font-mono"
                  : lastResult.result.status === "expired"
                  ? "text-amber-600 dark:text-amber-400 font-mono"
                  : "text-destructive font-mono"
              }
            >
              {lastResult.result.status.toUpperCase()}
              {lastResult.result.duration_ms != null && ` · ${lastResult.result.duration_ms}ms`}
            </span>
          </div>
          {lastResult.result.error_message && (
            <div className="text-destructive">{lastResult.result.error_message}</div>
          )}
          {lastResult.result.result?.data != null && (
            <pre className="text-[10px] font-mono text-muted-foreground bg-background/50 rounded p-2 overflow-auto max-h-40">
              {JSON.stringify(lastResult.result.result.data, null, 2)}
            </pre>
          )}
          {lastResult.result.result?.response && (
            <div className="text-muted-foreground font-mono break-all">
              ↪ {lastResult.result.result.response}
            </div>
          )}
        </div>
      )}

      {/* Modal de confirmação da troca */}
      <Dialog
        open={confirmPort !== null}
        onOpenChange={(v) => { if (!confirming && !v) setConfirmPort(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5 text-primary" />
              Trocar porta COM
            </DialogTitle>
            <DialogDescription>
              Trocar para <strong className="font-mono text-foreground">{confirmPort}</strong>?
              A comunicação será interrompida momentaneamente enquanto a bridge fecha
              <span className="font-mono"> {currentPort ?? "—"}</span> e reabre em
              <span className="font-mono"> {confirmPort}</span>.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            Se a porta nova não responder, o agente reverterá automaticamente para
            <span className="font-mono"> {currentPort ?? "—"}</span> e reportará erro.
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmPort(null)} disabled={confirming}>
              Cancelar
            </Button>
            <Button onClick={confirmChangePort} disabled={confirming}>
              {confirming ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ArrowRightLeft className="h-4 w-4 mr-2" />}
              Confirmar troca
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
