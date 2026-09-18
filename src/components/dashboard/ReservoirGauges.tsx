import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Activity, Bell, Volume2, VolumeX, RefreshCw, TrendingDown, Droplets, Signal, AlertTriangle, CheckCircle2, Waves } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAlarmSound } from "@/hooks/useAlarmSound";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";
import { supabase } from "@/integrations/supabase/client";
import { getSupabaseForFarm } from "@/lib/supabaseRouter";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useReservoirDrainEta, formatEta } from "@/hooks/useReservoirDrainEta";

export interface Reservoir {
  id: string;
  name: string;
  percent: number;
  level: string;
  maxLevel: string;
  alarm: boolean;
  signalRF?: number;
  lastReading?: string;
  online?: boolean;
  lat?: number;
  lng?: number;
  alarmLow?: number | null;
  alarmHigh?: number | null;
}

/** Tempo máximo em "Atualizando..." antes de marcar falha. */
const REFRESH_TIMEOUT_MS = 30_000;

function getLevelColor(percent: number) {
  if (percent >= 95) return "text-primary";
  if (percent >= 60) return "text-primary";
  if (percent >= 30) return "text-warning";
  return "text-destructive";
}

/** Barra grossa, mesmo peso visual da barra dos poços ligados. */
function LevelBar({ percent, offline }: { percent: number; offline: boolean }) {
  const isLow = !offline && percent < 25;
  const color = offline
    ? "bg-muted-foreground/40"
    : percent >= 60 ? "bg-primary" : percent >= 30 ? "bg-warning" : "bg-destructive";
  return (
    <div className={`w-full h-3 rounded-full overflow-hidden border ${isLow ? "bg-destructive/20 border-destructive/40" : "bg-secondary border-border"}`}>
      <div
        className={`h-full rounded-full transition-all duration-500 ${color} ${isLow ? "animate-bar-flash" : ""}`}
        style={{ width: `${Math.max(0, Math.min(100, offline ? 0 : percent))}%` }}
      />
    </div>
  );
}

interface LevelReading {
  read_at: string;
  percent: number | null;
  meters: number | null;
}

