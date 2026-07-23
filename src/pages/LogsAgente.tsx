// v3.14.1 — Viewer web do log criptografado (.rlog) do agente Electron.
// Busca a chave AES-256-GCM via RPC (autorizada), baixa o arquivo do Storage
// privado `agent-logs`, descriptografa no navegador e exibe.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Lock, Search, FileText } from "lucide-react";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { notify } from "@/lib/notify";

interface LogEntry {
  timestamp: string;
  level: string;
  category: string;
  message: string;
  raw_frame: string | null;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function importAesKey(hexKey: string): Promise<CryptoKey> {
  const raw = hexToBytes(hexKey);
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function decryptLine(line: string, key: CryptoKey): Promise<LogEntry | null> {
  try {
    const [ivHex, tagHex, ctHex] = line.split(":");
    if (!ivHex || !tagHex || !ctHex) return null;
    const iv = hexToBytes(ivHex);
    const tag = hexToBytes(tagHex);
    const ct = hexToBytes(ctHex);
    // WebCrypto expects ciphertext || tag concatenated
    const buf = new Uint8Array(ct.length + tag.length);
    buf.set(ct, 0);
    buf.set(tag, ct.length);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, key, buf.buffer as ArrayBuffer);
    return JSON.parse(new TextDecoder().decode(plain)) as LogEntry;
  } catch {
    return null;
  }
}

const CAT_COLOR: Record<string, string> = {
  tx: "text-sky-400",
  rx: "text-emerald-400",
  raw_tx: "text-sky-400/60",
  raw_rx: "text-emerald-400/60",
  system: "text-slate-300",
  update: "text-amber-300",
};

export default function LogsAgente() {
  const farmId = useDefaultFarmId();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState<string>("all");

  async function load() {
    if (!farmId) return;
    setLoading(true);
    setEntries([]);
    try {
      const { data: keyData, error: keyErr } = await supabase.rpc("get_farm_log_key", { _farm_id: farmId });
      if (keyErr) throw new Error(`Sem permissão para chave: ${keyErr.message}`);
      const keyHex = keyData as unknown as string | null;
      if (!keyHex) { notify.warn("Logs", "Chave de log ainda não gerada — o agente precisa rodar a v3.14.1 pelo menos 1 vez."); setLoading(false); return; }
      const key = await importAesKey(keyHex);

      const remote = `${farmId}/rlog-${date}.rlog`;
      const { data: file, error: dlErr } = await supabase.storage.from("agent-logs").download(remote);
      if (dlErr || !file) { notify.warn("Logs", `Sem log para ${date}.`); setLoading(false); return; }
      const text = await file.text();
      const lines = text.split("\n").filter(Boolean);
      const decoded: LogEntry[] = [];
      for (const l of lines) {
        const e = await decryptLine(l, key);
        if (e) decoded.push(e);
      }
      setEntries(decoded);
    } catch (e: any) {
      notify.fail("Logs", e?.message || "Falha ao carregar");
    }
    setLoading(false);
  }

  useEffect(() => { if (farmId) load(); /* eslint-disable-next-line */ }, [farmId, date]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries.filter((e) => {
      if (category !== "all" && e.category !== category) return false;
      if (!q) return true;
      return (e.message || "").toLowerCase().includes(q)
        || (e.raw_frame || "").toLowerCase().includes(q);
    });
  }, [entries, filter, category]);

  const categories = useMemo(() => Array.from(new Set(entries.map((e) => e.category))).sort(), [entries]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Lock className="w-5 h-5 text-primary" /> Logs do Agente</h1>
          <p className="text-sm text-muted-foreground">Log criptografado AES-256-GCM — 30 dias no servidor.</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4" /> Consulta</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Data</label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
            </div>
            <div className="flex-1 min-w-[220px]">
              <label className="text-xs text-muted-foreground">Busca</label>
              <div className="relative">
                <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="tsnn, mensagem, hex..." className="pl-7" />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Categoria</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="all">Todas</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <Button onClick={load} disabled={loading}>{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Recarregar"}</Button>
          </div>

          <div className="text-xs text-muted-foreground">
            {loading ? "Descriptografando..." : `${filtered.length} de ${entries.length} linhas`}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="max-h-[70vh] overflow-auto font-mono text-xs">
            {filtered.length === 0 && !loading && (
              <div className="p-6 text-center text-muted-foreground">Nenhuma linha para exibir.</div>
            )}
            {filtered.map((e, i) => {
              const t = new Date(e.timestamp).toLocaleTimeString("pt-BR");
              const cls = CAT_COLOR[e.category] || "text-slate-200";
              return (
                <div key={i} className="px-3 py-1 border-b border-border/40 hover:bg-muted/30 flex gap-2">
                  <span className="text-slate-500 shrink-0">[{t}]</span>
                  <Badge variant="outline" className="h-4 text-[10px] px-1 shrink-0">{e.category}</Badge>
                  <span className="text-slate-500 shrink-0 uppercase text-[10px]">{e.level}</span>
                  <span className={`${cls} break-all`}>{e.message}</span>
                  {e.raw_frame && <span className="text-slate-500 break-all">| {e.raw_frame}</span>}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
