// ─────────────────────────────────────────────────────────────────────────────
// ServerCfgDialog — modal de configuração avançada do SERVIDOR (ESP_A)
// ─────────────────────────────────────────────────────────────────────────────
// Frame plain RS-485 terminado em \r (sem wrapper [TSNN_CFG_]). O Servidor faz
// AUTO-SAVE — não é necessário enviar SAVE separado.
//
// Ao abrir → envia CFG:DUMP\r para pré-preencher os campos.
// Ações de manutenção (RESET, RESET_B, CFG:DEFAULT, DEBUG) exigem confirmação.
//
// Timeout default: 8s para SET, 5s para PING/STATUS, 12s para DUMP.

import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Server, Activity, FileText, RotateCcw, Power, AlertTriangle, Loader2,
  CheckCircle2, XCircle, Settings2, Bug, Timer,
} from "lucide-react";
import { notify } from "@/lib/notify";
import { enqueueServerCommand, type ServerCommand, type ServerParam } from "@/lib/cfgQueue";
import { waitForCommand, type CommandResult } from "@/hooks/useCommandTracker";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  farmId: string;
}

interface PendingState { label: string; commandId: string; result?: CommandResult; }

type Status = "unknown" | "ok" | "fail";

const TIMING_FIELDS: { key: ServerParam; label: string; default?: string; hint: string; min?: number; max?: number }[] = [
  { key: "COALESCE_MS",         label: "Coalescência (ms)",        default: "0",     hint: "Coalescência de frames" },
  { key: "DEDUP_WINDOW_MS",     label: "Deduplicação (ms)",        default: "600",   hint: "Janela de dedup" },
  { key: "FSM_MAX_STUCK_MS",    label: "FSM Max Stuck (ms)",       hint: "Máximo tempo stuck na FSM" },
  { key: "I2C_RECOVERY_MAX",    label: "I2C Recovery Max",         hint: "Tentativas de recovery I2C" },
  { key: "BURST_COOLDOWN_MS",   label: "Burst Cooldown (ms)",      hint: "Cooldown modo burst" },
  { key: "MODE_SETTLE_MS",      label: "Mode Settle (ms)",         hint: "Estabilização modo rádio" },
  { key: "RADIO_TX_MARGIN_MS",  label: "Radio TX Margin (ms)",     hint: "Margem TX" },
  { key: "AIR_GUARD_MS",        label: "Air Guard (ms)",           hint: "Guard time após TX" },
  { key: "RX_FRAME_TIMEOUT_MS", label: "RX Frame Timeout (ms)",    hint: "Timeout frame RX" },
  { key: "POLL_B_EVERY_MS",     label: "Poll ESP B (ms)",          hint: "Intervalo poll ESP B" },
  { key: "PREP_WAIT_LOCAL_MS",  label: "Prep Wait Local (ms)",     default: "30",    hint: "Espera antes TX local" },
  { key: "PREP_WAIT_I2C_MS",    label: "Prep Wait I2C (ms)",       default: "380",   hint: "Espera antes TX I2C" },
  { key: "ESP_B_AUTO_RESET_MS", label: "Auto Reset ESP B (ms)",    default: "60000", hint: "Tempo sem I2C para reset" },
];

