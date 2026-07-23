// ─────────────────────────────────────────────────────────────────────────────
// PumpCfgDialog — modal de configuração remota (CFG) de uma bomba
// ─────────────────────────────────────────────────────────────────────────────
// Implementa TODOS os 22 comandos do "Protocolo de Configuração Remota — RENOV
// Bomba Inteligente" extraído do firmware:
//   1. Diagnóstico/Sistema  : PING, STATUS, DUMP, SAVE, REBOOT, FACTORY_RESET
//   2. Identificação        : SET_ID, SET_TIPO, SET_DIR, SET_NN, SET_NOME
//   3. Automação            : SET_PROFILE, SET_TSEM, SET_NIVEL, SET_NIV1_PIN,
//                             SET_NIV2_PIN
//   4. Calibração analógica : SET_CALIB_N1, SET_CALIB_N2
//   5. Tempos de rádio      : SET_TX_GUARD, SET_SLOT_DELAY, SET_WATCH_DELAY,
//                             SET_WATCH_WINDOW
//
// Frame: [TSNN_CFG_]{...}[TSNN_ETX_]\r — gerado em src/lib/cfgQueue.ts
//
// REGRA CRÍTICA DO PROTOCOLO: após qualquer SET_* bem-sucedido é OBRIGATÓRIO
// enviar {SAVE} para gravar na flash NVS. O dialog faz isso automaticamente
// quando "Auto-SAVE" estiver ligado (default).

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Activity, FileText, Save, RotateCcw, Timer, AlertTriangle, Loader2,
  CheckCircle2, XCircle, Tag, Settings2, Ruler, Radio,
} from "lucide-react";
import { notify } from "@/lib/notify";
import { enqueuePumpCfg, type PumpCfgCommand } from "@/lib/cfgQueue";
import { waitForCommand, type CommandResult } from "@/hooks/useCommandTracker";
import { supabase } from "@/integrations/supabase/client";
import { buildEquipHwId } from "@/lib/cadastrosCloud";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  farmId: string;
  tsnn: string;
  plcId?: string | null;
  equipmentId?: string | null;
  equipmentName?: string;
}

interface PendingState {
  label: string;
  commandId: string;
  result?: CommandResult;
}

