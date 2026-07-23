// ─────────────────────────────────────────────────────────────────────────────
// RepeaterControlPanel — comandos do Repetidor (via R3)
// ─────────────────────────────────────────────────────────────────────────────
// Frame: REP:R3:<CMD>\r — type='repeater' priority=2 (timeout 10s)

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Radio, Activity, FileText, Save, Plus, Trash2, RotateCcw, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { notify } from "@/lib/notify";
import { enqueueRepeaterCommand, type RepeaterCommand } from "@/lib/cfgQueue";
import { waitForCommand, type CommandResult } from "@/hooks/useCommandTracker";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";

interface PendingState { label: string; commandId: string; result?: CommandResult; }

const RepeaterControlPanel = () => {
  const farmId = useDefaultFarmId();
  const [sValue, setSValue] = useState("3");
  const [radio, setRadio] = useState<"R1" | "R2" | "R3">("R1");
  const [nn, setNn] = useState("");
  const [pending, setPending] = useState<PendingState | null>(null);
  const isWorking = pending !== null && !pending.result;

  const send = async (label: string, command: RepeaterCommand) => {
    if (!farmId) { notify.fail("Repetidor", "Fazenda não identificada"); return; }
    setPending({ label, commandId: "" });
    try {
      const { commandId } = await enqueueRepeaterCommand({ farmId, command });
      setPending({ label, commandId });
      const result = await waitForCommand(commandId, 12_000);
      setPending({ label, commandId, result });
      if (result.status === "executed") notify.ok("Repetidor", `${label} OK`);
      else notify.fail("Repetidor", `${label}: ${result.status}`);
    } catch (e) {
      setPending(null);
      notify.fail("Repetidor", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Repetidor — comandos via R3</h3>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("PING", "PING")} className="gap-2 justify-start">
          <Activity className="h-4 w-4" /> PING
        </Button>
        <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("STATUS", "STATUS")} className="gap-2 justify-start">
          <Radio className="h-4 w-4" /> STATUS
        </Button>
        <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("CFG:DUMP", "CFG:DUMP")} className="gap-2 justify-start">
          <FileText className="h-4 w-4" /> CFG DUMP
        </Button>
        <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("CFG:SAVE", "CFG:SAVE")} className="gap-2 justify-start">
          <Save className="h-4 w-4" /> SALVAR
        </Button>
        <Button variant="destructive" size="sm" disabled={isWorking} onClick={() => {
          if (confirm("Reiniciar o Repetidor?")) void send("CFG:REBOOT", "CFG:REBOOT");
        }} className="gap-2 justify-start col-span-2">
          <RotateCcw className="h-4 w-4" /> REBOOT REPETIDOR
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2">
        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Região (S)</Label>
        <div className="flex gap-2">
          <Select value={sValue} onValueChange={setSValue}>
            <SelectTrigger className="font-mono"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[1,2,3,4,5,6,7,8,9].map(n => <SelectItem key={n} value={String(n)}>S = {n}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" disabled={isWorking} onClick={() => send(`SET_S=${sValue}`, { kind: "CFG_SET_S", value: Number(sValue) })}>Definir</Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2">
        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Gestão de bombas</Label>
        <div className="grid grid-cols-[100px,1fr] gap-2">
          <Select value={radio} onValueChange={v => setRadio(v as "R1" | "R2" | "R3")}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="R1">R1</SelectItem>
              <SelectItem value="R2">R2</SelectItem>
              <SelectItem value="R3">R3</SelectItem>
            </SelectContent>
          </Select>
          <Input value={nn} onChange={e => setNn(e.target.value.toUpperCase())} placeholder="NN (hex, ex 0A)" className="font-mono" maxLength={2} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="sm" disabled={isWorking || !nn} onClick={() => send(`ADD ${radio}:${nn}`, { kind: "CFG_ADD", radio, nn })} className="gap-2">
            <Plus className="h-4 w-4" /> Adicionar
          </Button>
          <Button variant="outline" size="sm" disabled={isWorking || !nn} onClick={() => send(`DEL ${radio}:${nn}`, { kind: "CFG_DEL", radio, nn })} className="gap-2 text-destructive">
            <Trash2 className="h-4 w-4" /> Remover
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

export default RepeaterControlPanel;
