import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Plug, Unplug, RefreshCw, Timer } from "lucide-react";
import { notify } from "@/lib/notify";

type PortInfo = { path: string; manufacturer?: string };

const SerialConfigSection = () => {
  const [connected, setConnected] = useState(false);
  const [port, setPort] = useState("");
  const [baudRate, setBaudRate] = useState("9600");
  const [dataBits, setDataBits] = useState("8");
  const [parity, setParity] = useState("none");
  const [stopBits, setStopBits] = useState("1");
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [diagLog, setDiagLog] = useState<string[]>([]);

  const addDiag = (msg: string) => setDiagLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  const refreshPorts = async () => {
    try {
      if (!window.serialAPI) {
        addDiag("ERRO: serialAPI não disponível (execute no Electron)");
        notify.fail("Porta Serial", "serialAPI não disponível (execute no Electron)");
        return;
      }
      addDiag("Buscando portas...");
      const list = await window.serialAPI.list();
      addDiag("Portas encontradas: " + JSON.stringify(list.map((p) => p.path)));
      setPorts(list.map((p) => ({ path: p.path, manufacturer: p.manufacturer })));
      if (list.length === 0) addDiag("Nenhuma porta COM encontrada");
      notify.tip("Porta Serial", "Portas atualizadas");
    } catch (e: any) {
      addDiag("ERRO: " + (e?.message || String(e)));
      notify.fail("Porta Serial", e?.message || String(e));
    }
  };

  useEffect(() => {
    addDiag("=== INICIALIZAÇÃO ===");
    addDiag("serialAPI: " + (typeof window.serialAPI));

    if (window.serialAPI?.health) {
      const h = window.serialAPI.health();
      addDiag("health(): " + JSON.stringify(h));
    }

    refreshPorts();
    setConnected(!!window.serialAPI?.isOpen?.());

    const unsub = window.serialAPI?.onStatus?.((evt) => {
      addDiag("Status: " + JSON.stringify(evt));
      if (evt.type === "open") setConnected(true);
      if (evt.type === "close") setConnected(false);
      if (evt.type === "error") notify.fail("Porta Serial", evt.message || "Erro na serial");
    });

    return () => { if (unsub) unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = async () => {
    if (!port) return notify.fail("Porta Serial", "Selecione uma porta COM");
    try {
      await window.serialAPI!.open({ path: port, baudRate, dataBits, parity: parity as any, stopBits });
      notify.ok("Porta Serial", `Conectado à ${port} @ ${baudRate} bps`);
    } catch (e: any) {
      notify.fail("Porta Serial", e?.message || String(e));
    }
  };

  const handleDisconnect = async () => {
    try {
      await window.serialAPI!.close();
      notify.tip("Porta Serial", "Porta serial desconectada");
    } catch (e: any) {
      notify.fail("Porta Serial", e?.message || String(e));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Porta Serial</h2>
          <p className="text-sm text-muted-foreground">Configuração da comunicação RS-485</p>
        </div>
        <Badge variant={connected ? "default" : "secondary"} className="gap-1.5">
          <div className={`h-2 w-2 rounded-full ${connected ? "bg-primary animate-pulse" : "bg-muted-foreground"}`} />
          {connected ? `Conectado (${port || "..."})` : "Desconectado"}
        </Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Conexão */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-5">
          <h3 className="text-sm font-semibold text-card-foreground">Conexão</h3>

          <div className="space-y-2">
            <Label className="text-sm">Porta COM</Label>
            <div className="flex gap-2">
              <Select value={port} onValueChange={setPort}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="Selecione a porta" /></SelectTrigger>
                <SelectContent>
                  {ports.length === 0 ? (
                    <SelectItem value="_none" disabled>Nenhuma porta encontrada</SelectItem>
                  ) : (
                    ports.map((p) => (
                      <SelectItem key={p.path} value={p.path}>
                        {p.path}{p.manufacturer ? ` • ${p.manufacturer}` : ""}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={refreshPorts}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm">Baud Rate</Label>
            <Select value={baudRate} onValueChange={setBaudRate}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["2400", "4800", "9600", "19200", "38400", "57600", "115200"].map(b => (
                  <SelectItem key={b} value={b}>{b} bps</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-2 pt-2">
            {!connected ? (
              <Button onClick={handleConnect} className="flex-1 gap-2">
                <Plug className="h-4 w-4" /> Conectar
              </Button>
            ) : (
              <Button onClick={handleDisconnect} variant="destructive" className="flex-1 gap-2">
                <Unplug className="h-4 w-4" /> Desconectar
              </Button>
            )}
          </div>
        </div>

        {/* Parâmetros Avançados */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-5">
          <h3 className="text-sm font-semibold text-card-foreground">Parâmetros Avançados</h3>

          <div className="space-y-2">
            <Label className="text-sm">Data Bits</Label>
            <Select value={dataBits} onValueChange={setDataBits}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["7", "8"].map(d => (
                  <SelectItem key={d} value={d}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-sm">Paridade</Label>
            <Select value={parity} onValueChange={setParity}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nenhuma</SelectItem>
                <SelectItem value="even">Par (Even)</SelectItem>
                <SelectItem value="odd">Ímpar (Odd)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-sm">Stop Bits</Label>
            <Select value={stopBits} onValueChange={setStopBits}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1</SelectItem>
                <SelectItem value="2">2</SelectItem>
              </SelectContent>
            </Select>
          </div>

        </div>
      </div>

      {/* Diagnóstico */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">🔍 Diagnóstico Serial</h3>
          <Button variant="outline" size="sm" onClick={() => {
            navigator.clipboard.writeText(diagLog.join("\n")).then(() => notify.ok("Porta Serial", "Diagnóstico copiado!"));
          }}>Copiar</Button>
        </div>
        <div className="h-48 rounded-lg bg-secondary p-3 font-mono text-xs text-foreground overflow-y-auto space-y-0.5">
          {diagLog.length === 0 ? (
            <p className="text-muted-foreground">Aguardando diagnóstico...</p>
          ) : (
            diagLog.map((line, i) => (
              <p key={i} className={line.includes("ERRO") ? "text-destructive font-bold" : "text-muted-foreground"}>{line}</p>
            ))
          )}
        </div>
      </div>

      {/* Log Serial */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold text-card-foreground mb-3">Log Serial</h3>
        <div className="h-48 rounded-lg bg-secondary p-3 font-mono text-xs text-foreground overflow-y-auto space-y-1">
          <p className="text-muted-foreground">[Sistema] Aguardando conexão serial...</p>
          {connected && (
            <>
              <p className="text-primary">[{new Date().toLocaleTimeString()}] Conectado à {port} @ {baudRate} bps</p>
              <p className="text-muted-foreground">[{new Date().toLocaleTimeString()}] Pronto para enviar comandos</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SerialConfigSection;
