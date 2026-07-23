// ─────────────────────────────────────────────────────────────────────────────
// RepeaterCfgDialog — modal de configuração avançada do REPETIDOR (via R3)
// ─────────────────────────────────────────────────────────────────────────────
// Acessado SEMPRE remotamente via Servidor: cfgQueue gera REP:R3:<payload>\r.
//
// Fluxo obrigatório de alteração:
//   1. CFG:LOGIN:<senha>  → OK:LOGIN
//   2. <comandos SET>
//   3. CFG:SAVE           → OK:SAVE
//   4. CFG:LOGOUT         → OK:LOGOUT
//
// Ao abrir: CFG:PING (sem login) e, se OK, LOGIN automático + CFG:DUMP para
// pré-preencher o formulário.
//
// Timeout default: 15s (mais alto pois passa pelo rádio R3).

import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Radio, Activity, FileText, Save, RotateCcw, AlertTriangle, Loader2,
  CheckCircle2, XCircle, Plus, Trash2, ListChecks, Lock, LogOut, Timer,
  HardDriveDownload, MapPin, Power,
} from "lucide-react";
import { notify } from "@/lib/notify";
import {
  enqueueRepeaterCommand,
  type RepeaterCommand,
  type RepeaterRadio,
  type RepeaterParam,
} from "@/lib/cfgQueue";
import { waitForCommand, type CommandResult } from "@/hooks/useCommandTracker";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  farmId: string;
  equipmentId?: string | null;
  equipmentName?: string;
}

interface PendingState { label: string; commandId: string; result?: CommandResult; }
type Status = "unknown" | "ok" | "fail";

const TIMING_FIELDS: { key: RepeaterParam; label: string; default: string; hint: string }[] = [
  { key: "WDT_TIMEOUT_S",        label: "WDT Timeout (s)",         default: "15",     hint: "Watchdog em segundos" },
  { key: "HEAP_MIN_BYTES",       label: "Heap Mínimo (bytes)",     default: "10240",  hint: "Reinicia se cair abaixo" },
  { key: "HEAP_CHECK_INTERVAL",  label: "Heap Check Interval (ms)", default: "60000",  hint: "Intervalo de verificação" },
  { key: "I2C_RECOVERY_MAX",     label: "I2C Recovery Max",        default: "5",      hint: "Tentativas de recovery I2C" },
  { key: "MODE_SETTLE_MS",       label: "Mode Settle (ms)",        default: "150",    hint: "Estabilização M0/M1" },
  { key: "RADIO_TX_MARGIN_MS",   label: "Radio TX Margin (ms)",    default: "100",    hint: "Margem TX" },
  { key: "AIR_GUARD_MS",         label: "Air Guard (ms)",          default: "120",    hint: "Guard time após TX" },
  { key: "PREP_WAIT_LOCAL_MS",   label: "Prep Wait Local (ms)",    default: "30",     hint: "Espera antes TX R1" },
  { key: "PREP_WAIT_I2C_MS",     label: "Prep Wait I2C (ms)",      default: "380",    hint: "Espera antes TX R2/R3" },
  { key: "POLL_B_EVERY_MS",      label: "Poll ESP B (ms)",         default: "5",      hint: "Intervalo poll ESP B" },
  { key: "DEDUP_WINDOW_MS",      label: "Dedup Window (ms)",       default: "600",    hint: "Janela de deduplicação" },
];

const DEFAULT_PASSWORD = "renovrenov";

