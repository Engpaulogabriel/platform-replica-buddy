// PlatformSerialTerminal — Terminal Serial Remoto (substitui o Hércules).
// Área restrita (/platform, platform_admin). Enfileira agent_commands
// kind='serial_terminal' (prioridade absoluta no agente) e kind='serial_sniff'
// (captura passiva). O agente SEMPRE anexa \r ao frame; aqui nunca digitamos CR.
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { notify } from "@/lib/notify";
import { TerminalSquare, Send, Radio, Loader2, Trash2, Power, PowerOff, Search, Radar } from "lucide-react";
import {
  enqueueAgentCommand, watchAgentCommand,
  type SerialTerminalData, type SerialSniffData,
} from "@/lib/agentCommands";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Farm { farm_id: string; name: string; }
interface Equip {
  id: string; name: string; hw_id: string | null; saida: number | null;
  type: string; last_outputs_state: string | null;
}

type LogLine = { kind: "tx" | "rx" | "err" | "info"; text: string; at: number };

const QUICK = ["PING", "STATUS", "RESET", "RESET_B", "REP:R3:PING", "REP:R3:STATUS", "REP:R3:RESET"];
// Comandos que pedem confirmação antes de enviar (item 5).
const DANGEROUS = /(^|:)RESET|CFG:FACTORY_RESET/i;
const MAX_LOG = 300;
const MAX_TIMEOUT_MS = 30_000;
// Log ao vivo: reenfileira chunks de sniff de 60s (teto do agente, v3.25.60) até
// o usuário parar ou atingir o teto de 10 min de segurança. Agentes antigos
// (clamp 30s) reduzem o chunk para 30s automaticamente — degrada sem quebrar.
const LIVE_MAX_MS = 10 * 60_000;
const SNIFF_CHUNK_MS = 60_000;

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function ts(at: number) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export default function PlatformSerialTerminal({ isAdmin }: { isAdmin: boolean }) {
  const [farms, setFarms] = useState<Farm[]>([]);
  const [farmId, setFarmId] = useState<string>("");
  const [equips, setEquips] = useState<Equip[]>([]);
  const [mode, setMode] = useState<"raw" | "equipment">("raw");
  const [rawCmd, setRawCmd] = useState("");
  const [equipId, setEquipId] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(5_000);
  const [busy, setBusy] = useState(false);
  const [sniffing, setSniffing] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [confirm, setConfirm] = useState<{ frame: string; run: () => void } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  // Log ao vivo (captura contínua)
  const [liveOn, setLiveOn] = useState(false);
  const [liveStartedAt, setLiveStartedAt] = useState(0);
  const [, setNowTick] = useState(0); // força re-render do contador a cada 1s
  const [liveFilterId, setLiveFilterId] = useState(""); // "" = tudo; senão equipment id
  const liveStopRef = useRef(false);
  const liveFilterHwRef = useRef<string | null>(null);

  const selectedEquip = useMemo(() => equips.find((e) => e.id === equipId) || null, [equips, equipId]);

  const push = (kind: LogLine["kind"], text: string) =>
    setLog((prev) => [{ kind, text, at: Date.now() }, ...prev].slice(0, MAX_LOG));

  const loadFarms = async () => {
    // Fonte 1: RPC de overview (mesma do Controle Remoto). Fallback: tabela farms.
    let list: Farm[] = [];
    const { data, error } = await supabase.rpc("platform_farms_overview" as never);
    if (!error && Array.isArray(data)) {
      list = (data as unknown as { farm_id?: string; id?: string; name: string }[])
        .map((f) => ({ farm_id: (f.farm_id ?? f.id) as string, name: f.name }))
        .filter((f) => f.farm_id);
    }
    if (list.length === 0) {
      const { data: fdata, error: ferr } = await supabase
        .from("farms").select("id,name").order("name");
      if (ferr) { push("err", `Nao consegui carregar fazendas: ${ferr.message}`); notify.fail("Terminal Serial", ferr.message); return; }
      list = ((fdata as { id: string; name: string }[]) ?? []).map((f) => ({ farm_id: f.id, name: f.name }));
    }
    setFarms(list);
    if (!farmId && list.length) setFarmId(list[0].farm_id);
    if (list.length === 0) push("err", "Nenhuma fazenda disponivel para o seu usuario.");
  };

  const loadEquips = async (id: string) => {
    if (!id) { setEquips([]); return; }
    const { data, error } = await supabase
      .from("equipments")
      .select("id,name,hw_id,saida,type,last_outputs_state")
      .eq("farm_id", id)
      .eq("active", true)
      .order("name");
    if (error) { notify.fail("Terminal Serial", error.message); return; }
    setEquips((data as unknown as Equip[]) ?? []);
  };

  useEffect(() => { void loadFarms(); }, []);
  useEffect(() => { setEquipId(""); void loadEquips(farmId); }, [farmId]);

  // Contador "Capturando há Xm Ys" enquanto o log ao vivo roda.
  useEffect(() => {
    if (!liveOn) return;
    const id = window.setInterval(() => setNowTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [liveOn]);

  // Auto-scroll: no modo ao vivo, mantém o topo (linha mais recente) visível.
  useEffect(() => {
    if (liveOn && logRef.current) logRef.current.scrollTop = 0;
  }, [log, liveOn]);

  // Filtro por equipamento → guarda o hw_id (TSNN) num ref lido pelo loop ao vivo.
  useEffect(() => {
    const eq = equips.find((e) => e.id === liveFilterId) || null;
    liveFilterHwRef.current = eq?.hw_id ? String(eq.hw_id) : null;
  }, [liveFilterId, equips]);

  // Ao trocar de fazenda ou desmontar, encerra a captura ao vivo.
  useEffect(() => () => { liveStopRef.current = true; }, []);
  useEffect(() => { if (liveOn) stopLive(); }, [farmId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = 0; }, [log]);

  if (!isAdmin) {
    return (
      <Card><CardContent className="p-6 text-center text-muted-foreground">
        Acesso restrito ao administrador da plataforma.
      </CardContent></Card>
    );
  }

  const clampTimeout = (n: number) => Math.max(500, Math.min(MAX_TIMEOUT_MS, n || 5_000));

  // Envia um comando de terminal (raw ou equipment) e desenha o resultado.
  // Insere DIRETO em agent_commands (kind='serial_terminal') e faz polling do
  // campo `result` a cada 2s por ate 30s. Todo erro vira uma linha VERMELHA no
  // log — nunca falha em silencio. (agent_commands NAO tem coluna `response`; o
  // agente grava a saida da serial em `result.data.responses`.)
  const sendTerminal = async (payload: Record<string, unknown>, label: string) => {
    if (!farmId) { push("err", "Selecione uma fazenda antes de enviar."); return; }
    setBusy(true);
    push("tx", `${label}  ⏎`); // ⏎ = CR anexado pelo agente
    try {
      const { data: userRes } = await supabase.auth.getUser();
      const { data: ins, error: insErr } = await supabase
        .from("agent_commands")
        .insert({
          farm_id: farmId,
          kind: "serial_terminal",
          payload: payload as never,
          created_by: userRes?.user?.id ?? null,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        })
        .select("id")
        .single();
      if (insErr || !ins) {
        push("err", `Falha ao enviar: ${insErr?.message ?? "sem id retornado"}`);
        return;
      }

      // Polling do resultado: 2s de intervalo, ate 30s.
      const deadline = Date.now() + MAX_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(2_000);
        const { data: row } = await supabase
          .from("agent_commands")
          .select("status,result,error_message")
          .eq("id", ins.id)
          .maybeSingle();
        if (!row) continue;
        if (row.status === "done") {
          const d = ((row.result as { data?: SerialTerminalData } | null)?.data) ?? null;
          if (d && d.responses && d.responses.length) {
            d.responses.forEach((r) => push("rx", r));
          } else {
            push("info", `(sem resposta da serial em ${d?.elapsed_ms ?? "?"}ms)`);
          }
          if (d?.parsed) push("info", `Estado: ${d.parsed.status.toUpperCase()}`);
          return;
        }
        if (row.status === "error" || row.status === "expired") {
          push("err", row.error_message ?? "agente retornou erro");
          return;
        }
        // pending/ack/executing -> continua aguardando
      }
      push("err", "TIMEOUT — sem resposta em 30s (agente offline ou serial ocupada?)");
    } catch (e) {
      push("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Modo direto (frame raw) — com confirmação se for perigoso.
  const submitRaw = () => {
    const cmd = rawCmd.trim();
    if (!cmd) return;
    const run = () => void sendTerminal({ mode: "raw", command: cmd, timeout_ms: clampTimeout(timeoutMs) }, cmd);
    if (DANGEROUS.test(cmd)) setConfirm({ frame: cmd, run });
    else run();
  };

  const sendQuick = (cmd: string) => {
    const run = () => void sendTerminal({ mode: "raw", command: cmd, timeout_ms: clampTimeout(timeoutMs) }, cmd);
    if (DANGEROUS.test(cmd)) setConfirm({ frame: cmd, run });
    else run();
  };

  // Ações por equipamento (diagnóstico puro).
  const equipAction = (action: "status" | "on" | "off" | "ping") => {
    if (!selectedEquip) return;
    const label = `${selectedEquip.name} · ${action.toUpperCase()} (PLC ${(selectedEquip.hw_id || "").slice(0, 4)}/S${selectedEquip.saida ?? "?"})`;
    void sendTerminal(
      { mode: "equipment", equipment_id: selectedEquip.id, action, timeout_ms: clampTimeout(timeoutMs) },
      label,
    );
  };

  // Sniff passivo — captura por N segundos, desenhando frames ao vivo.
  const startSniff = async (durationMs: number) => {
    if (!farmId) return;
    setSniffing(true);
    push("info", `Captura iniciada (${durationMs / 1000}s) — modo passivo, polling segue rodando`);
    const seen = new Set<string>();
    try {
      const commandId = await enqueueAgentCommand({
        farmId, kind: "serial_sniff", payload: { duration_ms: durationMs }, expiresInSec: 90,
      });
      await watchAgentCommand(commandId, (partial) => {
        const d = (partial.result?.data as SerialSniffData) ?? null;
        if (!d?.frames) return;
        for (const f of d.frames) {
          const key = `${f.at}|${f.frame}`;
          if (seen.has(key)) continue;
          seen.add(key);
          push("rx", f.frame);
        }
      }, { pollMs: 2_000, timeoutMs: durationMs + 15_000 });
      push("info", "Captura finalizada");
    } catch (e) {
      push("err", (e as Error).message);
    } finally {
      setSniffing(false);
    }
  };

  // ▶ Log ao Vivo — captura CONTÍNUA. O agente limita cada serial_sniff a 60s, então
  // reenfileiramos chunks em sequência até o usuário parar (⏹) ou atingir 10 min.
  const stopLive = () => { liveStopRef.current = true; };

  const startLive = async () => {
    if (!farmId || liveOn || sniffing || busy) return;
    liveStopRef.current = false;
    setLiveOn(true);
    const startedAt = Date.now();
    setLiveStartedAt(startedAt);
    push("info", "▶ Log ao vivo iniciado — captura contínua (máx 10 min). Use ⏹ Parar para encerrar.");
    const seen = new Set<string>();
    try {
      while (!liveStopRef.current && (Date.now() - startedAt) < LIVE_MAX_MS) {
        const remaining = LIVE_MAX_MS - (Date.now() - startedAt);
        const chunk = Math.min(SNIFF_CHUNK_MS, remaining);
        if (chunk < 1_000) break;
        const commandId = await enqueueAgentCommand({
          farmId, kind: "serial_sniff", payload: { duration_ms: chunk }, expiresInSec: 90,
        });
        await watchAgentCommand(commandId, (partial) => {
          const d = (partial.result?.data as SerialSniffData) ?? null;
          if (!d?.frames) return;
          const hw = liveFilterHwRef.current; // filtro pode mudar durante a captura
          for (const f of d.frames) {
            const key = `${f.at}|${f.frame}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (hw && !String(f.frame).includes(hw)) continue;
            push("rx", f.frame);
          }
        }, { pollMs: 1_500, timeoutMs: chunk + 15_000 });
        if (seen.size > 5_000) seen.clear(); // evita crescer sem limite
      }
      if (!liveStopRef.current) push("info", "⏹ Teto de 10 min atingido — captura encerrada.");
    } catch (e) {
      push("err", (e as Error).message);
    } finally {
      liveStopRef.current = true;
      setLiveOn(false);
      push("info", "⏹ Log ao vivo encerrado");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <TerminalSquare className="w-5 h-5" /> Terminal Serial Remoto
            <Badge variant="outline" className="ml-1 font-normal">substitui o Hércules</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Fazenda + timeout */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px]">
              <Label className="text-xs">Fazenda</Label>
              <Select value={farmId} onValueChange={setFarmId}>
                <SelectTrigger><SelectValue placeholder="Selecione a fazenda" /></SelectTrigger>
                <SelectContent>
                  {farms.map((f) => <SelectItem key={f.farm_id} value={f.farm_id}>{f.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="w-[140px]">
              <Label className="text-xs">Timeout (s)</Label>
              <Input
                type="number" min={1} max={30}
                value={Math.round(timeoutMs / 1000)}
                onChange={(e) => setTimeoutMs(clampTimeout(Number(e.target.value) * 1000))}
              />
            </div>
            <div className="flex items-center gap-2 pb-1">
              <Label className="text-xs">Modo:</Label>
              <span className={mode === "raw" ? "font-semibold" : "text-muted-foreground"}>Direto</span>
              <Switch checked={mode === "equipment"} onCheckedChange={(v) => setMode(v ? "equipment" : "raw")} />
              <span className={mode === "equipment" ? "font-semibold" : "text-muted-foreground"}>Equipamento</span>
            </div>
          </div>

          {/* MODO DIRETO */}
          {mode === "raw" && (
            <div className="space-y-2">
              <Label className="text-xs">Frame / comando (o sistema adiciona ⏎ CR automaticamente)</Label>
              <div className="flex gap-2">
                <Input
                  value={rawCmd}
                  placeholder="[1305_1_]{1}[1305_ETX_]  ou  PING"
                  className="font-mono"
                  onChange={(e) => setRawCmd(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !busy) submitRaw(); }}
                  disabled={busy}
                />
                <Button onClick={submitRaw} disabled={busy || !rawCmd.trim() || !farmId}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  <span className="ml-1">Enviar</span>
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {QUICK.map((q) => (
                  <Button key={q} size="sm" variant="secondary" className="font-mono text-xs"
                    disabled={busy || !farmId} onClick={() => sendQuick(q)}>
                    {q}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* MODO EQUIPAMENTO */}
          {mode === "equipment" && (
            <div className="space-y-3">
              <div className="min-w-[260px] max-w-md">
                <Label className="text-xs">Equipamento</Label>
                <Select value={equipId} onValueChange={setEquipId}>
                  <SelectTrigger><SelectValue placeholder="Selecione o equipamento" /></SelectTrigger>
                  <SelectContent>
                    {equips.map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.name} — PLC {(e.hw_id || "").slice(0, 4)} / saída {e.saida ?? "—"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {selectedEquip && (
                <div className="text-xs text-muted-foreground font-mono">
                  Endereço PLC: {(selectedEquip.hw_id || "").slice(0, 4)} · Saída: {String(selectedEquip.saida ?? "—").padStart(2, "0")} · Tipo: {selectedEquip.type}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={busy || !selectedEquip} onClick={() => equipAction("status")}>
                  <Search className="w-4 h-4 mr-1" /> Consultar Status
                </Button>
                <Button size="sm" variant="secondary" disabled={busy || !selectedEquip} onClick={() => equipAction("ping")}>
                  <Radio className="w-4 h-4 mr-1" /> Ping PLC
                </Button>
                <Button size="sm" variant="outline" disabled={busy || !selectedEquip} onClick={() => equipAction("on")}>
                  <Power className="w-4 h-4 mr-1" /> Ligar
                </Button>
                <Button size="sm" variant="outline" disabled={busy || !selectedEquip} onClick={() => equipAction("off")}>
                  <PowerOff className="w-4 h-4 mr-1" /> Desligar
                </Button>
              </div>
              <p className="text-xs text-amber-600 dark:text-amber-500">
                Ligar/Desligar aqui é <strong>teste de diagnóstico</strong> (igual ao Hércules): não
                grava o estado no sistema, então o polling pode reverter em ~30s. Para operar de
                verdade, use o controle normal da fazenda.
              </p>
            </div>
          )}

          {/* SNIFF */}
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Radar className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Ver tráfego passando (passivo):</span>
            <Button size="sm" variant="secondary" disabled={sniffing || liveOn || !farmId} onClick={() => startSniff(10_000)}>
              {sniffing ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Iniciar Captura (10s)
            </Button>
            <Button size="sm" variant="ghost" disabled={sniffing || liveOn || !farmId} onClick={() => startSniff(30_000)}>
              30s
            </Button>
          </div>

          {/* LOG AO VIVO (captura contínua) */}
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Radar className="w-4 h-4 text-primary" />
            <span className="text-sm text-muted-foreground">Log ao vivo (contínuo):</span>
            {!liveOn ? (
              <Button size="sm" disabled={sniffing || busy || !farmId} onClick={() => void startLive()}>
                ▶ Log ao Vivo
              </Button>
            ) : (
              <Button size="sm" variant="destructive" onClick={stopLive}>
                ⏹ Parar
              </Button>
            )}
            {liveOn && (
              <Badge variant="outline" className="font-normal gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                Capturando há {fmtElapsed(Date.now() - liveStartedAt)}
              </Badge>
            )}
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">Filtrar:</span>
              <Select value={liveFilterId || "all"} onValueChange={(v) => setLiveFilterId(v === "all" ? "" : v)}>
                <SelectTrigger className="h-8 w-[190px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os equipamentos</SelectItem>
                  {equips.filter((e) => e.hw_id).map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name} ({e.hw_id})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* LOG */}
      <Card>
        <CardHeader className="pb-2 flex-row items-center justify-between">
          <CardTitle className="text-sm">Saída ({log.length}/{MAX_LOG})</CardTitle>
          <Button size="sm" variant="ghost" onClick={() => setLog([])} disabled={!log.length}>
            <Trash2 className="w-4 h-4 mr-1" /> Limpar
          </Button>
        </CardHeader>
        <CardContent>
          <div ref={logRef} className="h-72 overflow-y-auto rounded bg-black/90 p-3 font-mono text-xs leading-relaxed">
            {log.length === 0 && <div className="text-muted-foreground">Sem tráfego ainda.</div>}
            {log.map((l, i) => (
              <div key={i} className={
                l.kind === "tx" ? "text-emerald-400"
                  : l.kind === "rx" ? "text-sky-400"
                    : l.kind === "err" ? "text-red-400"
                      : "text-neutral-400"
              }>
                <span className="text-neutral-500">[{ts(l.at)}]</span>{" "}
                <span className="text-neutral-500">{l.kind === "tx" ? "TX" : l.kind === "rx" ? "RX" : l.kind === "err" ? "!!" : "··"}</span>{" "}
                {l.text}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Confirmação de comando perigoso */}
      <AlertDialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar comando sensível</AlertDialogTitle>
            <AlertDialogDescription>
              Você está prestes a enviar <code className="font-mono">{confirm?.frame}</code> pela serial
              desta fazenda. Comandos de RESET/FACTORY afetam o hardware. Confirma?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const c = confirm; setConfirm(null); c?.run(); }}>
              Enviar mesmo assim
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
