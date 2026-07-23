import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Wrench, Power, PowerOff, Send, Radio, AlertTriangle, CheckCircle2, XCircle, Circle } from "lucide-react";
import { notify } from "@/lib/notify";
import { confirmAction } from "@/lib/confirmDialog";
import { useAuth } from "@/contexts/AuthContext";

interface FarmRow { farm_id: string; name: string; }
interface EquipRow {
  id: string;
  name: string;
  hw_id: string;
  saida: number | null;
  farm_id: string;
  last_outputs_state: string | null;
  last_communication: string | null;
  last_polling_at: string | null;
}
interface TestEntry {
  at: number;
  equipName: string;
  tx: string;
  rx: string;
  latencyMs: number | null;
  status: "ok" | "timeout" | "error" | "pending";
}

const tsnnOf = (eq: EquipRow) => (eq.hw_id || "").substring(0, 4);
const saidaOf = (eq: EquipRow) => eq.saida ?? (parseInt((eq.hw_id || "").substring(4, 6), 10) || 1);

function buildTestFrame(tsnn: string, totalSaidas: number, payload: string): string {
  const padded = payload.padStart(totalSaidas, "0").slice(-totalSaidas);
  return `[${tsnn}_1_]{${padded}}[${tsnn}_ETX_]\r`;
}

