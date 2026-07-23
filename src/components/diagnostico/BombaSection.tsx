import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Power, PowerOff, Activity, FileText, Save, RotateCcw, Settings, Droplets, Timer, Radio } from "lucide-react";
import { notify } from "@/lib/notify";
import { buildLoRaFrame, buildDirectToServer, buildViaRepetidorTx, isBombaResponseLine, type Radio as RadioType } from "@/lib/protocol";

const BombaSection = ({ diagnosticoAtivo }: { diagnosticoAtivo?: boolean }) => {
  const [bombaId, setBombaId] = useState("1107");
  const [bombaName, setBombaName] = useState("POCO 7 CENTRAL");
  const [tipo, setTipo] = useState("1");
  const [dir, setDir] = useState("1");
  const [nn, setNn] = useState("07");
  const [tsem, setTsem] = useState([5]);
  const [watchDelay, setWatchDelay] = useState([500]);
  const [watchWindow, setWatchWindow] = useState([5000]);
  const [txGuard, setTxGuard] = useState([200]);
  const [slotDelay, setSlotDelay] = useState([1000]);
  const [profile, setProfile] = useState("0");
  const [nivelEnabled, setNivelEnabled] = useState(false);
  const [selectedRadio, setSelectedRadio] = useState("R1");
  const [viaRepetidor, setViaRepetidor] = useState(true);
  const [log, setLog] = useState<string[]>(["[Sistema] Pronto para configurar bomba..."]);

  const addLog = (msg: string, type: "tx" | "rx" | "info" = "info") => {
    const time = new Date().toLocaleTimeString();
    const prefix = type === "tx" ? "TX" : type === "rx" ? "RX" : "INFO";
    setLog(prev => [...prev, `[${time}] [${prefix}] ${msg}`]);
  };

  const buildCommandLine = (cmd: string, payload: string) => {
    const frame = buildLoRaFrame(bombaId, cmd, payload);
    if (viaRepetidor) return buildViaRepetidorTx(selectedRadio as RadioType, frame);
    return buildDirectToServer(selectedRadio as RadioType, frame);
  };

  const sendCmd = async (cmd: string, payload: string) => {
    if (!(window as any).serialAPI?.isOpen()) { notify.fail("Bomba", "Conecte a porta serial primeiro"); return; }
    const line = buildCommandLine(cmd, payload);
    addLog(line, "tx");
    try {
      await (window as any).serialAPI!.write(line);
      notify.ok("Bomba", "Comando enviado");
    } catch (e: any) {
      addLog(e?.message || String(e), "info");
      notify.fail("Bomba", e?.message || String(e));
    }
  };

  useEffect(() => {
    const unsub = (window as any).serialAPI?.onData?.((line: string) => {
      if (!isBombaResponseLine(line)) return;
      if (line.includes(`[${bombaId}_`) || line.includes(`_[${bombaId}_`)) {
        addLog(line, "rx");
      }
    });
    return () => { if (unsub) unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bombaId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Bomba (Receptor)</h2>
          <p className="text-sm text-muted-foreground">Configuração da bomba inteligente</p>
        </div>
        <Badge variant="outline" className="font-mono">{bombaId}</Badge>
      </div>

      {/* Roteamento */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch checked={viaRepetidor} onCheckedChange={setViaRepetidor} />
            <Label className="text-sm">{viaRepetidor ? "Via Repetidor (REP:R3)" : "Directo (Servidor)"}</Label>
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-sm">Rádio:</Label>
            <Select value={selectedRadio} onValueChange={setSelectedRadio}>
              <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="R1">R1</SelectItem>
                <SelectItem value="R2">R2</SelectItem>
                <SelectItem value="R3">R3</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 ml-auto">
            <Button className="gap-2" onClick={() => sendCmd("1", "1")}><Power className="h-4 w-4" /> Ligar</Button>
            <Button variant="destructive" className="gap-2" onClick={() => sendCmd("1", "0")}><PowerOff className="h-4 w-4" /> Desligar</Button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Identificação */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Settings className="h-4 w-4 text-primary" /> Identificação
          </h3>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Tipo</Label>
              <Select value={tipo} onValueChange={setTipo}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 - Poço</SelectItem>
                  <SelectItem value="2">2 - Bombeamento</SelectItem>
                  <SelectItem value="3">3 - Nível</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Direcção</Label>
              <Select value={dir} onValueChange={setDir}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Região 1</SelectItem>
                  <SelectItem value="2">Região 2</SelectItem>
                  <SelectItem value="3">Região 3</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">NN (hex)</Label>
              <Input value={nn} onChange={e => setNn(e.target.value.toUpperCase())} className="font-mono" maxLength={2} />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Nome</Label>
            <Input value={bombaName} onChange={e => setBombaName(e.target.value)} maxLength={20} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button className="gap-2" onClick={() => { const newId = `${tipo}${dir}${nn}`; setBombaId(newId); sendCmd("CFG", `SET_ID:${newId}`); }}>SET_ID</Button>
            <Button variant="outline" className="gap-2" onClick={() => sendCmd("CFG", `SET_NOME:${bombaName}`)}>SET_NOME</Button>
            <Button variant="outline" className="gap-2" onClick={() => sendCmd("CFG", `SET_TIPO:${tipo}`)}>SET_TIPO</Button>
            <Button variant="outline" className="gap-2" onClick={() => sendCmd("CFG", `SET_DIR:${dir}`)}>SET_DIR</Button>
          </div>
        </div>

        {/* Comandos */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" /> Comandos
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" className="gap-2 justify-start" onClick={() => sendCmd("CFG", "PING")}><Activity className="h-4 w-4" /> PING</Button>
            <Button variant="outline" className="gap-2 justify-start" onClick={() => sendCmd("CFG", "STATUS")}><Radio className="h-4 w-4" /> STATUS</Button>
            <Button variant="outline" className="gap-2 justify-start" onClick={() => sendCmd("CFG", "DUMP")}><FileText className="h-4 w-4" /> DUMP</Button>
            <Button variant="outline" className="gap-2 justify-start" onClick={() => sendCmd("CFG", "SAVE")}><Save className="h-4 w-4" /> SAVE</Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" className="gap-2 justify-start" onClick={() => sendCmd("CFG", "REBOOT")}><RotateCcw className="h-4 w-4" /> REBOOT</Button>
            <Button variant="destructive" className="gap-2 justify-start" onClick={() => sendCmd("CFG", "FACTORY_RESET")}><RotateCcw className="h-4 w-4" /> FACTORY RESET</Button>
          </div>
        </div>

        {/* Tempos Anti-Colisão */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Timer className="h-4 w-4 text-primary" /> Tempos Anti-Colisão
          </h3>
          <div className="space-y-3">
            {[
              { label: "Timeout sem Comunicação", value: tsem, set: setTsem, min: 1, max: 60, step: 1, unit: "min", cmd: "SET_TSEM", scale: 1 },
              { label: "Atraso de Detecção", value: watchDelay, set: setWatchDelay, min: 100, max: 5000, step: 100, unit: "s", cmd: "SET_WATCH_DELAY", scale: 1000 },
              { label: "Janela de Espera", value: watchWindow, set: setWatchWindow, min: 1000, max: 30000, step: 500, unit: "s", cmd: "SET_WATCH_WINDOW", scale: 1000 },
              { label: "TX Guard", value: txGuard, set: setTxGuard, min: 50, max: 5000, step: 50, unit: "ms", cmd: "SET_TX_GUARD", scale: 1 },
              { label: "Anti-colisão", value: slotDelay, set: setSlotDelay, min: 0, max: 10000, step: 100, unit: "s", cmd: "SET_SLOT_DELAY", scale: 1000 },
            ].map((s) => (
              <div key={s.cmd} className="space-y-1">
                <div className="flex justify-between">
                  <Label className="text-xs">{s.label} ({s.unit})</Label>
                  <span className="font-mono text-xs text-primary">{s.scale === 1000 ? (s.value[0] / 1000).toFixed(s.value[0] % 1000 === 0 ? 0 : 1) : s.value[0]} {s.unit}</span>
                </div>
                <Slider value={s.value} onValueChange={s.set} min={s.min} max={s.max} step={s.step} />
                <Button variant="outline" size="sm" className="w-full" onClick={() => sendCmd("CFG", `${s.cmd}:${s.value[0]}`)}>
                  Enviar {s.cmd}
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* Perfil e Nível */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Droplets className="h-4 w-4 text-primary" /> Perfil e Nível
          </h3>
          <div className="space-y-2">
            <Label className="text-xs">Perfil</Label>
            <Select value={profile} onValueChange={setProfile}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0 - Padrão</SelectItem>
                <SelectItem value="1">1 - Alternativo</SelectItem>
                <SelectItem value="2">2 - Bombeamento</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" className="w-full" onClick={() => sendCmd("CFG", `SET_PROFILE:${profile}`)}>Enviar SET_PROFILE</Button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Sensor de Nível</Label>
              <p className="text-xs text-muted-foreground">Activar sensor de nível</p>
            </div>
            <Switch checked={nivelEnabled} onCheckedChange={setNivelEnabled} />
          </div>
          <Button variant="outline" size="sm" className="w-full" onClick={() => sendCmd("CFG", `SET_NIVEL:${nivelEnabled ? 1 : 0}`)}>Enviar SET_NIVEL</Button>
        </div>
      </div>

      {/* Log */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">Log de Comunicação</h3>
          <Button variant="ghost" size="sm" onClick={() => setLog([])}>Limpar</Button>
        </div>
        <div className="h-48 rounded-lg bg-secondary p-3 font-mono text-xs text-foreground overflow-y-auto space-y-0.5">
          {log.map((line, i) => (
            <p key={i} className={
              line.includes("[TX]") ? "text-info" :
              line.includes("[RX]") ? "text-primary" :
              line.includes("[ERR]") ? "text-destructive" :
              "text-muted-foreground"
            }>{line}</p>
          ))}
        </div>
      </div>
    </div>
  );
};

export default BombaSection;
