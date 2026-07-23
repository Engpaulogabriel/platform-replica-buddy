import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { notify } from "@/lib/notify";
import {
  Power, Trash2, MessageSquare, ToggleLeft, RefreshCw, Send, AlertOctagon, AlertTriangle, Info,
  Cable, RotateCw, ListChecks, PauseCircle, PlayCircle, Loader2, Zap,
} from "lucide-react";
import { enqueueAgentCommand, runAgentCommand, type AgentCmdKind, type AgentCmdResult } from "@/lib/agentCommands";
import { useSiteHealth } from "@/hooks/useSiteHealth";

interface Farm {
  farm_id: string;
  name: string;
  plan: string;
  modules?: { vazao?: boolean; consumo?: boolean; ai_whatsapp?: boolean };
}

export default function PlatformRemoteControl({ isAdmin }: { isAdmin: boolean }) {
  const [farms, setFarms] = useState<Farm[]>([]);
  const [farmId, setFarmId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [farmRow, setFarmRow] = useState<any>(null);

  // mensagem
  const [msgLevel, setMsgLevel] = useState("info");
  const [msgTitle, setMsgTitle] = useState("");
  const [msgBody, setMsgBody] = useState("");
  const [msgExpiresHours, setMsgExpiresHours] = useState("24");

  const loadFarms = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("platform_farms_overview" as any);
    if (error) { notify.fail("Controle Remoto", error.message); setLoading(false); return; }
    const list = ((data as any) ?? []).map((f: any) => ({ farm_id: f.farm_id, name: f.name, plan: f.plan }));
    setFarms(list);
    if (!farmId && list.length) setFarmId(list[0].farm_id);
    setLoading(false);
  };

  const loadFarmDetail = async (id: string) => {
    if (!id) return;
    const { data, error } = await supabase
      .from("farms")
      .select("id,name,plan,modules,license_status,license_key,bell_alerts_enabled")
      .eq("id", id)
      .maybeSingle();
    if (error) return notify.fail("Controle Remoto", error.message);
    setFarmRow(data);
  };

  const toggleBellAlerts = async (value: boolean) => {
    if (!farmId) return;
    setBusy("bell-alerts");
    const { error } = await supabase.from("farms").update({ bell_alerts_enabled: value }).eq("id", farmId);
    setBusy(null);
    if (error) return notify.fail("Controle Remoto", error.message);
    setFarmRow((prev: any) => prev ? { ...prev, bell_alerts_enabled: value } : prev);
    notify.ok("Controle Remoto", `Sino de alertas ${value ? "ativado" : "desativado"}.`);
  };

  useEffect(() => { void loadFarms(); }, []);
  useEffect(() => { void loadFarmDetail(farmId); }, [farmId]);

  if (!isAdmin) {
    return (
      <Card><CardContent className="p-6 text-center text-muted-foreground">
        Apenas Platform Admins podem executar ações de controle remoto.
      </CardContent></Card>
    );
  }

  const guard = (label: string, fn: () => Promise<unknown>) => async () => {
    setBusy(label); try { await fn(); } finally { setBusy(null); }
  };

  const reboot = guard("reboot", async () => {
    if (!confirm("Forçar reboot do agente Electron desta fazenda?")) return;
    const { data, error } = await supabase.rpc("platform_send_agent_reboot" as any, { _farm_id: farmId });
    if (error) return notify.fail("Controle Remoto", error.message);
    notify.ok("Controle Remoto", "Reboot enfileirado · cmd " + String(data).slice(0, 8));
  });

  const clearQueue = guard("clear", async () => {
    if (!confirm("Limpar TODA a fila pendente desta fazenda? (commands + agent_commands)")) return;
    const { data, error } = await supabase.rpc("platform_clear_pending_commands" as any, { _farm_id: farmId });
    if (error) return notify.fail("Controle Remoto", error.message);
    const r = data as any;
    notify.ok("Controle Remoto", `Limpos: ${r?.commands_cleared ?? 0} comandos · ${r?.agent_commands_cleared ?? 0} comandos do agente`);
  });

  const sendMessage = guard("msg", async () => {
    if (msgTitle.trim().length < 2 || msgBody.trim().length < 2) {
      return notify.fail("Controle Remoto", "Preencha título e corpo da mensagem.");
    }
    const expiresAt = msgExpiresHours === "0"
      ? null
      : new Date(Date.now() + Number(msgExpiresHours) * 3600_000).toISOString();
    const { error } = await supabase.rpc("platform_send_farm_message" as any, {
      _farm_id: farmId,
      _level: msgLevel,
      _title: msgTitle.trim(),
      _body: msgBody.trim(),
      _expires_at: expiresAt,
    });
    if (error) return notify.fail("Controle Remoto", error.message);
    notify.ok("Controle Remoto", "Mensagem enviada ao operador.");
    setMsgTitle(""); setMsgBody("");
  });

  const toggleModule = async (key: "vazao" | "consumo" | "ai_whatsapp", value: boolean) => {
    setBusy("module-" + key);
    const { data, error } = await supabase.rpc("platform_set_farm_modules" as any, {
      _farm_id: farmId,
      _modules: { [key]: value },
    });
    setBusy(null);
    if (error) return notify.fail("Controle Remoto", error.message);
    setFarmRow((prev: any) => prev ? { ...prev, modules: data } : prev);
    notify.ok("Controle Remoto", `Módulo ${key} ${value ? "ativado" : "desativado"}.`);
  };

  const modules = farmRow?.modules ?? {};

  // ── Bridge remote control ──
  const health = useSiteHealth(farmId);
  const [bridgeBusy, setBridgeBusy] = useState<AgentCmdKind | null>(null);
  const [bridgeResult, setBridgeResult] = useState<{ kind: AgentCmdKind; result: AgentCmdResult } | null>(null);

  async function dispatchBridge(kind: AgentCmdKind, payload: Record<string, unknown> = {}, timeoutMs = 25_000) {
    if (!farmId) return notify.fail("Bridge", "Selecione uma fazenda");
    setBridgeBusy(kind);
    try {
      const { result } = await runAgentCommand({ farmId, kind, payload, timeoutMs });
      setBridgeResult({ kind, result });
      if (result.status === "done") notify.ok("Bridge", `Comando executado em ${result.duration_ms ?? "?"} ms`);
      else if (result.status === "expired") notify.fail("Bridge", "Agente não respondeu (offline?)");
      else notify.fail("Bridge", result.error_message ?? "Erro desconhecido");
    } catch (e: any) {
      notify.fail("Bridge", e?.message ?? String(e));
    } finally {
      setBridgeBusy(null);
    }
  }
  const bridgeBusyAny = bridgeBusy !== null;
  const portsList = (bridgeResult?.kind === "list_ports" && bridgeResult.result.result?.data &&
    (bridgeResult.result.result.data as any).ports) || null;

  return (
    <div className="space-y-4">
      <Card>

        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base flex items-center gap-2"><Power className="w-4 h-4" />Controle remoto</CardTitle>
            <div className="flex gap-2">
              <Select value={farmId} onValueChange={setFarmId}>
                <SelectTrigger className="w-[260px]"><SelectValue placeholder="Selecione a fazenda" /></SelectTrigger>
                <SelectContent>
                  {farms.map(f => <SelectItem key={f.farm_id} value={f.farm_id}>{f.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={loadFarms} disabled={loading}>
                <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {farmRow ? (
            <span>Fazenda: <strong className="text-foreground">{farmRow.name}</strong> · plano <Badge variant="outline" className="uppercase">{farmRow.plan}</Badge> · licença {farmRow.license_status}</span>
          ) : "Selecione uma fazenda."}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Ações de emergência */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Ações de emergência</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <Button
              className="w-full justify-start" variant="outline"
              onClick={reboot} disabled={!farmId || busy === "reboot"}
            >
              <Power className="w-4 h-4 mr-2 text-amber-500" />
              {busy === "reboot" ? "Enviando…" : "Forçar reboot do agente Electron"}
            </Button>
            <p className="text-[11px] text-muted-foreground pl-1">
              Reinicia o serviço .exe na fazenda. Pode levar até 30s para reconectar.
            </p>
            <Button
              className="w-full justify-start" variant="outline"
              onClick={clearQueue} disabled={!farmId || busy === "clear"}
            >
              <Trash2 className="w-4 h-4 mr-2 text-destructive" />
              {busy === "clear" ? "Limpando…" : "Limpar fila de comandos travados"}
            </Button>
            <p className="text-[11px] text-muted-foreground pl-1">
              Marca como expirados todos os comandos pendentes (rádio + agente). Use quando a fazenda fica com fila travada.
            </p>
          </CardContent>
        </Card>

        {/* Toggle de módulos */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><ToggleLeft className="w-4 h-4" />Módulos opcionais</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <ModuleToggle label="Vazão" hint="Habilita aba e cards de vazão"
              checked={!!modules.vazao} disabled={!farmId || busy?.startsWith("module-")}
              onChange={(v) => toggleModule("vazao", v)} />
            <ModuleToggle label="Consumo" hint="Habilita medições de consumo elétrico"
              checked={!!modules.consumo} disabled={!farmId || busy?.startsWith("module-")}
              onChange={(v) => toggleModule("consumo", v)} />
            <ModuleToggle label="Assistente WhatsApp (IA)" hint="Libera integração WhatsApp + IA"
              checked={!!modules.ai_whatsapp} disabled={!farmId || busy?.startsWith("module-")}
              onChange={(v) => toggleModule("ai_whatsapp", v)} />
            <div className="pt-2 mt-2 border-t border-border" />
            <ModuleToggle
              label="Sino de alertas (Falhas + Sistema)"
              hint="Ativa o sino na UI: offline >15min, automático não obedecido, safety timer, horário de ponta e OTA. Mantenha desligado enquanto a RF está sendo estabilizada para evitar falsos positivos."
              checked={!!farmRow?.bell_alerts_enabled}
              disabled={!farmId || busy === "bell-alerts"}
              onChange={toggleBellAlerts}
            />
          </CardContent>
        </Card>
      </div>

      {/* Controle remoto da Bridge Serial */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Cable className="w-4 h-4 text-primary" />
              Bridge Serial — Controle remoto
            </CardTitle>
            <span className="text-[11px] text-muted-foreground font-mono">
              Porta atual: <span className="text-foreground">{health.comPort ?? "—"}</span>
              {" · "}Agente:{" "}
              <span className={health.state === "online" ? "text-primary" : "text-amber-500"}>
                {health.state.toUpperCase()}
              </span>
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[11px] text-muted-foreground">
            Comandos administrativos vão direto ao agente .exe instalado na fazenda — sem precisar de AnyDesk. Funcionam mesmo com o polling pausado.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            <Button variant="default" disabled={!farmId || bridgeBusyAny}
              onClick={() => {
                void enqueueAgentCommand({ farmId, kind: "agent_restart", payload: {}, expiresInSec: 300 });
                dispatchBridge("hard_reset_bridge");
              }} className="justify-start">
              {bridgeBusy === "hard_reset_bridge" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCw className="h-4 w-4 mr-2" />}
              Reiniciar bridge serial
            </Button>

            <Button variant="secondary" disabled={!farmId || bridgeBusyAny}
              onClick={async () => {
                setBridgeBusy("close_port");
                try {
                  await runAgentCommand({ farmId, kind: "close_port", timeoutMs: 15_000 });
                  if (health.comPort) {
                    const { result } = await runAgentCommand({ farmId, kind: "open_port", payload: { port: health.comPort }, timeoutMs: 20_000 });
                    setBridgeResult({ kind: "open_port", result });
                    if (result.status === "done") notify.ok("Bridge", "Porta COM reaberta");
                    else notify.fail("Bridge", result.error_message ?? "Falha ao reabrir");
                  }
                } catch (e: any) { notify.fail("Bridge", e?.message ?? String(e)); }
                finally { setBridgeBusy(null); }
              }}
              className="justify-start">
              {bridgeBusy === "close_port" || bridgeBusy === "open_port"
                ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                : <Power className="h-4 w-4 mr-2" />}
              Reabrir porta COM
            </Button>

            <Button variant="outline" disabled={!farmId || bridgeBusyAny}
              onClick={() => dispatchBridge("list_ports")} className="justify-start">
              {bridgeBusy === "list_ports" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ListChecks className="h-4 w-4 mr-2" />}
              Listar portas COM
            </Button>

            <Button variant="outline" disabled={!farmId || bridgeBusyAny}
              onClick={() => dispatchBridge("pause_polling")} className="justify-start">
              {bridgeBusy === "pause_polling" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <PauseCircle className="h-4 w-4 mr-2" />}
              Pausar polling
            </Button>

            <Button variant="outline" disabled={!farmId || bridgeBusyAny}
              onClick={() => dispatchBridge("resume_polling")} className="justify-start">
              {bridgeBusy === "resume_polling" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <PlayCircle className="h-4 w-4 mr-2" />}
              Retomar polling
            </Button>

            <Button variant="destructive" disabled={!farmId || bridgeBusyAny}
              onClick={() => {
                if (!confirm("Reiniciar o processo do agente Electron?\n\nO .exe vai fechar e reabrir (5–15s). Comandos pendentes serão preservados.")) return;
                dispatchBridge("agent_restart", {}, 45_000);
              }}
              className="justify-start">
              {bridgeBusy === "agent_restart" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Zap className="h-4 w-4 mr-2" />}
              Reiniciar agente (.exe)
            </Button>
          </div>

          {bridgeResult && (
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-semibold">Último resultado: {bridgeResult.kind}</span>
                <span className={
                  bridgeResult.result.status === "done" ? "text-primary font-mono"
                  : bridgeResult.result.status === "expired" ? "text-amber-600 dark:text-amber-400 font-mono"
                  : "text-destructive font-mono"
                }>
                  {bridgeResult.result.status.toUpperCase()}
                  {bridgeResult.result.duration_ms != null && ` · ${bridgeResult.result.duration_ms}ms`}
                </span>
              </div>
              {bridgeResult.result.error_message && (
                <div className="text-destructive">{bridgeResult.result.error_message}</div>
              )}
              {portsList && Array.isArray(portsList) && (
                <div className="space-y-1 pt-1">
                  <div className="text-muted-foreground">Portas detectadas:</div>
                  {portsList.length === 0 ? (
                    <div className="font-mono text-amber-600">Nenhuma porta encontrada</div>
                  ) : (
                    <ul className="font-mono text-foreground pl-3">
                      {portsList.map((p: any, i: number) => (
                        <li key={i}>• {p.path}{p.description ? ` — ${p.description}` : ""}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>


      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><MessageSquare className="w-4 h-4" />Mensagem para o operador</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label>Severidade</Label>
              <Select value={msgLevel} onValueChange={setMsgLevel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="info"><span className="flex items-center gap-2"><Info className="w-4 h-4 text-muted-foreground" />Informativo</span></SelectItem>
                  <SelectItem value="warning"><span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-500" />Aviso</span></SelectItem>
                  <SelectItem value="critical"><span className="flex items-center gap-2"><AlertOctagon className="w-4 h-4 text-destructive" />Crítico</span></SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Expira em</Label>
              <Select value={msgExpiresHours} onValueChange={setMsgExpiresHours}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 hora</SelectItem>
                  <SelectItem value="24">24 horas</SelectItem>
                  <SelectItem value="72">3 dias</SelectItem>
                  <SelectItem value="168">7 dias</SelectItem>
                  <SelectItem value="0">Não expira (até dispensar)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Título *</Label>
              <Input value={msgTitle} onChange={(e) => setMsgTitle(e.target.value)} placeholder="Ex.: Manutenção amanhã às 6h" maxLength={120} />
            </div>
          </div>
          <div>
            <Label>Mensagem *</Label>
            <Textarea value={msgBody} onChange={(e) => setMsgBody(e.target.value)} rows={3} maxLength={800}
              placeholder="A equipe técnica vai realizar manutenção preventiva no sistema de bombas amanhã às 06:00…" />
          </div>
          <div className="flex justify-end">
            <Button onClick={sendMessage} disabled={!farmId || busy === "msg"}>
              <Send className="w-4 h-4 mr-2" />
              {busy === "msg" ? "Enviando…" : "Enviar para a fazenda"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            A mensagem aparecerá como banner no topo do app para todos os usuários da fazenda. Eles podem dispensar individualmente.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function ModuleToggle({ label, hint, checked, onChange, disabled }: any) {
  return (
    <div className="flex items-center justify-between gap-3 p-3 rounded-md border">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}