function statusDot(eq: EquipRow): { color: string; label: string } {
  if (!eq.last_communication) return { color: "text-warning", label: "nunca comunicou" };
  const ageMs = Date.now() - new Date(eq.last_communication).getTime();
  if (ageMs < 60_000) return { color: "text-primary", label: "respondendo" };
  if (ageMs < 5 * 60_000) return { color: "text-warning", label: "intermitente" };
  return { color: "text-destructive", label: "sem resposta" };
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s atrás`;
  if (s < 3600) return `${Math.floor(s / 60)}min atrás`;
  if (s < 86400) return `${Math.floor(s / 3600)}h atrás`;
  return `${Math.floor(s / 86400)}d atrás`;
}

export default function PlatformServiceMode() {
  const { user } = useAuth();
  const [farms, setFarms] = useState<FarmRow[]>([]);
  const [equipments, setEquipments] = useState<EquipRow[]>([]);
  const [farmId, setFarmId] = useState<string>("");
  const [equipId, setEquipId] = useState<string>("");
  const [history, setHistory] = useState<TestEntry[]>([]);
  const [activeTest, setActiveTest] = useState<{ commandId: string; tx: string; sentAt: number; equipName: string } | null>(null);
  const [customFrame, setCustomFrame] = useState("");
  const [serviceModeActive, setServiceModeActive] = useState(false);
  const inactivityRef = useRef<number>(0);

  const eq = useMemo(() => equipments.find(e => e.id === equipId), [equipments, equipId]);

  useEffect(() => {
    void supabase.from("farms").select("id,name").order("name").then(({ data }) => {
      setFarms((data ?? []).map((f: any) => ({ farm_id: f.id, name: f.name })));
    });
  }, []);

  useEffect(() => {
    if (!farmId) { setEquipments([]); return; }
    void supabase.from("equipments")
      .select("id,name,hw_id,saida,farm_id,last_outputs_state,last_communication,last_polling_at")
      .eq("farm_id", farmId)
      .in("type", ["poco", "bombeamento"])
      .eq("active", true)
      .order("hw_id")
      .then(({ data }) => setEquipments((data as any) ?? []));
  }, [farmId]);

  useEffect(() => {
    if (!serviceModeActive || !eq || !farmId) return;
    const tsnn = tsnnOf(eq);
    const refresh = async () => {
      if (Date.now() - inactivityRef.current > 5 * 60_000) {
        await releaseLock();
        notify.tip("Modo Serviço", "Modo Serviço encerrado por inatividade (5 min)");
        setServiceModeActive(false);
        return;
      }
      await supabase.from("service_mode_locks").upsert({
        farm_id: farmId, tsnn,
        locked_by: user?.id ?? null,
        locked_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      }, { onConflict: "farm_id,tsnn" });
    };
    void refresh();
    const t = window.setInterval(refresh, 60_000);
    return () => { window.clearInterval(t); };
  }, [serviceModeActive, eq?.id, farmId, user?.id]);

  useEffect(() => {
    if (!activeTest) return;
    const channel = supabase.channel(`svc_cmd_${activeTest.commandId}`)
      .on("postgres_changes", {
        event: "UPDATE", schema: "public", table: "commands",
        filter: `id=eq.${activeTest.commandId}`,
      }, (payload) => {
        const c: any = payload.new;
        if (!["executed", "timeout", "error", "cancelled"].includes(c.status)) return;
        const latencyMs = c.responded_at && activeTest
          ? new Date(c.responded_at).getTime() - activeTest.sentAt
          : null;
        const status: TestEntry["status"] =
          c.status === "executed" ? "ok"
          : c.status === "timeout" ? "timeout"
          : "error";
        setHistory((prev) => [{
          at: Date.now(),
          equipName: activeTest.equipName,
          tx: activeTest.tx,
          rx: c.response || c.error_message || "(sem resposta)",
          latencyMs,
          status,
        }, ...prev].slice(0, 50));
        setActiveTest(null);
      })
      .subscribe();
    const poll = window.setInterval(async () => {
      const { data } = (await supabase.rpc("get_command_result", { p_command_id: activeTest.commandId }).maybeSingle()) as any;
      if (data && ["executed", "timeout", "error", "cancelled"].includes(data.status)) {
        const latencyMs = data.responded_at ? new Date(data.responded_at).getTime() - activeTest.sentAt : null;
        const status: TestEntry["status"] =
          data.status === "executed" ? "ok" : data.status === "timeout" ? "timeout" : "error";
        setHistory((prev) => [{
          at: Date.now(), equipName: activeTest.equipName, tx: activeTest.tx,
          rx: data.response || data.error_message || "(sem resposta)", latencyMs, status,
        }, ...prev].slice(0, 50));
        setActiveTest(null);
      }
    }, 2000);
    return () => { void supabase.removeChannel(channel); window.clearInterval(poll); };
  }, [activeTest?.commandId]);

  const releaseLock = async () => {
    if (!eq || !farmId) return;
    await supabase.from("service_mode_locks").delete()
      .eq("farm_id", farmId).eq("tsnn", tsnnOf(eq));
  };

  const startServiceMode = async () => {
    if (!eq) { notify.fail("Modo Serviço", "Selecione um equipamento"); return; }
    const ok = await confirmAction({
      title: "Entrar em Modo Serviço?",
      description:
        "⚠️ O polling será pausado. Monitoramento em tempo real ficará suspenso. Continuar?",
      confirmLabel: "Entrar em Modo Serviço",
      variant: "warning",
    });
    if (!ok) return;
    inactivityRef.current = Date.now();
    setServiceModeActive(true);
    notify.ok("Modo Serviço", `Modo Serviço ativo em ${eq.name} — polling suspenso`);
  };

  const stopServiceMode = async () => {
    await releaseLock();
    setServiceModeActive(false);
    notify.tip("Modo Serviço", "Modo Serviço encerrado — polling retomado");
  };

  const sendTest = async (kind: "ping" | "on" | "off" | "custom") => {
    if (!eq) { notify.fail("Modo Serviço", "Selecione um equipamento"); return; }
    if (!serviceModeActive) { notify.fail("Modo Serviço", "Inicie o Modo Serviço antes de testar"); return; }
    inactivityRef.current = Date.now();
    const tsnn = tsnnOf(eq);
    const saida = saidaOf(eq);
    let frame: string;
    if (kind === "custom") {
      if (!customFrame.trim()) { notify.fail("Modo Serviço", "Digite um frame"); return; }
      frame = customFrame.endsWith("\r") ? customFrame : customFrame + "\r";
    } else {
      const current = (eq.last_outputs_state || "").padStart(saida, "0");
      let payload: string;
      if (kind === "ping") payload = current.length ? current : "0".repeat(saida);
      else {
        const arr = current.split("");
        while (arr.length < saida) arr.unshift("0");
        arr[saida - 1] = kind === "on" ? "1" : "0";
        payload = arr.join("");
      }
      frame = buildTestFrame(tsnn, saida, payload);
    }
    const sentAt = Date.now();
    const { data, error } = await supabase.from("commands").insert({
      farm_id: farmId,
      equipment_id: eq.id,
      plc_hw_id: tsnn,
      type: "service_test",
      priority: 2,
      frame,
      timeout_ms: 13000,
      source_device: "platform-service",
      created_by: user?.id ?? null,
    } as any).select("id").single();
    if (error) { notify.fail("Modo Serviço", "Erro ao enfileirar teste: " + error.message); return; }
    setActiveTest({ commandId: data.id, tx: frame, sentAt, equipName: eq.name });
    setHistory((prev) => [{
      at: sentAt, equipName: eq.name, tx: frame, rx: "(aguardando…)", latencyMs: null, status: "pending" as const,
    }, ...prev].slice(0, 50));
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 p-3 text-sm flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600" />
        <div>
          <strong>Modo Serviço</strong> — somente Admin. Comandos não alteram o estado desejado da bomba.
          Enquanto ativo, o polling daquela PLC fica suspenso (até 5 min de inatividade).
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Wrench className="w-4 h-4"/> Selecionar equipamento</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Fazenda</label>
              <Select value={farmId} onValueChange={(v) => { setFarmId(v); setEquipId(""); if (serviceModeActive) void stopServiceMode(); }}>
                <SelectTrigger><SelectValue placeholder="Escolha a fazenda…"/></SelectTrigger>
                <SelectContent>
                  {farms.map(f => <SelectItem key={f.farm_id} value={f.farm_id}>{f.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Equipamento</label>
              <Select value={equipId} onValueChange={(v) => { if (serviceModeActive) void stopServiceMode(); setEquipId(v); }}>
                <SelectTrigger><SelectValue placeholder={farmId ? "Escolha o equipamento…" : "Selecione fazenda primeiro"}/></SelectTrigger>
                <SelectContent>
                  {equipments.map(e => {
                    const s = statusDot(e);
                    return (
                      <SelectItem key={e.id} value={e.id}>
                        <span className="flex items-center gap-2">
                          <Circle className={`w-2.5 h-2.5 fill-current ${s.color}`} />
                          {e.name} — TSNN {tsnnOf(e)} S{saidaOf(e)}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>

          {eq && (
            <div className="grid sm:grid-cols-4 gap-2 text-xs bg-muted/30 rounded p-2">
              <div><span className="text-muted-foreground">TSNN/Saída:</span> <strong>{tsnnOf(eq)} S{saidaOf(eq)}</strong></div>
              <div><span className="text-muted-foreground">Estado atual:</span> <code>{eq.last_outputs_state ?? "—"}</code></div>
              <div><span className="text-muted-foreground">Última comm.:</span> {fmtAgo(eq.last_communication)}</div>
              <div><span className="text-muted-foreground">Último polling:</span> {fmtAgo(eq.last_polling_at)}</div>
            </div>
          )}

          <div className="flex gap-2">
            {!serviceModeActive ? (
              <Button onClick={startServiceMode} disabled={!eq} className="gap-2">
                <Radio className="w-4 h-4"/> Iniciar Modo Serviço
              </Button>
            ) : (
              <Button onClick={stopServiceMode} variant="destructive" className="gap-2">
                <XCircle className="w-4 h-4"/> Parar Modo Serviço
              </Button>
            )}
            {serviceModeActive && eq && (
              <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400 gap-1">
                <AlertTriangle className="w-3 h-3"/> Polling suspenso para PLC {tsnnOf(eq)}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Ações de teste</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => sendTest("ping")} disabled={!serviceModeActive || !!activeTest} variant="secondary" className="gap-2">
              <Send className="w-4 h-4"/> Ping (leitura)
            </Button>
            <Button onClick={() => sendTest("on")} disabled={!serviceModeActive || !!activeTest} className="gap-2">
              <Power className="w-4 h-4"/> Ligar teste
            </Button>
            <Button onClick={() => sendTest("off")} disabled={!serviceModeActive || !!activeTest} variant="outline" className="gap-2">
              <PowerOff className="w-4 h-4"/> Desligar teste
            </Button>
          </div>
          <div className="flex gap-2">
            <Input placeholder="Frame customizado: [TSNN_1_]{...}[TSNN_ETX_]" value={customFrame} onChange={e => setCustomFrame(e.target.value)} className="font-mono text-xs"/>
            <Button onClick={() => sendTest("custom")} disabled={!serviceModeActive || !!activeTest}>Enviar</Button>
          </div>
          {activeTest && (
            <div className="text-xs text-muted-foreground animate-pulse">⏳ Aguardando resposta… (timeout 13s)</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Histórico de testes (sessão)</CardTitle></CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhum teste ainda.</p>
          ) : (
            <div className="space-y-1 font-mono text-[11px] max-h-[420px] overflow-auto">
              {history.map((h, i) => (
                <div key={i} className="border border-border rounded p-2 bg-card">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2">
                      {h.status === "ok" && <CheckCircle2 className="w-3.5 h-3.5 text-primary"/>}
                      {h.status === "timeout" && <XCircle className="w-3.5 h-3.5 text-destructive"/>}
                      {h.status === "error" && <AlertTriangle className="w-3.5 h-3.5 text-warning"/>}
                      {h.status === "pending" && <Circle className="w-3.5 h-3.5 text-muted-foreground animate-pulse"/>}
                      <span className="font-sans font-semibold">{h.equipName}</span>
                      <span className="text-muted-foreground font-sans">{new Date(h.at).toLocaleTimeString()}</span>
                    </div>
                    <span className={`font-sans text-xs ${h.status === "ok" ? "text-primary" : h.status === "timeout" ? "text-destructive" : "text-muted-foreground"}`}>
                      {h.status === "ok" ? `OK · ${h.latencyMs}ms` : h.status === "timeout" ? "SEM RESPOSTA" : h.status.toUpperCase()}
                    </span>
                  </div>
                  <div className="text-blue-500 break-all">TX → {h.tx.replace(/\r/g, "\\r")}</div>
                  <div className={`break-all ${h.status === "ok" ? "text-emerald-500" : h.status === "timeout" ? "text-destructive" : "text-muted-foreground"}`}>
                    RX ← {h.rx.replace(/\r/g, "\\r")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
