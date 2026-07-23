import { useState, useEffect, useCallback, useRef } from "react";
import { Wifi, Cable, SignalHigh, SignalMedium, SignalLow, SignalZero, RefreshCw, Activity } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

// ─────────────────────────────────────────────────────────────────────────────
// NetworkHealth — medidor preciso de saúde da rede
// ─────────────────────────────────────────────────────────────────────────────
// Estratégia (mais robusta que a anterior):
// • Faz 4 pings curtos (HEAD a /favicon.png + Cloudflare trace) e usa MEDIANA
// • Calcula JITTER (variação entre amostras)
// • Speed test opcional com graceful fallback — falha NÃO penaliza
// • Classificação é dominada pelo RTT (latência é o que importa pro painel)
// ─────────────────────────────────────────────────────────────────────────────

interface NetworkStats {
  type: "wifi" | "ethernet" | "unknown";
  downlink: number;       // Mbps (0 quando não foi possível medir)
  rtt: number;            // ms (mediana das amostras)
  jitter: number;         // ms (desvio padrão)
  loss: number;           // 0..1 fração de pings perdidos
  online: boolean;
  lastCheck: Date | null;
  measuring: boolean;
}

type HealthLevel = "excelente" | "bom" | "regular" | "crítico";

// Classificação baseada em RTT (latência) — é o que mais impacta UX:
// • Excelente: RTT < 80ms, jitter < 30ms, sem perdas
// • Bom:       RTT < 200ms, perdas ≤ 25%
// • Regular:   RTT < 500ms ou perdas ≤ 50%
// • Crítico:   RTT ≥ 500ms ou perdas > 50% ou offline
const getHealthLevel = (s: NetworkStats): HealthLevel => {
  if (!s.online) return "crítico";
  if (s.loss > 0.5) return "crítico";
  if (s.rtt <= 0 || s.rtt >= 9999) return "crítico";
  if (s.rtt < 80 && s.jitter < 30 && s.loss === 0) return "excelente";
  if (s.rtt < 200 && s.loss <= 0.25) return "bom";
  if (s.rtt < 500 && s.loss <= 0.5) return "regular";
  return "crítico";
};

const healthConfig: Record<HealthLevel, { color: string; bg: string; label: string; barWidth: string; barClass: string }> = {
  excelente: { color: "text-primary",     bg: "bg-primary/15",     label: "Excelente", barWidth: "w-full",  barClass: "bg-primary" },
  bom:       { color: "text-info",        bg: "bg-info/15",        label: "Bom",       barWidth: "w-3/4",   barClass: "bg-info" },
  regular:   { color: "text-warning",     bg: "bg-warning/15",     label: "Regular",   barWidth: "w-1/2",   barClass: "bg-warning" },
  crítico:   { color: "text-destructive", bg: "bg-destructive/15", label: "Crítico",   barWidth: "w-1/4",   barClass: "bg-destructive" },
};

const SignalIcon = ({ level }: { level: HealthLevel }) => {
  const cls = `w-4 h-4 ${healthConfig[level].color}`;
  switch (level) {
    case "excelente": return <SignalHigh className={cls} />;
    case "bom":       return <SignalMedium className={cls} />;
    case "regular":   return <SignalLow className={cls} />;
    case "crítico":   return <SignalZero className={cls} />;
  }
};

const getConnectionType = (rtt?: number): "wifi" | "ethernet" | "unknown" => {
  const conn = (navigator as { connection?: { type?: string } }).connection;
  if (conn?.type === "wifi") return "wifi";
  if (conn?.type === "ethernet") return "ethernet";
  if (rtt !== undefined && rtt > 0 && rtt < 9999) return rtt < 5 ? "ethernet" : "wifi";
  return "unknown";
};

// Faz uma amostra de ping. Retorna ms (>=9999 = falha)
const singlePing = async (url: string): Promise<number> => {
  const start = performance.now();
  try {
    await fetch(url, { method: "GET", cache: "no-store", mode: "no-cors", credentials: "omit" });
    return Math.round(performance.now() - start);
  } catch {
    return 9999;
  }
};

const median = (arr: number[]): number => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const stddev = (arr: number[]): number => {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return Math.round(Math.sqrt(variance));
};

/** Faz 4 pings paralelos, devolve mediana, jitter, loss */
const measureLatency = async (): Promise<{ rtt: number; jitter: number; loss: number }> => {
  const origin = window.location.origin;
  // Mistura local (favicon — sempre disponível) com Cloudflare (CDN globalmente próximo)
  const targets = [
    `${origin}/favicon.png?_t=${Date.now()}`,
    `${origin}/favicon.png?_t=${Date.now() + 1}`,
    `https://www.cloudflare.com/cdn-cgi/trace?_t=${Date.now()}`,
    `https://1.1.1.1/cdn-cgi/trace?_t=${Date.now()}`,
  ];
  const results = await Promise.all(targets.map(singlePing));
  const successes = results.filter((r) => r < 9999);
  const loss = (results.length - successes.length) / results.length;
  if (successes.length === 0) return { rtt: 9999, jitter: 0, loss: 1 };
  return { rtt: median(successes), jitter: stddev(successes), loss };
};