const PumpCfgDialog = ({ open, onOpenChange, farmId, tsnn, plcId, equipmentId, equipmentName }: Props) => {
  const [currentTsnn, setCurrentTsnn] = useState<string>(tsnn || "");

  // ── Identificação ───────────────────────────────────────────────────────
  const [setId, setSetId] = useState<string>(tsnn || "");
  const [tipo, setTipo] = useState<string>("1");
  const [dir, setDir] = useState<string>("1");
  const [nn, setNn] = useState<string>("");
  const [nome, setNome] = useState<string>("");

  // ── Automação ───────────────────────────────────────────────────────────
  const [profile, setProfile] = useState<string>("0");
  const [tsem, setTsem] = useState<string>("20");
  const [nivelEnabled, setNivelEnabled] = useState<string>("0");
  const [niv1Pin, setNiv1Pin] = useState<string>("34");
  const [niv2Pin, setNiv2Pin] = useState<string>("35");

  // ── Calibração ──────────────────────────────────────────────────────────
  const [calibN1, setCalibN1] = useState<string>("0.00");
  const [calibN2, setCalibN2] = useState<string>("0.00");

  // ── Rádio ───────────────────────────────────────────────────────────────
  const [txGuard, setTxGuard] = useState<string>("300");
  const [slotDelay, setSlotDelay] = useState<string>("0");
  const [watchDelay, setWatchDelay] = useState<string>("1000");
  const [watchWindow, setWatchWindow] = useState<string>("10000");

  // ── Estado geral ────────────────────────────────────────────────────────
  const [autoSave, setAutoSave] = useState<boolean>(true);
  const [pending, setPending] = useState<PendingState | null>(null);
  const [dumpAppliedAt, setDumpAppliedAt] = useState<string | null>(null);

  useEffect(() => {
    setCurrentTsnn(tsnn || "");
    setSetId(tsnn || "");
  }, [tsnn, open]);

  // Extrai pares chave=valor do payload de DUMP/STATUS e popula os campos do dialog
  const applyDumpResponse = (frame: string): number => {
    // Pega o conteúdo entre { e }
    const m = frame.match(/\{([^}]*)\}/);
    if (!m) return 0;
    let body = m[1];
    // Remove prefixos OK:DUMP:, OK:STATUS:, OK:DUMP, OK:STATUS
    body = body.replace(/^OK:(DUMP|STATUS):?/i, "").replace(/^OK:/i, "");
    const pairs: Record<string, string> = {};
    body.split(/[,;]/).forEach((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) return;
      const k = part.slice(0, eq).trim().toUpperCase();
      const v = part.slice(eq + 1).trim();
      if (k && v !== undefined) pairs[k] = v;
    });

    let count = 0;
    const pick = (keys: string[], setter: (v: string) => void) => {
      for (const k of keys) {
        if (pairs[k] !== undefined) { setter(pairs[k]); count++; return; }
      }
    };

    // Identificação
    pick(["ID"], (v) => { setSetId(v.toUpperCase()); setCurrentTsnn(v.toUpperCase()); });
    pick(["TIPO"], setTipo);
    pick(["DIR"], setDir);
    pick(["NN"], setNn);
    pick(["NOME"], setNome);
    // Automação
    pick(["PROFILE", "PROF"], setProfile);
    pick(["TSEM"], setTsem);
    pick(["NIVEL", "NIV"], setNivelEnabled);
    pick(["NIV1_PIN", "N1"], setNiv1Pin);
    pick(["NIV2_PIN", "N2"], setNiv2Pin);
    // Calibração
    pick(["CALIB_N1"], setCalibN1);
    pick(["CALIB_N2"], setCalibN2);
    // Rádio (firmware usa nomes curtos: TG, SD, WD, WW)
    pick(["TX_GUARD", "TG"], setTxGuard);
    pick(["SLOT_DELAY", "SD"], setSlotDelay);
    pick(["WATCH_DELAY", "WD"], setWatchDelay);
    pick(["WATCH_WINDOW", "WW"], setWatchWindow);

    return count;
  };

  const syncConfirmedIdChange = async (newTsnn: string) => {
    if (!plcId || newTsnn === tsnn) return;
    const { data: equipments, error: loadError } = await supabase
      .from("equipments")
      .select("id, saida")
      .eq("farm_id", farmId)
      .eq("plc_group_id", plcId);
    if (loadError) {
      notify.fail("Configuração de Bomba", `ID confirmado, mas falhou ao carregar vínculos: ${loadError.message}`);
      return;
    }

    const plcResult = await supabase.from("plc_groups").update({ hw_id: newTsnn }).eq("id", plcId).eq("farm_id", farmId);
    if (plcResult.error) {
      notify.fail("Configuração de Bomba", `ID confirmado, mas falhou ao atualizar PLC: ${plcResult.error.message}`);
      return;
    }

    await Promise.all((equipments ?? []).map((equipment) =>
      supabase
        .from("equipments")
        .update({ hw_id: buildEquipHwId(newTsnn, Number(equipment.saida ?? 1)) })
        .eq("id", equipment.id)
        .eq("farm_id", farmId),
    ));
    notify.ok("Configuração de Bomba", `Cadastro atualizado automaticamente para PLC ${newTsnn}`);
  };

  // Envia um comando e devolve o CommandResult
  const sendOnce = async (label: string, command: PumpCfgCommand, targetTsnn = currentTsnn): Promise<CommandResult | null> => {
    if (!farmId || !targetTsnn) {
      notify.fail("Configuração de Bomba", "PLC não identificado");
      return null;
    }
    setPending({ label, commandId: "" });
    try {
      const { commandId } = await enqueuePumpCfg({
        farmId, equipmentId: equipmentId ?? null, tsnn: targetTsnn, command, timeoutMs: 25_000,
      });
      setPending({ label, commandId });
      notify.tip("Configuração de Bomba", `${label} enfileirado…`);
      const acceptedTsnn = typeof command !== "string" && command.kind === "SET_ID" ? [command.tddnn] : [];
      const result = await waitForCommand(commandId, 45_000, { cfgFallback: { farmId, tsnn: targetTsnn, acceptedTsnn } });
      setPending({ label, commandId, result });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPending(null);
      notify.fail("Configuração de Bomba", msg);
      return null;
    }
  };

  // Envia um SET_* (ou comando avulso) e, se for SET_* e autoSave=true, dispara {SAVE} em seguida
  const send = async (label: string, command: PumpCfgCommand) => {
    const result = await sendOnce(label, command);
    if (!result) return;

    if (result.status === "executed") {
      notify.ok("Configuração de Bomba", `${label} OK (${(result.elapsedMs / 1000).toFixed(1)}s)`);
      const isSet = typeof command !== "string" && command.kind?.startsWith("SET_");
      if (typeof command !== "string" && command.kind === "SET_ID") {
        const nextTsnn = command.tddnn.toUpperCase();
        await syncConfirmedIdChange(nextTsnn);
        setCurrentTsnn(nextTsnn);
        setSetId(nextTsnn);
      }
      if (isSet && autoSave) {
        const saveTargetTsnn = typeof command !== "string" && command.kind === "SET_ID" ? command.tddnn.toUpperCase() : currentTsnn;
        const saveResult = await sendOnce("SAVE (flash)", "SAVE", saveTargetTsnn);
        if (saveResult?.status === "executed") {
          notify.ok("Configuração de Bomba", "Configuração gravada na flash");
        } else {
          notify.warn("Configuração de Bomba", "Atenção: SAVE não confirmado — alteração pode ser perdida em queda de energia");
        }
      }
    } else if (result.status === "timeout") {
      notify.fail("Configuração de Bomba", `${label}: sem resposta da bomba`);
    } else if (result.status === "unknown") {
      notify.fail("Configuração de Bomba", `${label}: aguardando resposta… verifique o log do Electron`);
    } else if (result.status === "error") {
      notify.fail("Configuração de Bomba", `${label}: ${result.errorMessage ?? result.response ?? "erro"}`);
    }
  };

  const isWorking = pending !== null && !pending.result;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!isWorking) onOpenChange(v); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Configuração da Bomba
            <Badge variant="outline" className="font-mono">{currentTsnn}</Badge>
          </DialogTitle>
          <DialogDescription>
            {equipmentName ? `${equipmentName} — ` : ""}Comandos CFG remotos via fila (priority=2). Frame: <span className="font-mono">[{currentTsnn}_CFG_]{`{...}`}[{currentTsnn}_ETX_]\r</span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between rounded-md border border-border bg-secondary/30 px-3 py-2">
          <div className="flex items-center gap-2">
            <Save className="h-4 w-4 text-primary" />
            <div>
              <Label className="text-xs font-medium">Auto-SAVE após cada SET_*</Label>
              <p className="text-[10px] text-muted-foreground">Grava na flash NVS automaticamente (recomendado)</p>
            </div>
          </div>
          <Switch checked={autoSave} onCheckedChange={setAutoSave} disabled={isWorking} />
        </div>

        {dumpAppliedAt && (
          <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
            <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
            <span className="text-foreground">
              Configuração atual da bomba carregada via DUMP às <span className="font-mono">{dumpAppliedAt}</span> — campos das abas Identificação, Automação, Calibração e Rádio refletem o que está na flash da bomba.
            </span>
          </div>
        )}

        <Tabs defaultValue="diag" className="w-full">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="diag" className="gap-1"><Activity className="h-3 w-3" />Diag.</TabsTrigger>
            <TabsTrigger value="ident" className="gap-1"><Tag className="h-3 w-3" />ID</TabsTrigger>
            <TabsTrigger value="auto" className="gap-1"><Settings2 className="h-3 w-3" />Auto.</TabsTrigger>
            <TabsTrigger value="calib" className="gap-1"><Ruler className="h-3 w-3" />Calib.</TabsTrigger>
            <TabsTrigger value="radio" className="gap-1"><Radio className="h-3 w-3" />Rádio</TabsTrigger>
          </TabsList>

          {/* ── 1. DIAGNÓSTICO E SISTEMA ──────────────────────────────── */}
          <TabsContent value="diag" className="space-y-3 mt-4">
            <p className="text-xs text-muted-foreground">Comandos sem parâmetro. Não exigem SAVE.</p>
            <div className="grid grid-cols-3 gap-2">
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("PING", "PING")} className="gap-2">
                <Activity className="h-4 w-4" /> PING
              </Button>
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("STATUS", "STATUS")} className="gap-2">
                <Activity className="h-4 w-4" /> STATUS
              </Button>
              <Button variant="outline" size="sm" disabled={isWorking} onClick={async () => {
                const result = await sendOnce("DUMP", "DUMP");
                if (result?.status === "executed" && result.response) {
                  const n = applyDumpResponse(result.response);
                  if (n > 0) {
                    setDumpAppliedAt(new Date().toLocaleTimeString());
                    notify.ok("Configuração de Bomba", `DUMP carregado: ${n} parâmetros aplicados nas abas`);
                  } else {
                    notify.warn("Configuração de Bomba", "DUMP recebido, mas nenhum parâmetro reconhecido no payload");
                  }
                } else if (result?.status === "timeout") {
                  notify.fail("Configuração de Bomba", "DUMP: sem resposta da bomba");
                } else if (result?.status === "error") {
                  notify.fail("Configuração de Bomba", `DUMP: ${result.errorMessage ?? result.response ?? "erro"}`);
                }
              }} className="gap-2">
                <FileText className="h-4 w-4" /> DUMP
              </Button>
            </div>
            <Separator />
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("SAVE", "SAVE")} className="gap-2">
                <Save className="h-4 w-4" /> Salvar memória
              </Button>
              <Button variant="outline" size="sm" disabled={isWorking} onClick={() => send("REBOOT", "REBOOT")} className="gap-2">
                <RotateCcw className="h-4 w-4" /> Reiniciar bomba
              </Button>
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={isWorking}
              onClick={() => {
                if (confirm("FACTORY_RESET apaga TODAS as configurações da bomba e reinicia. Continuar?")) {
                  void send("FACTORY_RESET", "FACTORY_RESET");
                }
              }}
              className="w-full gap-2"
            >
              <AlertTriangle className="h-4 w-4" /> Reset de fábrica
            </Button>
          </TabsContent>

          {/* ── 2. IDENTIFICAÇÃO ──────────────────────────────────────── */}
          <TabsContent value="ident" className="space-y-3 mt-4">
            <div className="space-y-1.5">
              <Label className="text-xs">ID Completo (TDDNN — Tipo+Direção+NN hex)</Label>
              <div className="flex gap-2">
                <Input value={setId} maxLength={4} onChange={e => setSetId(e.target.value.toUpperCase())} className="font-mono" placeholder="1107" />
                <Button size="sm" disabled={isWorking || setId.length !== 4} onClick={() => send(`SET_ID=${setId}`, { kind: "SET_ID", tddnn: setId })}>Enviar</Button>
              </div>
              <p className="text-[10px] text-muted-foreground">T=1-3, D=1-3, NN=00-FF. Ex: 1107</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Tipo</Label>
                <div className="flex gap-2">
                  <Select value={tipo} onValueChange={setTipo}>
                    <SelectTrigger className="font-mono"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 — Poço</SelectItem>
                      <SelectItem value="2">2 — Bombeamento</SelectItem>
                      <SelectItem value="3">3 — Nível</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button size="sm" disabled={isWorking} onClick={() => send(`SET_TIPO=${tipo}`, { kind: "SET_TIPO", value: Number(tipo) as 1 | 2 | 3 })}>OK</Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Direção</Label>
                <div className="flex gap-2">
                  <Select value={dir} onValueChange={setDir}>
                    <SelectTrigger className="font-mono"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 — A</SelectItem>
                      <SelectItem value="2">2 — B</SelectItem>
                      <SelectItem value="3">3 — C</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button size="sm" disabled={isWorking} onClick={() => send(`SET_DIR=${dir}`, { kind: "SET_DIR", value: Number(dir) as 1 | 2 | 3 })}>OK</Button>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Número (NN — hex 00..FF)</Label>
              <div className="flex gap-2">
                <Input value={nn} maxLength={2} onChange={e => setNn(e.target.value.toUpperCase().replace(/[^0-9A-F]/g, ""))} className="font-mono" placeholder="07" />
                <Button size="sm" disabled={isWorking || nn.length === 0} onClick={() => send(`SET_NN=${nn}`, { kind: "SET_NN", hex: nn })}>Enviar</Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Nome do Poço (até 31 caracteres)</Label>
              <div className="flex gap-2">
                <Input value={nome} maxLength={31} onChange={e => setNome(e.target.value)} placeholder="Bomba Norte 01" />
                <Button size="sm" disabled={isWorking || nome.length === 0} onClick={() => send(`SET_NOME="${nome}"`, { kind: "SET_NOME", text: nome })}>Enviar</Button>
              </div>
            </div>
          </TabsContent>

          {/* ── 3. AUTOMAÇÃO ──────────────────────────────────────────── */}
          <TabsContent value="auto" className="space-y-3 mt-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Perfil de Operação</Label>
              <div className="flex gap-2">
                <Select value={profile} onValueChange={setProfile}>
                  <SelectTrigger className="font-mono"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">0 — Direto</SelectItem>
                    <SelectItem value="1">1 — Auto</SelectItem>
                    <SelectItem value="2">2 — Bombeamento</SelectItem>
                    <SelectItem value="3">3 — Pulso Manu/Auto</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" disabled={isWorking} onClick={() => send(`SET_PROFILE=${profile}`, { kind: "SET_PROFILE", value: Number(profile) as 0 | 1 | 2 | 3 })}>Enviar</Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs flex items-center gap-1.5"><Timer className="h-3 w-3" /> Timeout sem Comunicação (min, 1..10080)</Label>
              <div className="flex gap-2">
                <Input type="number" min={1} max={10080} value={tsem} onChange={e => setTsem(e.target.value)} className="font-mono" />
                <Button size="sm" disabled={isWorking} onClick={() => send(`SET_TSEM=${tsem}`, { kind: "SET_TSEM", minutes: Number(tsem) || 0 })}>Enviar</Button>
              </div>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <Label className="text-xs">Sensores de nível</Label>
              <div className="flex gap-2">
                <Select value={nivelEnabled} onValueChange={setNivelEnabled}>
                  <SelectTrigger className="font-mono"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">0 — Desativado</SelectItem>
                    <SelectItem value="1">1 — Ativado</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" disabled={isWorking} onClick={() => send(`SET_NIVEL=${nivelEnabled}`, { kind: "SET_NIVEL", value: Number(nivelEnabled) as 0 | 1 })}>Enviar</Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">GPIO Sensor Nível 1</Label>
                <div className="flex gap-2">
                  <Input type="number" min={0} max={39} value={niv1Pin} onChange={e => setNiv1Pin(e.target.value)} className="font-mono" />
                  <Button size="sm" disabled={isWorking} onClick={() => send(`SET_NIV1_PIN=${niv1Pin}`, { kind: "SET_NIV1_PIN", gpio: Number(niv1Pin) || 0 })}>OK</Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">GPIO Sensor Nível 2</Label>
                <div className="flex gap-2">
                  <Input type="number" min={0} max={39} value={niv2Pin} onChange={e => setNiv2Pin(e.target.value)} className="font-mono" />
                  <Button size="sm" disabled={isWorking} onClick={() => send(`SET_NIV2_PIN=${niv2Pin}`, { kind: "SET_NIV2_PIN", gpio: Number(niv2Pin) || 0 })}>OK</Button>
                </div>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">0 desativa o pino. Valores típicos no ESP32: 34, 35, 32, 33.</p>
          </TabsContent>

          {/* ── 4. CALIBRAÇÃO ─────────────────────────────────────────── */}
          <TabsContent value="calib" className="space-y-3 mt-4">
            <p className="text-xs text-muted-foreground">Valores em <strong>metros</strong>. O firmware converte para cm internamente.</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Calibração Nível 1 (m)</Label>
                <div className="flex gap-2">
                  <Input type="number" step="0.01" min={0} value={calibN1} onChange={e => setCalibN1(e.target.value)} className="font-mono" />
                  <Button size="sm" disabled={isWorking} onClick={() => send(`SET_CALIB_N1=${calibN1}`, { kind: "SET_CALIB_N1", meters: Number(calibN1) || 0 })}>Enviar</Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Calibração Nível 2 (m)</Label>
                <div className="flex gap-2">
                  <Input type="number" step="0.01" min={0} value={calibN2} onChange={e => setCalibN2(e.target.value)} className="font-mono" />
                  <Button size="sm" disabled={isWorking} onClick={() => send(`SET_CALIB_N2=${calibN2}`, { kind: "SET_CALIB_N2", meters: Number(calibN2) || 0 })}>Enviar</Button>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* ── 5. TEMPOS DE RÁDIO ────────────────────────────────────── */}
          <TabsContent value="radio" className="space-y-3 mt-4">
            <p className="text-xs text-muted-foreground">Avançado — alterar apenas com orientação técnica.</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">TX Guard (ms, 50..5000)</Label>
                <div className="flex gap-2">
                  <Input type="number" min={50} max={5000} value={txGuard} onChange={e => setTxGuard(e.target.value)} className="font-mono" />
                  <Button size="sm" disabled={isWorking} onClick={() => send(`SET_TX_GUARD=${txGuard}`, { kind: "SET_TX_GUARD", ms: Number(txGuard) || 0 })}>OK</Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Anti-colisão (s, 0..120)</Label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    step="0.1"
                    min={0}
                    max={120}
                    value={(Number(slotDelay) / 1000).toString()}
                    onChange={e => setSlotDelay(String(Math.round(Number(e.target.value) * 1000)))}
                    className="font-mono"
                  />
                  <Button size="sm" disabled={isWorking} onClick={() => send(`SET_SLOT_DELAY=${slotDelay}`, { kind: "SET_SLOT_DELAY", ms: Number(slotDelay) || 0 })}>OK</Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Atraso de Detecção (s, 0,1..30)</Label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    step="0.1"
                    min={0.1}
                    max={30}
                    value={(Number(watchDelay) / 1000).toString()}
                    onChange={e => setWatchDelay(String(Math.round(Number(e.target.value) * 1000)))}
                    className="font-mono"
                  />
                  <Button size="sm" disabled={isWorking} onClick={() => send(`SET_WATCH_DELAY=${watchDelay}`, { kind: "SET_WATCH_DELAY", ms: Number(watchDelay) || 0 })}>OK</Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Janela de Espera (s, 1..300)</Label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    step="0.5"
                    min={1}
                    max={300}
                    value={(Number(watchWindow) / 1000).toString()}
                    onChange={e => setWatchWindow(String(Math.round(Number(e.target.value) * 1000)))}
                    className="font-mono"
                  />
                  <Button size="sm" disabled={isWorking} onClick={() => send(`SET_WATCH_WINDOW=${watchWindow}`, { kind: "SET_WATCH_WINDOW", ms: Number(watchWindow) || 0 })}>OK</Button>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {/* ── Resultado ao vivo ─────────────────────────────────────── */}
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
              <pre className="font-mono text-xs text-foreground bg-background rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap">
                {pending.result.response}
              </pre>
            )}
            {pending.result?.errorMessage && (
              <p className="text-xs text-destructive">{pending.result.errorMessage}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default PumpCfgDialog;
