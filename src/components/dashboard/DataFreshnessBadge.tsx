import { useEffect, useRef, useState } from "react";
import { Wifi, WifiOff, CheckCircle2, RefreshCw } from "lucide-react";
import { useCadastrosCloud } from "@/hooks/useCadastrosCloud";

/**
 * Indicador silencioso da "frescura" dos dados do Dashboard.
 * - Verde "Ao vivo": Realtime conectado e dados < 30s
 * - Amarelo "Sincronizando": dados entre 30s e 90s OU realtime caiu (auto-refresh em background)
 * - Vermelho "Reconectando": dados > 90s (auto-refresh agressivo em background)
 *
 * Sem botão manual e sem toasts — a recuperação é automática para passar
 * a impressão de que tudo flui sozinho.
 */
export function DataFreshnessBadge() {
  const { lastSyncAt, realtimeConnected, refresh } = useCadastrosCloud();
  const [now, setNow] = useState(Date.now());
  const lastAutoRefreshRef = useRef(0);

  // Relógio leve a cada 5s para reavaliar frescura
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const ageMs = lastSyncAt ? now - lastSyncAt : null;
  const ageSec = ageMs != null ? Math.floor(ageMs / 1000) : null;

  let level: "ok" | "warn" | "stale" = "ok";
  if (!realtimeConnected || (ageSec != null && ageSec > 90)) level = "stale";
  else if (ageSec != null && ageSec > 30) level = "warn";

  // Auto-refresh silencioso quando os dados envelhecem
  // - warn: tenta a cada ~20s
  // - stale: tenta a cada ~10s
  useEffect(() => {
    if (level === "ok") return;
    const interval = level === "stale" ? 10_000 : 20_000;
    const since = Date.now() - lastAutoRefreshRef.current;
    if (since < interval) return;
    lastAutoRefreshRef.current = Date.now();
    refresh().catch(() => {
      /* silencioso por design */
    });
  }, [level, now, refresh]);

  const ageLabel =
    ageSec == null
      ? "—"
      : ageSec < 60
        ? `${ageSec}s`
        : ageSec < 3600
          ? `${Math.floor(ageSec / 60)}min`
          : `${Math.floor(ageSec / 3600)}h`;

  const colorClasses =
    level === "ok"
      ? "border-primary/30 bg-primary/5 text-primary"
      : level === "warn"
        ? "border-warning/40 bg-warning/10 text-warning"
        : "border-destructive/40 bg-destructive/10 text-destructive animate-pulse";

  const Icon =
    level === "ok" ? CheckCircle2 : level === "warn" ? RefreshCw : WifiOff;

  const label =
    level === "ok"
      ? "Ao vivo"
      : level === "warn"
        ? "Sincronizando"
        : "Reconectando";

  const tooltip =
    level === "ok"
      ? `Dados em tempo real (atualizado há ${ageLabel})`
      : level === "warn"
        ? `Sincronizando em segundo plano (última atualização há ${ageLabel})`
        : `Reconectando ao servidor em segundo plano (há ${ageLabel} sem novos dados)`;

  return (
    <div
      className={`inline-flex items-center gap-1 px-2 h-8 rounded-md border text-xs font-semibold ${colorClasses}`}
      title={tooltip}
      aria-live="polite"
    >
      <Icon className={`w-3.5 h-3.5 ${level === "warn" ? "animate-spin" : ""}`} />
      <span className="hidden sm:inline">{label}</span>
      <span className="text-[10px] opacity-80 tabular-nums">{ageLabel}</span>
    </div>
  );
}