/** Speed test best-effort — nunca penaliza, retorna 0 se falhar */
const measureSpeed = async (): Promise<number> => {
  const url = `https://speed.cloudflare.com/__down?bytes=300000&_t=${Date.now()}`;
  const start = performance.now();
  try {
    const res = await fetch(url, { cache: "no-store", mode: "cors" });
    if (!res.ok) return 0;
    const blob = await res.blob();
    const elapsed = (performance.now() - start) / 1000;
    if (elapsed <= 0 || blob.size <= 0) return 0;
    return (blob.size * 8) / (elapsed * 1_000_000);
  } catch {
    const conn = (navigator as { connection?: { downlink?: number } }).connection;
    return conn?.downlink ?? 0;
  }
};

const MEASURE_INTERVAL = 30_000;

export function NetworkHealth({ compact = false }: { compact?: boolean }) {
  const [stats, setStats] = useState<NetworkStats>({
    type: getConnectionType(),
    downlink: 0,
    rtt: 0,
    jitter: 0,
    loss: 0,
    online: navigator.onLine,
    lastCheck: null,
    measuring: true,
  });
  const mountedRef = useRef(true);

  const runMeasurement = useCallback(async () => {
    if (!mountedRef.current) return;
    setStats((prev) => ({ ...prev, measuring: true }));

    if (!navigator.onLine) {
      if (mountedRef.current) {
        setStats({
          type: "unknown", downlink: 0, rtt: 9999, jitter: 0, loss: 1,
          online: false, lastCheck: new Date(), measuring: false,
        });
      }
      return;
    }

    const [latency, downlink] = await Promise.all([measureLatency(), measureSpeed()]);

    if (mountedRef.current) {
      setStats({
        type: getConnectionType(latency.rtt),
        downlink,
        rtt: latency.rtt,
        jitter: latency.jitter,
        loss: latency.loss,
        online: latency.rtt < 9999,
        lastCheck: new Date(),
        measuring: false,
      });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void runMeasurement();
    const interval = setInterval(() => void runMeasurement(), MEASURE_INTERVAL);

    const onOnline = () => void runMeasurement();
    const onOffline = () =>
      setStats((prev) => ({ ...prev, online: false, rtt: 9999, downlink: 0, loss: 1 }));
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [runMeasurement]);

  const health = getHealthLevel(stats);
  const cfg = healthConfig[health];
  const ConnectionIcon = stats.type === "ethernet" ? Cable : Wifi;
  const timeStr = stats.lastCheck ? stats.lastCheck.toLocaleTimeString() : "—";
  const rttDisplay = stats.rtt > 0 && stats.rtt < 9999 ? `${stats.rtt}ms` : "—";
  const lossPct = Math.round(stats.loss * 100);

  if (compact) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={`flex items-center justify-center p-2 rounded-xl ${cfg.bg} cursor-default`}>
              <div className="relative">
                <ConnectionIcon className={`w-4 h-4 ${cfg.color}`} />
                {stats.measuring && (
                  <RefreshCw className="w-2 h-2 text-muted-foreground animate-spin absolute -bottom-1 -right-1" />
                )}
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className="space-y-1 text-xs">
            <p className="font-semibold">Saúde da Rede: {cfg.label}</p>
            <p className="text-muted-foreground">Latência: {rttDisplay} • Jitter: {stats.jitter}ms • Perda: {lossPct}%</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={`flex items-center gap-2 px-3 py-2 rounded-xl ${cfg.bg} cursor-default transition-colors`}>
            <div className="relative">
              <ConnectionIcon className={`w-4 h-4 ${cfg.color}`} />
              {stats.measuring && (
                <RefreshCw className="w-2.5 h-2.5 text-muted-foreground animate-spin absolute -bottom-1 -right-1" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-1">
                <span className="text-[10px] font-semibold text-sidebar-foreground/50 uppercase tracking-wider">Saúde da Rede</span>
                <SignalIcon level={health} />
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={`text-xs font-bold ${cfg.color}`}>{cfg.label}</span>
                <span className="text-[10px] text-sidebar-foreground/40">{rttDisplay}</span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-sidebar-accent overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-700 ${cfg.barClass} ${cfg.barWidth}`} />
              </div>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" className="space-y-1.5 text-xs max-w-[260px]">
          <p className="font-semibold flex items-center gap-1.5">
            <Activity className="w-3 h-3" /> Diagnóstico de Rede
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <span className="text-muted-foreground">Conexão:</span>
            <span>{stats.type === "ethernet" ? "📶 Cabo" : stats.type === "wifi" ? "📡 Wi-Fi" : "Detectando…"}</span>
            <span className="text-muted-foreground">Latência (RTT):</span>
            <span className="font-mono">{rttDisplay}</span>
            <span className="text-muted-foreground">Estabilidade (jitter):</span>
            <span className="font-mono">{stats.jitter > 0 ? `${stats.jitter}ms` : "—"}</span>
            <span className="text-muted-foreground">Perda de pacotes:</span>
            <span className="font-mono">{lossPct}%</span>
            <span className="text-muted-foreground">Velocidade:</span>
            <span className="font-mono">{stats.downlink > 0 ? `${stats.downlink.toFixed(1)} Mbps` : "—"}</span>
            <span className="text-muted-foreground">Status:</span>
            <span>{stats.online ? "🟢 Conectado" : "🔴 Offline"}</span>
            <span className="text-muted-foreground">Última medição:</span>
            <span>{timeStr}</span>
          </div>
          <p className="text-muted-foreground/70 pt-1.5 border-t border-border mt-1 text-[10px] leading-snug">
            Medido com 4 amostras de ping (mediana). Velocidade é estimativa best-effort — falhas de CORS não afetam a classificação. Atualiza a cada 30s.
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
