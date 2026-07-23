// ─────────────────────────────────────────────────────────────────────────────
// ServerControlPanel — comandos do Servidor local (ESP_A)
// ─────────────────────────────────────────────────────────────────────────────
// Cada botão enfileira um comando type='server' priority=2 (timeout 2s) e
// mostra a resposta ao vivo (PING, STATUS, RESET, RESET_B, AUTO_RESET_ON,
// CFG:DUMP, CFG:SET).

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Server, Activity, RotateCcw, Power, FileText, Settings, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { notify } from "@/lib/notify";
import { enqueueServerCommand, type ServerCommand } from "@/lib/cfgQueue";
import { waitForCommand, type CommandResult } from "@/hooks/useCommandTracker";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";

interface PendingState { label: string; commandId: string; result?: CommandResult; }

const ServerControlPanel = () => {
  const farmId = useDefaultFarmId();
  const [param, setParam] = useState("BURST_COOLDOWN_MS");
  const [value, setValue] = useState("5000");
  const [pending, setPending] = useState<PendingState | null>(null);
  const isWorking = pending !== null && !pending.result;

  const send = async (label: string, command: ServerCommand, timeoutMs?: number) => {
    if (!farmId) { notify.fail("Servidor", "Fazenda não identificada"); return; }
    setPending({ label, commandId: "" });
    try {
      const { commandId } = await enqueueServerCommand({ farmId, command, timeoutMs });
      setPending({ label, commandId });
      const result = await waitForCommand(commandId, (timeoutMs ?? 2_000) + 4_000);
      setPending({ label, commandId, result });
      if (result.status === "executed") notify.ok("Servidor", `${label} OK`);
      else notify.fail("Servidor", `${label}: ${result.status}`);
    } catch (e) {
      setPending(null);
      notify.fail("Servidor", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Servidor (ESP_A) — comandos locais</h3>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("PING", "PING")} className="gap-2 justify-start">
          <Activity className="h-4 w-4" /> PING
        </Button>
        <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("STATUS", "STATUS", 5_000)} className="gap-2 justify-start">
          <Activity className="h-4 w-4" /> STATUS
        </Button>
        <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("CFG:DUMP", "CFG:DUMP", 5_000)} className="gap-2 justify-start">
          <FileText className="h-4 w-4" /> CFG DUMP
        </Button>
        <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("AUTO_RESET_ON", "AUTO_RESET_ON")} className="gap-2 justify-start">
          <Power className="h-4 w-4" /> AUTO_RESET_ON
        </Button>
        <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("AUTO_RESET_OFF", "AUTO_RESET_OFF")} className="gap-2 justify-start">
          <Power className="h-4 w-4" /> AUTO_RESET_OFF
        </Button>
        <Button variant="destructive" size="sm" disabled={isWorking} onClick={() => {
          if (confirm("Reiniciar o Servidor ESP_A?")) void send("RESET", "RESET");
        }} className="gap-2 justify-start">
          <RotateCcw className="h-4 w-4" /> RESET ESP_A
        </Button>
        <Button variant="destructive" size="sm" disabled={isWorking} onClick={() => {
          if (confirm("Reiniciar o ESP_B (rádio)?")) void send("RESET_B", "RESET_B");
        }} className="gap-2 justify-start">
          <RotateCcw className="h-4 w-4" /> RESET ESP_B
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          <Settings className="h-3.5 w-3.5" /> Alterar parâmetro
        </div>
        <div className="grid grid-cols-[1fr,1fr,auto] gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Parâmetro</Label>
            <Input value={param} onChange={e => setParam(e.target.value.toUpperCase())} className="font-mono text-sm" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Valor</Label>
            <Input value={value} onChange={e => setValue(e.target.value)} className="font-mono text-sm" />
          </div>
          <Button size="sm" disabled={isWorking || !param || !value} className="self-end" onClick={() => send(`CFG:SET:${param}=${value}`, { kind: "CFG_SET", param, value })}>
            Enviar
          </Button>
        </div>
      </div>

      {pending && (
        <div className="rounded-lg border border-border bg-secondary/40 p-3 space-y-1.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            {!pending.result ? (
              <><Loader2 className="h-4 w-4 animate-spin text-primary" /> Enviando: <span className="font-mono">{pending.label}</span></>
            ) : pending.result.status === "executed" ? (
              <><CheckCircle2 className="h-4 w-4 text-primary" /> {pending.label} — sucesso ({(pending.result.elapsedMs / 1000).toFixed(1)}s)</>
            ) : (
              <><XCircle className="h-4 w-4 text-destructive" /> {pending.label} — {pending.result.status}</>
            )}
          </div>
          {pending.result?.response && (
            <pre className="font-mono text-xs text-foreground bg-background rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap max-h-48">
              {pending.result.response}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

export default ServerControlPanel;