const ServerCfgDialog = ({ open, onOpenChange, farmId }: Props) => {
  const [status, setStatus] = useState<Status>("unknown");
  const [pending, setPending] = useState<PendingState | null>(null);
  const [dumpAppliedAt, setDumpAppliedAt] = useState<string | null>(null);
  const [autoReset, setAutoReset] = useState<boolean>(true);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(TIMING_FIELDS.map(f => [f.key, f.default ?? ""])),
  );

  const isWorking = pending !== null && !pending.result;

  const sendOnce = async (label: string, command: ServerCommand, timeoutMs?: number): Promise<CommandResult | null> => {
    if (!farmId) { notify.fail("Servidor", "Fazenda não identificada"); return null; }
    setPending({ label, commandId: "" });
    try {
      const { commandId } = await enqueueServerCommand({ farmId, command, timeoutMs });
      setPending({ label, commandId });
      const result = await waitForCommand(commandId, (timeoutMs ?? 8_000) + 4_000);
      setPending({ label, commandId, result });
      return result;
    } catch (e) {
      setPending(null);
      notify.fail("Servidor", e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const send = async (label: string, command: ServerCommand, timeoutMs?: number) => {
    const result = await sendOnce(label, command, timeoutMs);
    if (!result) return;
    if (result.status === "executed") {
      notify.ok("Servidor", `${label} OK (${(result.elapsedMs / 1000).toFixed(1)}s) — auto-salvo`);
      setStatus("ok");
    } else if (result.status === "timeout") {
      notify.fail("Servidor", `${label}: sem resposta do servidor`);
      setStatus("fail");
    } else if (result.status === "error") {
      notify.fail("Servidor", `${label}: ${result.errorMessage ?? "erro"}`);
    }
  };

  const applyDump = (frame: string): number => {
    // Aceita pares CHAVE=VALOR separados por linhas, vírgulas ou espaços
    const next: Record<string, string> = { ...values };
    let count = 0;
    let autoResetSeen: boolean | null = null;
    frame.split(/[\n,;]+/).forEach((line) => {
      const eq = line.indexOf("=");
      if (eq <= 0) return;
      const k = line.slice(0, eq).trim().replace(/^.*:/, "").toUpperCase();
      const v = line.slice(eq + 1).trim();
      if (!k || v === "") return;
      if (k === "AUTO_RESET") {
        autoResetSeen = /^(ON|1|TRUE|YES)$/i.test(v);
        count++;
        return;
      }
      const field = TIMING_FIELDS.find(f => f.key === k);
      if (field) { next[k] = v; count++; }
    });
    setValues(next);
    if (autoResetSeen !== null) setAutoReset(autoResetSeen);
    return count;
  };

  const requestDump = async () => {
    const result = await sendOnce("CFG:DUMP", "CFG:DUMP", 12_000);
    if (result?.status === "executed" && result.response) {
      const n = applyDump(result.response);
      if (n > 0) {
        setDumpAppliedAt(new Date().toLocaleTimeString());
        setStatus("ok");
        notify.ok("Servidor", `DUMP carregado: ${n} parâmetros aplicados`);
      } else {
        notify.warn("Servidor", "DUMP recebido, mas nenhum parâmetro reconhecido");
      }
    } else if (result?.status === "executed") {
      setStatus("ok");
    } else {
      setStatus("fail");
      notify.fail("Servidor", "Servidor não respondeu ao DUMP");
    }
  };

  // Auto-DUMP ao abrir
  useEffect(() => {
    if (!open || !farmId) return;
    setStatus("unknown");
    setDumpAppliedAt(null);
    void requestDump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, farmId]);

  const sendParam = (key: ServerParam) => {
    const raw = values[key]?.trim() ?? "";
    if (raw === "") { notify.fail("Servidor", "Informe um valor"); return; }
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) { notify.fail("Servidor", "Valor inválido"); return; }
    void send(`${key}=${num}`, { kind: "CFG_SET", param: key, value: num }, 8_000);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!isWorking) onOpenChange(v); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" /> Configuração do Servidor (ESP_A)
            {status === "ok" && <Badge className="bg-primary/20 text-primary border-primary/40">Conectado</Badge>}
            {status === "fail" && <Badge variant="destructive">Sem resposta</Badge>}
            {status === "unknown" && <Badge variant="outline">Verificando…</Badge>}
          </DialogTitle>
          <DialogDescription>
            Comandos texto puro via RS-485 (terminados em <span className="font-mono">\r</span>). O Servidor faz <strong>auto-save</strong> — não é necessário SAVE separado.
          </DialogDescription>
        </DialogHeader>

        {dumpAppliedAt && (
          <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
            <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
            <span>Configuração atual carregada via CFG:DUMP às <span className="font-mono">{dumpAppliedAt}</span></span>
          </div>
        )}

        {status === "fail" && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
            <span className="flex items-center gap-2"><XCircle className="h-4 w-4 text-destructive" /> Equipamento não respondeu</span>
            <Button size="sm" variant="outline" disabled={isWorking} onClick={requestDump}>
              Tentar ler novamente
            </Button>
          </div>
        )}

        <Tabs defaultValue="diag" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="diag" className="gap-1"><Activity className="h-3 w-3" /> Diagnóstico</TabsTrigger>
            <TabsTrigger value="timings" className="gap-1"><Timer className="h-3 w-3" /> Timings</TabsTrigger>
            <TabsTrigger value="advanced" className="gap-1"><Settings2 className="h-3 w-3" /> Avançado</TabsTrigger>
          </TabsList>

          {/* DIAG */}
          <TabsContent value="diag" className="space-y-3 mt-4">
            <p className="text-xs text-muted-foreground">Comandos sem parâmetro. Resposta esperada começa com <span className="font-mono">OK:</span>.</p>
            <div className="grid grid-cols-3 gap-2">
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("PING", "PING", 5_000)} className="gap-2"><Activity className="h-4 w-4" /> PING</Button>
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("STATUS", "STATUS", 8_000)} className="gap-2"><Activity className="h-4 w-4" /> STATUS</Button>
              <Button variant="outline" size="sm" disabled={isWorking} onClick={requestDump} className="gap-2"><FileText className="h-4 w-4" /> DUMP</Button>
            </div>
            <Separator />
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => {
                if (confirm("Reiniciar o Servidor (ESP_A)? A comunicação ficará indisponível por alguns segundos."))
                  void send("RESET ESP_A", "RESET");
              }} className="gap-2"><RotateCcw className="h-4 w-4" /> Reiniciar Servidor</Button>
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => {
                if (confirm("Reiniciar o ESP_B (rádio)?")) void send("RESET ESP_B", "RESET_B");
              }} className="gap-2"><Power className="h-4 w-4" /> Reiniciar ESP_B</Button>
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={isWorking}
              onClick={() => {
                if (confirm("CFG:DEFAULT restaura TODOS os parâmetros do Servidor para o padrão de fábrica. Continuar?"))
                  void send("CFG:DEFAULT", "CFG:DEFAULT", 8_000);
              }}
              className="w-full gap-2"
            >
              <AlertTriangle className="h-4 w-4" /> Reset de fábrica (CFG:DEFAULT)
            </Button>
          </TabsContent>

          {/* TIMINGS */}
          <TabsContent value="timings" className="space-y-3 mt-4">
            <p className="text-xs text-muted-foreground">Cada alteração é gravada automaticamente pelo Servidor.</p>
            <div className="grid grid-cols-2 gap-3">
              {TIMING_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label className="text-xs">{f.label}</Label>
                  <div className="flex gap-2">
                    <Input
                      value={values[f.key] ?? ""}
                      onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
                      className="font-mono text-sm"
                      placeholder={f.default ?? "—"}
                      inputMode="numeric"
                    />
                    <Button size="sm" disabled={isWorking} onClick={() => sendParam(f.key)}>OK</Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">{f.hint}</p>
                </div>
              ))}
            </div>
          </TabsContent>

          {/* AVANÇADO */}
          <TabsContent value="advanced" className="space-y-3 mt-4">
            <div className="flex items-center justify-between rounded-md border border-border bg-secondary/30 px-3 py-3">
              <div>
                <Label className="text-sm font-medium">Auto-Reset do ESP_B</Label>
                <p className="text-[11px] text-muted-foreground">Liga/desliga o reset automático quando o I2C trava.</p>
              </div>
              <Switch
                checked={autoReset}
                disabled={isWorking}
                onCheckedChange={(checked) => {
                  setAutoReset(checked);
                  void send(checked ? "AUTO_RESET=ON" : "AUTO_RESET=OFF", { kind: "CFG_SET", param: "AUTO_RESET", value: checked ? "ON" : "OFF" });
                }}
              />
            </div>

            <div className="rounded-md border border-border bg-secondary/30 p-3 space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                <Bug className="h-3.5 w-3.5" /> Modo Debug (HEX)
              </Label>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("DEBUG ON", "DEBUG", 5_000)} className="gap-2">
                  <Bug className="h-4 w-4" /> Ligar Debug
                </Button>
                <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("DEBUG OFF", "DEBUG_OFF", 5_000)} className="gap-2">
                  <Bug className="h-4 w-4" /> Desligar Debug
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">Imprime cada frame recebido em hexadecimal nos logs do agente.</p>
            </div>
          </TabsContent>
        </Tabs>

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
      </DialogContent>
    </Dialog>
  );
};

export default ServerCfgDialog;
