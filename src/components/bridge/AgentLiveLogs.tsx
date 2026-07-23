// ─────────────────────────────────────────────────────────────────────────────
// AgentLiveLogs — Logs ao vivo do agente Electron via Broadcast (zero storage)
// ─────────────────────────────────────────────────────────────────────────────
// • Envia `start_log_stream` em agent_commands → agente flusha buffer (500)
//   e passa a emitir cada linha por broadcast `agent-logs-{farmId}`.
// • Renova a cada 5 min com `renew_log_stream` (auto-stop no agente: 30 min).
// • Envia `stop_log_stream` ao desmontar.
// • Filtros por categoria/nível/período aplicados no frontend.
// • Export CSV do que está em tela.
//
// Sem inserts em `agent_logs` — o broadcast do Supabase é canal de passagem.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { enqueueAgentCommand, type AgentCmdKind } from "@/lib/agentCommands";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Download,
  Trash2,
  Pause,
  Play,
  Radio,
  Filter,
  Calendar,
  X,
} from "lucide-react";

type LogLevel = "info" | "warn" | "error" | "debug";
type LogCategory = "tx" | "rx" | "serial" | "cloud" | "system" | "timeout" | "remote" | "update";

interface StreamLogLine {
  ts: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  raw_frame?: string | null;
}

const MAX_VISIBLE = 500;
const RENEW_INTERVAL_MS = 5 * 60 * 1000;

const ALL_LEVELS: LogLevel[] = ["info", "warn", "error", "debug"];
const ALL_CATEGORIES: LogCategory[] = ["tx", "rx", "serial", "cloud", "system", "timeout"];

const levelStyle: Record<LogLevel, string> = {
  info: "bg-primary/10 text-primary border-primary/30",
  warn: "bg-warning/15 text-warning border-warning/30",
  error: "bg-destructive/15 text-destructive border-destructive/30",
  debug: "bg-muted text-muted-foreground border-border",
};