const RepeaterCfgDialog = ({ open, onOpenChange, farmId, equipmentId, equipmentName }: Props) => {
  const [status, setStatus] = useState<Status>("unknown");
  const [logged, setLogged] = useState(false);
  const [password, setPassword] = useState(DEFAULT_PASSWORD);
  const [pending, setPending] = useState<PendingState | null>(null);
  const [dumpAppliedAt, setDumpAppliedAt] = useState<string | null>(null);

  const [sValue, setSValue] = useState("3");
  const [tables, setTables] = useState<Record<RepeaterRadio, string>>({ R1: "", R2: "", R3: "" });
  const [radio, setRadio] = useState<RepeaterRadio>("R1");
  const [nn, setNn] = useState("");
  const [bulk, setBulk] = useState("");
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(TIMING_FIELDS.map(f => [f.key, f.default])),
  );

  const isWorking = pending !== null && !pending.result;

  const sendOnce = async (label: string, command: RepeaterCommand, timeoutMs = 15_000): Promise<CommandResult | null> => {
    if (!farmId) { notify.fail("Configuração do Repetidor", "Fazenda não identificada"); return null; }
    setPending({ label, commandId: "" });
    try {
      const { commandId } = await enqueueRepeaterCommand({ farmId, equipmentId: equipmentId ?? null, command, timeoutMs });
      setPending({ label, commandId });
      const result = await waitForCommand(commandId, timeoutMs + 5_000);
      setPending({ label, commandId, result });
      return result;
    } catch (e) {
      setPending(null);
      notify.fail("Configuração do Repetidor", e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  // Garante login antes de enviar comandos protegidos
  const ensureLogin = async (): Promise<boolean> => {
    if (logged) return true;
    const result = await sendOnce("CFG:LOGIN", { kind: "LOGIN", password });
    if (result?.status === "executed") {
      setLogged(true);
      notify.ok("Configuração do Repetidor", "Sessão de configuração aberta");
      return true;
    }
    notify.fail("Configuração do Repetidor", "Falha no LOGIN do repetidor");
    return false;
  };

  // SET → SAVE → mantém sessão (LOGOUT é opcional pelo usuário)
  const sendProtected = async (label: string, command: RepeaterCommand) => {
    if (!await ensureLogin()) return;
    const r = await sendOnce(label, command);
    if (!r) return;
    if (r.status !== "executed") {
      notify.fail("Configuração do Repetidor", `${label}: ${r.status}`);
      return;
    }
    notify.ok("Configuração do Repetidor", `${label} OK (${(r.elapsedMs / 1000).toFixed(1)}s)`);
    const save = await sendOnce("CFG:SAVE", "CFG:SAVE");
    if (save?.status === "executed") notify.ok("Configuração do Repetidor", "Configuração gravada");
    else notify.warn("Configuração do Repetidor", "SAVE não confirmado — alteração pode não persistir após reboot");
  };

  // Comandos diag não exigem login
  const sendDiag = async (label: string, command: RepeaterCommand, timeoutMs?: number) => {
    const r = await sendOnce(label, command, timeoutMs);
    if (!r) return;
    if (r.status === "executed") {
      notify.ok("Configuração do Repetidor", `${label} OK (${(r.elapsedMs / 1000).toFixed(1)}s)`);
      setStatus("ok");
    } else if (r.status === "timeout") {
      notify.fail("Configuração do Repetidor", `${label}: sem resposta`);
      setStatus("fail");
    } else if (r.status === "error") {
      notify.fail("Configuração do Repetidor", `${label}: ${r.errorMessage ?? "erro"}`);
    }
  };

  const applyDump = (frame: string): number => {
    let count = 0;
    const next = { ...params };
    const tabs: Record<RepeaterRadio, string> = { ...tables };
    let sFound: string | null = null;
    frame.split(/[\n,;]+/).forEach((line) => {
      const t = line.trim();
      if (!t) return;
      // S=N
      const sm = t.match(/^S\s*=\s*(\d+)/i);
      if (sm) { sFound = sm[1]; count++; return; }
      // R1: NN,NN ou R1=NN,NN
      const rm = t.match(/^R([123])\s*[:=]\s*(.+)$/i);
      if (rm) {
        const r = `R${rm[1]}` as RepeaterRadio;
        tabs[r] = rm[2].trim();
        count++;
        return;
      }
      // PARAM=valor
      const eq = t.indexOf("=");
      if (eq > 0) {
        const k = t.slice(0, eq).trim().replace(/^.*:/, "").toUpperCase();
        const v = t.slice(eq + 1).trim();
        if (TIMING_FIELDS.some(f => f.key === k)) {
          next[k] = v;
          count++;
        }
      }
    });
    setParams(next);
    setTables(tabs);
    if (sFound) setSValue(sFound);
    return count;
  };

  const requestDump = async () => {
    if (!await ensureLogin()) { setStatus("fail"); return; }
    const r = await sendOnce("CFG:DUMP", "CFG:DUMP", 15_000);
    if (r?.status === "executed" && r.response) {
      const n = applyDump(r.response);
      if (n > 0) {
        setDumpAppliedAt(new Date().toLocaleTimeString());
        notify.ok("Configuração do Repetidor", `DUMP carregado: ${n} valores aplicados`);
        setStatus("ok");
      } else {
        notify.warn("Configuração do Repetidor", "DUMP recebido, mas nenhum valor reconhecido");
        setStatus("ok");
      }
    } else {
      notify.fail("Configuração do Repetidor", "Repetidor não respondeu ao DUMP");
      setStatus("fail");
    }
  };

  // PING ao abrir; se OK → login + dump
  useEffect(() => {
    if (!open || !farmId) return;
    setStatus("unknown");
    setLogged(false);
    setDumpAppliedAt(null);
    (async () => {
      const r = await sendOnce("CFG:PING", "PING");
      if (r?.status === "executed") {
        setStatus("ok");
        await requestDump();
      } else {
        setStatus("fail");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, farmId, equipmentId]);

  const sendParam = (key: RepeaterParam) => {
    const raw = params[key]?.trim() ?? "";
    if (raw === "") { notify.fail("Configuração do Repetidor", "Informe um valor"); return; }
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) { notify.fail("Configuração do Repetidor", "Valor inválido"); return; }
    void sendProtected(`${key}=${num}`, { kind: "CFG_SET_PARAM", param: key, value: num });
  };

  const close = async () => {
    if (logged) {
      await sendOnce("CFG:LOGOUT", "LOGOUT");
      setLogged(false);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!isWorking && !v) void close(); else if (!isWorking) onOpenChange(v); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <Radio className="h-5 w-5 text-primary" /> Configuração do Repetidor (via R3)
            {equipmentName && <Badge variant="outline" className="font-mono">{equipmentName}</Badge>}
            {status === "ok" && <Badge className="bg-primary/20 text-primary border-primary/40">Conectado</Badge>}
            {status === "fail" && <Badge variant="destructive">Sem resposta</Badge>}
            {status === "unknown" && <Badge variant="outline">Verificando…</Badge>}
            {logged && <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/40 gap-1"><Lock className="h-3 w-3" /> Logado</Badge>}
          </DialogTitle>
          <DialogDescription>
            Comandos enviados pelo Servidor pelo rádio R3 (encapsulados em <span className="font-mono">~RCR~…~RCR~</span>). Alterações exigem LOGIN e são gravadas via CFG:SAVE automaticamente.
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
            <Button size="sm" variant="outline" disabled={isWorking} onClick={() => sendDiag("CFG:PING", "PING")}>Tentar novamente</Button>
          </div>
        )}

        <Tabs defaultValue="diag" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="diag" className="gap-1"><Activity className="h-3 w-3" /> Diag.</TabsTrigger>
            <TabsTrigger value="region" className="gap-1"><MapPin className="h-3 w-3" /> Região</TabsTrigger>
            <TabsTrigger value="tables" className="gap-1"><ListChecks className="h-3 w-3" /> Tabelas NN</TabsTrigger>
            <TabsTrigger value="timings" className="gap-1"><Timer className="h-3 w-3" /> Timings</TabsTrigger>
          </TabsList>

          {/* DIAG */}
          <TabsContent value="diag" className="space-y-3 mt-4">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5 col-span-2">
                <Label className="text-xs">Senha de configuração</Label>
                <div className="flex gap-2">
                  <Input value={password} type="password" onChange={(e) => setPassword(e.target.value)} className="font-mono" />
                  <Button size="sm" disabled={isWorking || !password} onClick={async () => {
                    const r = await sendOnce("CFG:LOGIN", { kind: "LOGIN", password });
                    if (r?.status === "executed") { setLogged(true); notify.ok("Configuração do Repetidor", "LOGIN OK"); }
                    else notify.fail("Configuração do Repetidor", "Falha no LOGIN");
                  }} className="gap-2"><Lock className="h-4 w-4" /> Login</Button>
                  <Button size="sm" variant="outline" disabled={isWorking || !logged} onClick={async () => {
                    const r = await sendOnce("CFG:LOGOUT", "LOGOUT");
                    if (r?.status === "executed") { setLogged(false); notify.ok("Configuração do Repetidor", "LOGOUT OK"); }
                  }} className="gap-2"><LogOut className="h-4 w-4" /> Logout</Button>
                </div>
              </div>
            </div>
            <Separator />
            <div className="grid grid-cols-3 gap-2">
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => sendDiag("CFG:PING", "PING")} className="gap-2"><Activity className="h-4 w-4" /> PING</Button>
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => sendDiag("STATUS", "STATUS", 15_000)} className="gap-2"><Activity className="h-4 w-4" /> STATUS</Button>
              <Button variant="outline" size="sm" disabled={isWorking} onClick={requestDump} className="gap-2"><FileText className="h-4 w-4" /> DUMP</Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => {
                if (confirm("Carregar configurações da flash (CFG:LOAD)?")) void sendProtected("CFG:LOAD", "CFG:LOAD");
              }} className="gap-2"><HardDriveDownload className="h-4 w-4" /> Carregar Flash</Button>
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => {
                if (confirm("Salvar configurações na flash (CFG:SAVE)?")) void sendProtected("CFG:SAVE", "CFG:SAVE");
              }} className="gap-2"><Save className="h-4 w-4" /> Salvar Flash</Button>
            </div>
            <Separator />
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => {
                if (confirm("Reiniciar o Repetidor (ESP A)?")) void sendDiag("RESET", "RESET", 15_000);
              }} className="gap-2"><RotateCcw className="h-4 w-4" /> Reiniciar Repetidor</Button>
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => {
                if (confirm("Reiniciar o ESP_B do Repetidor?")) void sendDiag("RESET_B", "RESET_B", 15_000);
              }} className="gap-2"><Power className="h-4 w-4" /> Reiniciar ESP_B</Button>
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={isWorking}
              onClick={() => {
                if (confirm("CFG:RESET apaga TODAS as configurações do Repetidor. Continuar?"))
                  void sendProtected("CFG:RESET", "CFG:RESET");
              }}
              className="w-full gap-2"
            >
              <AlertTriangle className="h-4 w-4" /> Reset de fábrica (CFG:RESET)
            </Button>
          </TabsContent>

          {/* REGIÃO */}
          <TabsContent value="region" className="space-y-3 mt-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Região (S) — grupo de bombas atendido</Label>
              <div className="flex gap-2">
                <Select value={sValue} onValueChange={setSValue}>
                  <SelectTrigger className="font-mono"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[1,2,3,4,5,6,7,8,9].map(n => <SelectItem key={n} value={String(n)}>S = {n}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button size="sm" disabled={isWorking} onClick={() => sendProtected(`SET_S=${sValue}`, { kind: "CFG_SET_S", value: Number(sValue) })}>
                  Definir
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">Valor de 1 a 9. Reinicie o Repetidor para garantir aplicação completa.</p>
            </div>
          </TabsContent>

          {/* TABELAS NN */}
          <TabsContent value="tables" className="space-y-4 mt-4">
            <div className="rounded-md border border-border bg-secondary/30 p-3 space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tabelas atuais (do DUMP)</Label>
              {(["R1","R2","R3"] as RepeaterRadio[]).map(r => (
                <div key={r} className="flex items-start gap-2">
                  <Badge variant="outline" className="font-mono mt-0.5">{r}</Badge>
                  <code className="text-xs font-mono break-all flex-1">{tables[r] || "—"}</code>
                  <Button size="sm" variant="ghost" disabled={isWorking} onClick={() => sendDiag(`LIST ${r}`, { kind: "CFG_LIST", radio: r })}>
                    Listar
                  </Button>
                </div>
              ))}
            </div>

            <div className="rounded-md border border-border bg-secondary/30 p-3 space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Adicionar / Remover NN individual</Label>
              <div className="grid grid-cols-[100px,1fr] gap-2">
                <Select value={radio} onValueChange={(v) => setRadio(v as RepeaterRadio)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="R1">R1</SelectItem>
                    <SelectItem value="R2">R2</SelectItem>
                    <SelectItem value="R3">R3</SelectItem>
                  </SelectContent>
                </Select>
                <Input value={nn} onChange={(e) => setNn(e.target.value.toUpperCase())} placeholder="NN hex (ex: 0A)" className="font-mono" maxLength={2} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" size="sm" disabled={isWorking || !nn} onClick={() => sendProtected(`ADD ${radio}:${nn}`, { kind: "CFG_ADD", radio, nn })} className="gap-2">
                  <Plus className="h-4 w-4" /> Adicionar
                </Button>
                <Button variant="outline" size="sm" disabled={isWorking || !nn} onClick={() => sendProtected(`DEL ${radio}:${nn}`, { kind: "CFG_DEL", radio, nn })} className="gap-2 text-destructive">
                  <Trash2 className="h-4 w-4" /> Remover
                </Button>
              </div>
            </div>

            <div className="rounded-md border border-border bg-secondary/30 p-3 space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Definir tabela completa</Label>
              <div className="grid grid-cols-[100px,1fr] gap-2">
                <Select value={radio} onValueChange={(v) => setRadio(v as RepeaterRadio)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="R1">R1</SelectItem>
                    <SelectItem value="R2">R2</SelectItem>
                    <SelectItem value="R3">R3</SelectItem>
                  </SelectContent>
                </Select>
                <Input value={bulk} onChange={(e) => setBulk(e.target.value.toUpperCase())} placeholder="01,02,0A,FF" className="font-mono" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" size="sm" disabled={isWorking || !bulk} onClick={() => {
                  const list = bulk.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
                  if (list.length === 0) { notify.fail("Configuração do Repetidor", "Liste pelo menos um NN"); return; }
                  if (list.length > 128) { notify.fail("Configuração do Repetidor", "Máximo 128 NNs por tabela"); return; }
                  if (!list.every(n => /^[0-9A-F]{1,2}$/i.test(n))) { notify.fail("Configuração do Repetidor", "NNs devem ser hex 00..FF"); return; }
                  void sendProtected(`SET ${radio}=${list.length} NNs`, { kind: "CFG_SET_TABLE", radio, nns: list });
                }} className="gap-2">
                  Substituir tabela {radio}
                </Button>
                <Button variant="outline" size="sm" disabled={isWorking} onClick={() => {
                  if (confirm(`Limpar TODOS os NNs do rádio ${radio}?`))
                    void sendProtected(`CLEAR ${radio}`, { kind: "CFG_CLEAR", radio });
                }} className="gap-2 text-destructive">
                  <Trash2 className="h-4 w-4" /> Limpar {radio}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">Hex 00..FF, separados por vírgula ou espaço. Máx 128.</p>
            </div>
          </TabsContent>

          {/* TIMINGS */}
          <TabsContent value="timings" className="space-y-3 mt-4">
            <p className="text-xs text-muted-foreground">Cada alteração faz LOGIN→SET→SAVE automaticamente.</p>
            <div className="grid grid-cols-2 gap-3">
              {TIMING_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label className="text-xs">{f.label}</Label>
                  <div className="flex gap-2">
                    <Input
                      value={params[f.key] ?? ""}
                      onChange={(e) => setParams((s) => ({ ...s, [f.key]: e.target.value }))}
                      className="font-mono text-sm"
                      placeholder={f.default}
                      inputMode="numeric"
                    />
                    <Button size="sm" disabled={isWorking} onClick={() => sendParam(f.key)}>OK</Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">{f.hint}</p>
                </div>
              ))}
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

export default RepeaterCfgDialog;
