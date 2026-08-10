// PlatformDiagTerminal — "Diagnóstico Remoto" (aba /platform).
// Gera PIN (Modo Técnico da ferramenta) e opera um terminal serial REMOTO via
// diag_sessions/diag_commands: o operador na fazenda abre o renov_diag.exe [9],
// passa o código de 8 dígitos, e aqui o admin manda comandos e vê TX/RX ao vivo.
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KeyRound, TerminalSquare, Radio, Send, Lock, Copy, Plug } from "lucide-react";

type LogLine = { kind: "tx" | "rx" | "info" | "err"; text: string; at: string };
const MAX_LOG = 200;
const now = () => new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

interface Session { id: string; code: string; com_port: string | null; status: string; expires_at: string; }

export default function PlatformDiagTerminal({ isAdmin }: { isAdmin: boolean }) {
  const [pin, setPin] = useState<string | null>(null);
  const [pinExpires, setPinExpires] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState(false);

  const [codeInput, setCodeInput] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [cmd, setCmd] = useState("");
  const [sending, setSending] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const seenResp = useRef<Set<string>>(new Set());

  const push = useCallback((kind: LogLine["kind"], text: string) =>
    setLog((p) => [{ kind, text, at: now() }, ...p].slice(0, MAX_LOG)), []);

  if (!isAdmin) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        <Lock className="w-5 h-5 mx-auto mb-2" /> Acesso restrito a administradores da plataforma.
      </Card>
    );
  }

  // ── Gerar PIN (Modo Técnico) ────────────────────────────────────────────────
  const generatePin = async () => {
    setGenBusy(true);
    try {
      const { data: userRes } = await supabase.auth.getUser();
      const newPin = String(Math.floor(100000 + Math.random() * 900000));
      const { data, error } = await supabase.from("diag_pins" as any)
        .insert({ pin: newPin, created_by: userRes?.user?.id ?? null } as any)
        .select("pin, expires_at").single();
      if (error) throw error;
      setPin((data as any).pin);
      setPinExpires((data as any).expires_at);
    } catch (e: any) {
      push("err", `Falha ao gerar PIN: ${e?.message ?? e}`);
    } finally {
      setGenBusy(false);
    }
  };

  // ── Conectar a uma sessão remota (código de 8 dígitos) ──────────────────────
  const connect = async () => {
    const code = codeInput.trim();
    if (!/^\d{8}$/.test(code)) { push("err", "Código inválido (8 dígitos)."); return; }
    setConnectBusy(true);
    try {
      const { data, error } = await supabase.from("diag_sessions" as any)
        .select("id, code, com_port, status, expires_at")
        .eq("code", code).eq("status", "active")
        .gt("expires_at", new Date().toISOString()).maybeSingle();
      if (error) throw error;
      if (!data) { push("err", "Sessão não encontrada, encerrada ou expirada."); return; }
      setSession(data as any);
      seenResp.current = new Set();
      setLog([]);
      push("info", `Conectado à sessão ${code} (COM ${(data as any).com_port ?? "?"}). Expira ${new Date((data as any).expires_at).toLocaleTimeString("pt-BR")}.`);
    } catch (e: any) {
      push("err", `Erro ao conectar: ${e?.message ?? e}`);
    } finally {
      setConnectBusy(false);
    }
  };

  // ── Enviar comando (enfileira em diag_commands) ─────────────────────────────
  const sendCmd = async () => {
    const c = cmd.trim();
    if (!c || !session) return;
    setSending(true);
    try {
      const { data: userRes } = await supabase.auth.getUser();
      const { error } = await supabase.from("diag_commands" as any)
        .insert({ session_id: session.id, command: c, created_by: userRes?.user?.id ?? null } as any);
      if (error) throw error;
      push("tx", c);
      setCmd("");
    } catch (e: any) {
      push("err", `Falha ao enviar: ${e?.message ?? e}`);
    } finally {
      setSending(false);
    }
  };

  // ── Polling das respostas a cada 2s ─────────────────────────────────────────
  useEffect(() => {
    if (!session) return;
    let stop = false;
    const tick = async () => {
      const { data } = await supabase.from("diag_commands" as any)
        .select("id, command, status, response, responded_at")
        .eq("session_id", session.id).order("created_at", { ascending: true });
      if (stop || !data) return;
      for (const c of data as any[]) {
        if (c.status === "done" && c.response != null && !seenResp.current.has(c.id)) {
          seenResp.current.add(c.id);
          push("rx", String(c.response) || "(sem resposta)");
        }
      }
      // sessão expirou?
      if (new Date(session.expires_at).getTime() < Date.now()) {
        push("info", "Sessão expirada (30 min). Peça um novo código ao operador.");
        setSession(null);
      }
    };
    const id = setInterval(tick, 2000);
    void tick();
    return () => { stop = true; clearInterval(id); };
  }, [session, push]);

  const copyPin = () => { if (pin) void navigator.clipboard.writeText(pin); };

  return (
    <div className="space-y-4">
      {/* Gerar PIN */}
      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-semibold flex items-center gap-2"><KeyRound className="w-4 h-4" /> Modo Técnico — gerar PIN</h3>
        <p className="text-xs text-muted-foreground">
          Gere um PIN de 6 dígitos e passe ao técnico. Ele usa no <b>renov_diag [8]</b> para liberar os comandos CFG.
          Validade 1h, uso único. A senha nunca fica no programa — vem cifrada do servidor.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <Button size="sm" onClick={generatePin} disabled={genBusy}>{genBusy ? "Gerando…" : "Gerar PIN"}</Button>
          {pin && (
            <div className="flex items-center gap-2">
              <span className="font-mono text-2xl font-bold tracking-widest text-primary">{pin}</span>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={copyPin}><Copy className="w-3.5 h-3.5" /></Button>
              {pinExpires && <span className="text-[11px] text-muted-foreground">expira {new Date(pinExpires).toLocaleTimeString("pt-BR")}</span>}
            </div>
          )}
        </div>
      </Card>

      {/* Acesso remoto */}
      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Radio className="w-4 h-4" /> Acesso Remoto — terminal serial da fazenda</h3>
        {!session ? (
          <>
            <p className="text-xs text-muted-foreground">
              O operador abre o <b>renov_diag [9]</b>, gera um código de 8 dígitos e te passa. Digite aqui para
              controlar a serial remotamente (sem AnyDesk).
            </p>
            <div className="flex items-end gap-2 flex-wrap">
              <div className="space-y-1">
                <Label className="text-xs">Código da sessão</Label>
                <Input value={codeInput} onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, "").slice(0, 8))}
                  placeholder="12345678" className="w-40 font-mono tracking-widest" />
              </div>
              <Button size="sm" onClick={connect} disabled={connectBusy}>
                <Plug className="w-4 h-4 mr-1" /> {connectBusy ? "Conectando…" : "Conectar"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs inline-flex items-center gap-1.5 text-emerald-600 font-semibold">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /> Conectado — sessão {session.code} (COM {session.com_port ?? "?"})
              </span>
              <Button size="sm" variant="outline" onClick={() => setSession(null)}>Desconectar</Button>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label className="text-xs">Comando (ex: STATUS, PING, TEST_RADIOS, CFG:LIST, [1302_1_]{"{1}"}[1302_ETX_])</Label>
                <Input value={cmd} onChange={(e) => setCmd(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void sendCmd(); }}
                  placeholder="Digite o comando e Enter" className="font-mono" />
              </div>
              <Button size="sm" onClick={sendCmd} disabled={sending || !cmd.trim()}>
                <Send className="w-4 h-4 mr-1" /> Enviar
              </Button>
            </div>
            {/* Terminal TX/RX */}
            <div className="bg-black rounded-md p-3 font-mono text-xs h-72 overflow-y-auto flex flex-col-reverse">
              <div>
                {log.length === 0 && <div className="text-neutral-500">Aguardando comandos…</div>}
                {[...log].reverse().map((l, i) => (
                  <div key={i} className={
                    l.kind === "tx" ? "text-emerald-400" : l.kind === "rx" ? "text-sky-300"
                    : l.kind === "err" ? "text-red-400" : "text-neutral-400"}>
                    <span className="text-neutral-600">[{l.at}]</span>{" "}
                    {l.kind === "tx" ? "TX " : l.kind === "rx" ? "RX " : l.kind === "err" ? "!! " : "·· "}
                    {l.text}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
