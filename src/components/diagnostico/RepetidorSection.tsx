import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LogIn, LogOut, Radio, Plus, Trash2, List, Save, RotateCcw, Activity, FileText, HelpCircle, ChevronDown, ChevronUp, Edit2, Check, X } from "lucide-react";
import { notify } from "@/lib/notify";
import { buildRepetidorCfg, isRepResponseLine } from "@/lib/protocol";

interface Repetidor {
  id: string;
  name: string;
  loggedIn: boolean;
  senha: string;
  selectedRadio: string;
  nnInput: string;
  sValue: string;
  log: string[];
  collapsed: boolean;
}

const createRepetidor = (id: string, name: string): Repetidor => ({
  id, name, loggedIn: false, senha: "renovrenov", selectedRadio: "R1",
  nnInput: "", sValue: "3", log: [`[Sistema] Aguardando login no ${name}...`], collapsed: false,
});

const RepetidorSection = ({ diagnosticoAtivo }: { diagnosticoAtivo?: boolean }) => {
  const [repetidores, setRepetidores] = useState<Repetidor[]>([createRepetidor("rep-1", "Repetidor 1")]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const updateRep = (id: string, updates: Partial<Repetidor>) => {
    setRepetidores(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));
  };

  const addLog = (id: string, msg: string, type: "tx" | "rx" | "info" | "error" = "info") => {
    const time = new Date().toLocaleTimeString();
    const prefix = type === "tx" ? "TX" : type === "rx" ? "RX" : type === "error" ? "ERR" : "INFO";
    setRepetidores(prev => prev.map(r =>
      r.id === id ? { ...r, log: [...r.log, `[${time}] [${prefix}] ${msg}`] } : r
    ));
  };

  useEffect(() => {
    const unsub = (window as any).serialAPI?.onData?.((line: string) => {
      if (!isRepResponseLine(line)) return;
      const active = repetidores.find(r => !r.collapsed) || repetidores[0];
      if (active) addLog(active.id, line.replace(/^REP_RESP:\s*/, ""), "rx");
    });
    return () => { if (unsub) unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repetidores]);

  const addRepetidor = () => {
    const id = `rep-${Date.now()}`;
    setRepetidores(prev => [...prev, createRepetidor(id, `Repetidor ${prev.length + 1}`)]);
    notify.ok("Repetidor", "Novo Repetidor adicionado");
  };

  const removeRepetidor = (id: string) => {
    if (repetidores.length <= 1) { notify.fail("Repetidor", "Deve haver pelo menos um Repetidor"); return; }
    setRepetidores(prev => prev.filter(r => r.id !== id));
    notify.tip("Repetidor", "Repetidor removido");
  };

  const writeRep = async (rep: Repetidor, cfgCmd: string) => {
    if (!(window as any).serialAPI?.isOpen()) { notify.fail("Repetidor", "Conecte a porta serial primeiro"); return; }
    const line = buildRepetidorCfg(cfgCmd);
    addLog(rep.id, line, "tx");
    try {
      await (window as any).serialAPI!.write(line);
      notify.ok("Repetidor", "Comando enviado");
    } catch (e: any) {
      addLog(rep.id, e?.message || String(e), "error");
      notify.fail("Repetidor", e?.message || String(e));
    }
  };

  const handleLogin = async (rep: Repetidor) => { await writeRep(rep, `CFG:LOGIN:${rep.senha}`); updateRep(rep.id, { loggedIn: true }); };
  const handleLogout = async (rep: Repetidor) => { await writeRep(rep, `CFG:LOGOUT`); updateRep(rep.id, { loggedIn: false }); };

  const sendCommand = async (rep: Repetidor, cmd: string) => {
    if (!rep.loggedIn && cmd.startsWith("CFG:") && !cmd.startsWith("CFG:PING")) { notify.fail("Repetidor", "Faça login primeiro"); return; }
    await writeRep(rep, cmd);
  };

  const startEditing = (rep: Repetidor) => { setEditingId(rep.id); setEditName(rep.name); };
  const confirmEdit = (id: string) => { if (editName.trim()) updateRep(id, { name: editName.trim() }); setEditingId(null); };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Repetidores</h2>
          <p className="text-sm text-muted-foreground">Configuração dos Repetidores LoRa ({repetidores.length})</p>
        </div>
        <Button onClick={addRepetidor} className="gap-2"><Plus className="h-4 w-4" /> Adicionar Repetidor</Button>
      </div>

      {repetidores.map((rep) => (
        <div key={rep.id} className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-secondary/30">
            <div className="flex items-center gap-3">
              <Radio className="h-4 w-4 text-primary" />
              {editingId === rep.id ? (
                <div className="flex items-center gap-1.5">
                  <Input value={editName} onChange={e => setEditName(e.target.value)} className="h-7 w-48 text-sm" autoFocus onKeyDown={e => e.key === "Enter" && confirmEdit(rep.id)} />
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => confirmEdit(rep.id)}><Check className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditingId(null)}><X className="h-3.5 w-3.5" /></Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-foreground">{rep.name}</span>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => startEditing(rep)}><Edit2 className="h-3 w-3 text-muted-foreground" /></Button>
                </div>
              )}
              <Badge variant={rep.loggedIn ? "default" : "secondary"} className="gap-1.5 text-xs">
                <div className={`h-1.5 w-1.5 rounded-full ${rep.loggedIn ? "bg-primary animate-pulse" : "bg-muted-foreground"}`} />
                {rep.loggedIn ? "Online" : "Offline"}
              </Badge>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:bg-destructive/10" onClick={() => removeRepetidor(rep.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => updateRep(rep.id, { collapsed: !rep.collapsed })}>
                {rep.collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {!rep.collapsed && (
            <div className="p-5 space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-3">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Sessão</h4>
                  <div className="space-y-2">
                    <Label className="text-sm">Senha</Label>
                    <Input value={rep.senha} onChange={e => updateRep(rep.id, { senha: e.target.value })} type="password" className="font-mono" />
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={() => handleLogin(rep)} disabled={rep.loggedIn} className="flex-1 gap-2" size="sm"><LogIn className="h-3.5 w-3.5" /> Login</Button>
                    <Button onClick={() => handleLogout(rep)} disabled={!rep.loggedIn} variant="outline" className="flex-1 gap-2" size="sm"><LogOut className="h-3.5 w-3.5" /> Logout</Button>
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-3">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Comandos Rápidos</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="outline" size="sm" className="gap-1.5 justify-start text-xs" onClick={() => sendCommand(rep, "CFG:PING")}><Activity className="h-3.5 w-3.5" /> PING</Button>
                    <Button variant="outline" size="sm" className="gap-1.5 justify-start text-xs" onClick={() => sendCommand(rep, "CFG:STATUS")}><Radio className="h-3.5 w-3.5" /> STATUS</Button>
                    <Button variant="outline" size="sm" className="gap-1.5 justify-start text-xs" onClick={() => sendCommand(rep, "CFG:DUMP")}><FileText className="h-3.5 w-3.5" /> DUMP</Button>
                    <Button variant="outline" size="sm" className="gap-1.5 justify-start text-xs" onClick={() => sendCommand(rep, "CFG:HELP")}><HelpCircle className="h-3.5 w-3.5" /> HELP</Button>
                    <Button variant="outline" size="sm" className="gap-1.5 justify-start text-xs" onClick={() => sendCommand(rep, "CFG:SAVE")}><Save className="h-3.5 w-3.5" /> SAVE</Button>
                    <Button variant="outline" size="sm" className="gap-1.5 justify-start text-xs" onClick={() => sendCommand(rep, "CFG:LOAD")}><RotateCcw className="h-3.5 w-3.5" /> LOAD</Button>
                  </div>
                  <Button variant="destructive" size="sm" className="w-full gap-2 text-xs" onClick={() => sendCommand(rep, "CFG:RESET")}><RotateCcw className="h-3.5 w-3.5" /> RESET</Button>
                </div>

                <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-3">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Região (S)</h4>
                  <Select value={rep.sValue} onValueChange={v => updateRep(rep.id, { sValue: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[1,2,3,4,5,6,7,8,9].map(n => <SelectItem key={n} value={String(n)}>S = {n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => sendCommand(rep, "CFG:GET_S")}>Ler S</Button>
                    <Button size="sm" className="flex-1" onClick={() => sendCommand(rep, `CFG:SET_S:${rep.sValue}`)}>Definir S</Button>
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-3">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Gestão de NNs</h4>
                  <div className="flex gap-2">
                    <div className="space-y-1 flex-1">
                      <Label className="text-xs">Rádio</Label>
                      <Select value={rep.selectedRadio} onValueChange={v => updateRep(rep.id, { selectedRadio: v })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="R1">R1</SelectItem>
                          <SelectItem value="R2">R2</SelectItem>
                          <SelectItem value="R3">R3</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1 flex-1">
                      <Label className="text-xs">NN (hex)</Label>
                      <Input value={rep.nnInput} onChange={e => updateRep(rep.id, { nnInput: e.target.value.toUpperCase() })} placeholder="0A" className="font-mono" maxLength={2} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => sendCommand(rep, `CFG:ADD:${rep.selectedRadio}:${rep.nnInput}`)}><Plus className="h-3.5 w-3.5" /> Adicionar</Button>
                    <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => sendCommand(rep, `CFG:DEL:${rep.selectedRadio}:${rep.nnInput}`)}><Trash2 className="h-3.5 w-3.5" /> Remover</Button>
                    <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => sendCommand(rep, `CFG:LIST:${rep.selectedRadio}`)}><List className="h-3.5 w-3.5" /> Listar</Button>
                    <Button variant="outline" size="sm" className="gap-1.5 text-xs text-destructive" onClick={() => sendCommand(rep, `CFG:CLEAR:${rep.selectedRadio}`)}><Trash2 className="h-3.5 w-3.5" /> Limpar</Button>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-secondary/20 p-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Log</h4>
                  <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => updateRep(rep.id, { log: [] })}>Limpar</Button>
                </div>
                <div className="h-36 rounded-lg bg-secondary p-3 font-mono text-xs text-foreground overflow-y-auto space-y-0.5">
                  {rep.log.map((line, i) => (
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
          )}
        </div>
      ))}
    </div>
  );
};

export default RepetidorSection;