/** Últimas leituras de nível — carregadas ao abrir o popover. */
function LastLevelReadings({ equipmentId }: { equipmentId: string }) {
  // `level_history` é telemetria: pertence ao backend da fazenda ATIVA — a
  // mesma que originou este equipamento no dashboard.
  const farmId = useDefaultFarmId();
  const [rows, setRows] = useState<LevelReading[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await getSupabaseForFarm(farmId)
        .from("level_history")
        .select("read_at, percent, meters")
        .eq("equipment_id", equipmentId)
        .order("read_at", { ascending: false })
        .limit(3);
      if (cancelled) return;
      setRows(
        (data ?? []).map((r) => ({
          read_at: r.read_at as string,
          percent: r.percent != null ? Number(r.percent) : null,
          meters: r.meters != null ? Number(r.meters) : null,
        })),
      );
    })();
    return () => { cancelled = true; };
  }, [equipmentId, farmId]);

  if (rows === null) {
    return <p className="text-[11px] text-muted-foreground text-center py-1">Carregando leituras...</p>;
  }
  if (rows.length === 0) {
    return <p className="text-[11px] text-muted-foreground text-center py-1">Sem histórico de nível.</p>;
  }
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide font-bold text-foreground mb-1 flex items-center gap-1">
        <Waves className="w-3 h-3 text-info" />
        Últimas leituras de nível
      </p>
      <div className="space-y-1">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5 px-1.5 py-1 rounded bg-secondary/40">
            <span className={`w-2 h-2 rounded-full shrink-0 ${(r.percent ?? 0) >= 30 ? "bg-primary" : "bg-destructive"}`} />
            <span className="font-semibold text-foreground">
              {r.percent != null ? `${Math.round(r.percent)}%` : "—"}
            </span>
            {r.meters != null && (
              <span className="text-[10px] text-muted-foreground">{r.meters.toFixed(2)} m</span>
            )}
            <span className="text-[10px] text-muted-foreground ml-auto whitespace-nowrap">
              {new Date(r.read_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ReservoirGaugesProps {
  reservoirs: Reservoir[];
  onRefreshStatus?: (id: string) => void;
}

export function ReservoirGauges({ reservoirs, onRefreshStatus }: ReservoirGaugesProps) {
  const { t } = useLanguage();
  const hasAlarm = reservoirs.some(r => r.online !== false && (r.percent < 25 || r.percent >= 95));
  const { muted, toggleMute } = useAlarmSound(hasAlarm);
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
  const [refreshResult, setRefreshResult] = useState<Record<string, "success" | "fail">>({});
  const refreshTimers = useRef<Record<string, NodeJS.Timeout>>({});
  const prevReservoirs = useRef(reservoirs);
  const reservoirIds = useMemo(() => reservoirs.map((r) => r.id), [reservoirs]);
  const drainEta = useReservoirDrainEta(reservoirIds);

  const handleRefresh = useCallback((id: string) => {
    if (refreshing[id]) return;
    setRefreshResult(prev => { const next = { ...prev }; delete next[id]; return next; });
    setRefreshing(prev => ({ ...prev, [id]: true }));
    onRefreshStatus?.(id);

    // Timeout duro de 30s — nunca fica em "Atualizando..." indefinidamente.
    refreshTimers.current[id] = setTimeout(() => {
      setRefreshing(prev => {
        if (!prev[id]) return prev;
        notify.fail("Reservatório", `${reservoirs.find(r => r.id === id)?.name || id}: falha na atualização — tente novamente`);
        setRefreshResult(r => ({ ...r, [id]: "fail" }));
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }, REFRESH_TIMEOUT_MS);
  }, [refreshing, onRefreshStatus, reservoirs]);

  useEffect(() => {
    const prev = prevReservoirs.current;
    Object.keys(refreshing).forEach(id => {
      if (!refreshing[id]) return;
      const oldR = prev.find(r => r.id === id);
      const newR = reservoirs.find(r => r.id === id);
      if (oldR && newR && oldR.lastReading !== newR.lastReading) {
        clearTimeout(refreshTimers.current[id]);
        delete refreshTimers.current[id];
        setRefreshing(prev => { const next = { ...prev }; delete next[id]; return next; });
        setRefreshResult(r => ({ ...r, [id]: "success" }));
        notify.ok("Reservatório", `${newR.name}: status atualizado com sucesso`);
      }
    });
    prevReservoirs.current = reservoirs;
  }, [reservoirs, refreshing]);

  useEffect(() => () => {
    Object.values(refreshTimers.current).forEach(clearTimeout);
  }, []);

  // Sem reservatórios cadastrados → não renderiza nada (nem o card branco de fundo).
  // Early return DEPOIS de todos os hooks para respeitar Rules of Hooks.
  if (!reservoirs || reservoirs.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      {hasAlarm && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-secondary/50">
          <Activity className="w-3.5 h-3.5 text-info" />
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={toggleMute}
            title={muted ? t.enableSound : t.muteAlarm}
          >
            {muted ? (
              <VolumeX className="w-3.5 h-3.5 text-muted-foreground" />
            ) : (
              <Volume2 className="w-3.5 h-3.5 text-destructive animate-pulse" />
            )}
          </Button>
        </div>
      )}
      <div
        className={`grid gap-1.5 p-2 ${
          reservoirs.length === 1
            ? "grid-cols-1"
            : reservoirs.length === 2
              ? "grid-cols-2"
              : reservoirs.length === 3
                ? "grid-cols-2 sm:grid-cols-3"
                : "grid-cols-2 sm:grid-cols-4"
        }`}
      >
        {reservoirs.map((res) => {
          const isOffline = res.online === false;
          const isLow = !isOffline && res.percent < 25;
          const isFull = !isOffline && res.percent >= 95;
          const eta = !isOffline ? drainEta[res.id] : null;
          const isRefreshing = !!refreshing[res.id];
          const result = refreshResult[res.id];

          // Mesma linguagem de cor/borda dos cards de poço: verde = comunicando,
          // vermelho = sem comunicação / nível crítico.
          const bg = isOffline
            ? "bg-muted/60 border-muted-foreground/30 opacity-70 grayscale"
            : isLow
              ? "bg-destructive/25 border-destructive/70"
              : isFull
                ? "bg-primary/25 border-primary/70 shadow-[0_0_0_1px_hsl(var(--primary)/0.3)]"
                : "bg-primary/15 border-primary/50";
          const dotColor = isOffline
            ? "bg-muted-foreground"
            : isLow
              ? "bg-destructive animate-pulse"
              : "bg-primary";

          return (
            <div
              key={res.id}
              className={`flex flex-col gap-1 px-2 py-1.5 rounded-md border-2 ${bg} transition-all duration-300 select-none ${
                !isOffline && (isLow || isFull) ? "animate-alert-flash" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotColor}`} />
                  <span className={`text-xs font-bold truncate ${isOffline ? "text-muted-foreground" : "text-foreground"}`}>
                    {res.name}
                  </span>
                  {!isOffline && res.alarm && <Bell className="w-3 h-3 text-warning animate-pulse-alert shrink-0" />}
                  {isOffline && (
                    <span className="text-[9px] font-bold uppercase tracking-wider shrink-0 px-1 py-0.5 rounded bg-muted text-muted-foreground border border-muted-foreground/40">
                      Offline
                    </span>
                  )}
                </div>
                <span className={`text-sm font-extrabold shrink-0 ${isOffline ? "text-muted-foreground" : getLevelColor(res.percent)}`}>
                  {isOffline ? "—" : `${res.percent}%`}
                </span>
              </div>

              <LevelBar percent={res.percent} offline={isOffline} />

              <div className="flex items-center gap-2 h-4">
                {res.signalRF != null && (
                  <span className="flex items-center gap-1" title={`Sinal RF: ${res.signalRF}%`}>
                    <span className="flex gap-[1px] items-end h-3">
                      {[25, 50, 75, 100].map((threshold) => (
                        <span
                          key={threshold}
                          className={`w-[3px] rounded-[1px] ${
                            !isOffline && res.signalRF! >= threshold
                              ? res.signalRF! >= 70 ? "bg-primary" : res.signalRF! >= 40 ? "bg-warning" : "bg-destructive"
                              : "bg-border"
                          }`}
                          style={{ height: `${threshold / 100 * 12}px` }}
                        />
                      ))}
                    </span>
                  </span>
                )}

                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      onClick={(e) => e.stopPropagation()}
                      className={`flex items-center shrink-0 transition-colors hover:text-primary ${
                        isOffline
                          ? "text-muted-foreground"
                          : isRefreshing
                            ? "text-warning"
                            : result === "success"
                              ? "text-primary"
                              : result === "fail"
                                ? "text-destructive"
                                : "text-primary"
                      }`}
                      title={
                        isRefreshing
                          ? "Atualizando leitura de nível..."
                          : result === "fail"
                            ? "Falha na atualização — clique para tentar novamente"
                            : "Atualizar status (nova leitura do sensor)"
                      }
                    >
                      {isRefreshing ? (
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      ) : result === "success" ? (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      ) : result === "fail" ? (
                        <AlertTriangle className="w-3.5 h-3.5 animate-pulse" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="end" className="w-[320px] p-0 text-xs overflow-hidden">
                    <div className="flex items-center justify-between gap-2 px-3 py-2 bg-secondary/70 border-b border-border">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Droplets className="w-3.5 h-3.5 text-primary shrink-0" />
                        <span className="text-xs font-bold text-foreground truncate">{res.name}</span>
                      </div>
                      <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                        isOffline
                          ? "bg-muted text-muted-foreground"
                          : isLow
                            ? "bg-destructive/20 text-destructive"
                            : isFull
                              ? "bg-primary/20 text-primary"
                              : "bg-primary/20 text-primary"
                      }`}>
                        {isOffline ? "Offline" : isLow ? t.empty : isFull ? t.full : `${res.percent}%`}
                      </span>
                    </div>

                    <div className="p-3 space-y-2">
                      <div className="flex items-start gap-1.5 text-muted-foreground bg-muted/40 rounded-md px-2 py-1.5">
                        <Signal className="w-3 h-3 mt-0.5 shrink-0 text-primary" />
                        <div className="flex-1 min-w-0">
                          <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground/80">Última leitura do sensor</p>
                          <p className="text-xs font-semibold text-foreground truncate">{res.lastReading || "—"}</p>
                          <p className="text-[10px] text-muted-foreground">
                            Nível: <span className="font-bold text-foreground">{res.level} / {res.maxLevel}</span>
                          </p>
                        </div>
                      </div>

                      <LastLevelReadings equipmentId={res.id} />

                      {eta && (
                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-warning bg-warning/10 rounded-md px-2 py-1.5">
                          <TrendingDown className="w-3 h-3 shrink-0" />
                          <span>Esvazia em ~{formatEta(eta.minutesToEmpty)} ({eta.ratePctPerMin.toFixed(2)}%/min)</span>
                        </div>
                      )}

                      {result === "fail" && !isRefreshing && (
                        <p className="text-[11px] font-semibold text-destructive text-center">
                          Falha na atualização — tente novamente
                        </p>
                      )}

                      <button
                        onClick={(e) => { e.stopPropagation(); handleRefresh(res.id); }}
                        disabled={isRefreshing}
                        className="flex items-center justify-center gap-1.5 text-[11px] font-bold text-primary hover:bg-primary/10 transition-colors w-full py-1.5 rounded border border-primary/30 disabled:opacity-60"
                      >
                        <RefreshCw className={`w-3 h-3 ${isRefreshing ? "animate-spin" : ""}`} />
                        {isRefreshing ? "Atualizando..." : "Atualizar status agora"}
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>

                <span className={`text-[11px] ml-auto ${isOffline ? "text-muted-foreground/70" : "text-muted-foreground"}`}>
                  {isOffline ? "—" : `${res.level} / ${res.maxLevel}`}
                </span>
              </div>

              {eta && (
                <div
                  className="flex items-center gap-1 text-[10px] font-semibold text-warning"
                  title={`Tendência de descida: ${eta.ratePctPerMin.toFixed(2)}%/min`}
                >
                  <TrendingDown className="w-3 h-3 shrink-0" />
                  <span>Esvazia em ~{formatEta(eta.minutesToEmpty)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