const categoryStyle: Record<string, string> = {
  tx: "bg-info/15 text-info border-info/30",
  rx: "bg-primary/10 text-primary border-primary/30",
  serial: "bg-warning/15 text-warning border-warning/30",
  cloud: "bg-secondary text-foreground border-border",
  system: "bg-muted text-muted-foreground border-border",
  timeout: "bg-destructive/15 text-destructive border-destructive/30",
  remote: "bg-info/10 text-info border-info/30",
  update: "bg-secondary text-foreground border-border",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function csvEscape(value: string | null | undefined): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

interface Props {
  farmId: string | null | undefined;
}

export default function AgentLiveLogs({ farmId }: Props) {
  const [logs, setLogs] = useState<StreamLogLine[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [levelFilter, setLevelFilter] = useState<Set<LogLevel>>(new Set(ALL_LEVELS));
  const [categoryFilter, setCategoryFilter] = useState<Set<LogCategory>>(new Set(ALL_CATEGORIES));
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [streamStatus, setStreamStatus] = useState<"idle" | "starting" | "connected" | "error">("idle");
  const scrollRef = useRef<HTMLDivElement>(null);
  const renewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const toIsoOrNull = useCallback((local: string): string | null => {
    if (!local) return null;
    const d = new Date(local);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }, []);

  const fromIso = useMemo(() => toIsoOrNull(fromDate), [fromDate, toIsoOrNull]);
  const toIso = useMemo(() => toIsoOrNull(toDate), [toDate, toIsoOrNull]);

  // Helper para enfileirar comandos no agente
  const sendAgentCmd = useCallback(
    async (kind: AgentCmdKind) => {
      if (!farmId) return;
      try {
        await enqueueAgentCommand({ farmId, kind, expiresInSec: 60 });
      } catch (e) {
        console.error("[AgentLiveLogs] falha ao enviar comando", kind, e);
      }
    },
    [farmId],
  );

  // Setup: subscribe broadcast → start_log_stream → renovação periódica → cleanup
  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    setStreamStatus("starting");
    setLogs([]);

    const channel = supabase.channel(`agent-logs-${farmId}`, {
      config: { broadcast: { self: false } },
    });

    channel.on("broadcast", { event: "log_buffer" }, ({ payload }) => {
      if (cancelled) return;
      const lines = (payload?.lines ?? []) as StreamLogLine[];
      // Buffer chega cronológico (mais antigo → mais novo).
      setLogs(lines.slice(-MAX_VISIBLE));
    });

    channel.on("broadcast", { event: "log_line" }, ({ payload }) => {
      if (cancelled) return;
      const line = payload as StreamLogLine;
      setLogs((prev) => {
        const next = [...prev, line];
        if (next.length > MAX_VISIBLE) next.splice(0, next.length - MAX_VISIBLE);
        return next;
      });
    });

    channel.subscribe((status) => {
      if (cancelled) return;
      if (status === "SUBSCRIBED") {
        setStreamStatus("connected");
        void sendAgentCmd("start_log_stream");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        setStreamStatus("error");
      }
    });

    // Renova a cada 5 min para evitar auto-stop de 30 min no agente
    renewTimerRef.current = setInterval(() => {
      void sendAgentCmd("renew_log_stream");
    }, RENEW_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (renewTimerRef.current) {
        clearInterval(renewTimerRef.current);
        renewTimerRef.current = null;
      }
      void sendAgentCmd("stop_log_stream");
      try { void supabase.removeChannel(channel); } catch { /* ignore */ }
    };
  }, [farmId, sendAgentCmd]);

  const filtered = useMemo(
    () =>
      logs.filter((l) => {
        if (!levelFilter.has(l.level)) return false;
        if (!categoryFilter.has(l.category as LogCategory)) return false;
        if (fromIso || toIso) {
          const t = new Date(l.ts).getTime();
          if (Number.isNaN(t)) return false;
          if (fromIso && t < new Date(fromIso).getTime()) return false;
          if (toIso && t > new Date(toIso).getTime()) return false;
        }
        return true;
      }),
    [logs, levelFilter, categoryFilter, fromIso, toIso],
  );

  const clearDateRange = useCallback(() => {
    setFromDate("");
    setToDate("");
  }, []);

  const hasDateRange = !!fromDate || !!toDate;

  // Preserva posição de scroll ao receber novos logs.
  const prevScrollHeightRef = useRef<number>(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prevHeight = prevScrollHeightRef.current;
    const newHeight = el.scrollHeight;
    const distanceFromBottom = prevHeight - el.scrollTop - el.clientHeight;
    const wasAtBottom = distanceFromBottom <= 16;
    if (autoScroll && wasAtBottom) {
      el.scrollTop = newHeight;
    }
    prevScrollHeightRef.current = newHeight;
  }, [filtered, autoScroll]);

  const toggleLevel = useCallback((lvl: LogLevel) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(lvl)) next.delete(lvl);
      else next.add(lvl);
      return next;
    });
  }, []);

  const toggleCategory = useCallback((cat: LogCategory) => {
    setCategoryFilter((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const exportCsv = useCallback(() => {
    const header = ["timestamp", "level", "category", "message", "raw_frame"].join(",");
    const rows = filtered.map((l) =>
      [csvEscape(l.ts), csvEscape(l.level), csvEscape(l.category), csvEscape(l.message), csvEscape(l.raw_frame)].join(","),
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `agent-logs-${new Date().toISOString().substring(0, 19).replace(/[:T]/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filtered]);

  const clearView = useCallback(() => {
    setLogs([]);
  }, []);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-border bg-secondary/40">
        <div className="flex items-center gap-2">
          <Radio className={`h-4 w-4 ${streamStatus === "connected" ? "text-primary animate-pulse" : "text-muted-foreground"}`} />
          <h3 className="text-sm font-semibold text-foreground">Logs ao Vivo do Agente</h3>
          <Badge variant="outline" className="text-[10px] font-mono">
            {filtered.length}/{logs.length}
          </Badge>
          {streamStatus === "connected" && (
            <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/30">
              STREAMING
            </Badge>
          )}
          {streamStatus === "starting" && (
            <Badge variant="outline" className="text-[10px] bg-warning/15 text-warning border-warning/30">
              CONECTANDO…
            </Badge>
          )}
          {streamStatus === "error" && (
            <Badge variant="outline" className="text-[10px] bg-destructive/10 text-destructive border-destructive/30">
              SEM CONEXÃO
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => setAutoScroll((v) => !v)} title={autoScroll ? "Pausar auto-scroll" : "Retomar auto-scroll"}>
            {autoScroll ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            <span className="ml-1.5 text-xs">{autoScroll ? "Pausar" : "Continuar"}</span>
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={filtered.length === 0}>
            <Download className="h-3.5 w-3.5" />
            <span className="ml-1.5 text-xs">CSV</span>
          </Button>
          <Button variant="outline" size="sm" onClick={clearView}>
            <Trash2 className="h-3.5 w-3.5" />
            <span className="ml-1.5 text-xs">Limpar</span>
          </Button>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-border bg-background/40">
        <div className="flex items-center gap-1.5">
          <Filter className="h-3 w-3 text-muted-foreground" />
          <span className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">Categoria:</span>
          {ALL_CATEGORIES.map((cat) => {
            const active = categoryFilter.has(cat);
            return (
              <button
                key={cat}
                type="button"
                onClick={() => toggleCategory(cat)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase border transition-opacity ${categoryStyle[cat]} ${active ? "opacity-100" : "opacity-30"}`}
              >
                {cat}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">Nível:</span>
          {ALL_LEVELS.map((lvl) => {
            const active = levelFilter.has(lvl);
            return (
              <button
                key={lvl}
                type="button"
                onClick={() => toggleLevel(lvl)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase border transition-opacity ${levelStyle[lvl]} ${active ? "opacity-100" : "opacity-30"}`}
              >
                {lvl}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Calendar className="h-3 w-3 text-muted-foreground" />
          <span className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">Período:</span>
          <Input
            type="datetime-local"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            max={toDate || undefined}
            className="h-7 w-[180px] text-[11px] font-mono px-2"
            aria-label="Data e hora inicial"
            title="Filtrar a partir desta data/hora"
          />
          <span className="text-[11px] text-muted-foreground">até</span>
          <Input
            type="datetime-local"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            min={fromDate || undefined}
            className="h-7 w-[180px] text-[11px] font-mono px-2"
            aria-label="Data e hora final"
            title="Filtrar até esta data/hora"
          />
          {hasDateRange && (
            <Button variant="ghost" size="sm" onClick={clearDateRange} className="h-7 px-2 text-[11px]" title="Limpar período">
              <X className="h-3 w-3 mr-1" />
              Limpar
            </Button>
          )}
        </div>
      </div>

      {/* Lista */}
      <div ref={scrollRef} className="h-[420px] overflow-y-auto bg-background font-mono text-[11px] leading-tight">
        {!farmId ? (
          <div className="p-6 text-center text-muted-foreground text-xs">Selecione uma fazenda para ver os logs.</div>
        ) : streamStatus === "starting" ? (
          <div className="p-6 text-center text-muted-foreground text-xs">Conectando ao agente…</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground text-xs">
            {logs.length === 0
              ? "Aguardando logs do agente. Se o .exe não estiver rodando, nada aparecerá."
              : "Nenhum log dentro dos filtros atuais."}
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {filtered.map((log, idx) => (
              <div key={`${log.ts}-${idx}`} className="flex items-start gap-2 px-3 py-1 hover:bg-secondary/30">
                <span className="text-muted-foreground shrink-0 w-[88px]">{formatTime(log.ts)}</span>
                <span className={`shrink-0 px-1 rounded text-[9px] font-bold uppercase border ${levelStyle[log.level]}`}>
                  {log.level}
                </span>
                <span className={`shrink-0 px-1 rounded text-[9px] font-bold uppercase border ${categoryStyle[log.category] ?? categoryStyle.system}`}>
                  {log.category}
                </span>
                <span className="text-foreground break-all flex-1">{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
