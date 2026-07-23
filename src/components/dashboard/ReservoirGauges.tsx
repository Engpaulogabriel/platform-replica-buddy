import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Activity, Bell, Volume2, VolumeX, RefreshCw, TrendingDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAlarmSound } from "@/hooks/useAlarmSound";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";
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
}

function getLevelColor(percent: number) {
  if (percent >= 95) return "text-primary";
  if (percent >= 60) return "text-primary";
  if (percent >= 30) return "text-warning";
  return "text-destructive";
}

function MiniBar({ percent }: { percent: number }) {
  const isLow = percent < 25;
  const color = percent >= 60 ? "bg-primary" : percent >= 30 ? "bg-warning" : "bg-destructive";
  return (
    <div className={`w-full h-2 rounded-full overflow-hidden ${isLow ? "bg-destructive/20" : "bg-secondary"}`}>
      <div
        className={`h-full rounded-full transition-all ${color} ${isLow ? "animate-bar-flash" : ""}`}
        style={{ width: `${percent}%` }}
      />
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
  const refreshTimers = useRef<Record<string, NodeJS.Timeout>>({});
  const prevReservoirs = useRef(reservoirs);
  const reservoirIds = useMemo(() => reservoirs.map((r) => r.id), [reservoirs]);
  const drainEta = useReservoirDrainEta(reservoirIds);

  const handleRefresh = useCallback((id: string) => {
    if (refreshing[id]) return;
    setRefreshing(prev => ({ ...prev, [id]: true }));
    onRefreshStatus?.(id);

    refreshTimers.current[id] = setTimeout(() => {
      setRefreshing(prev => {
        if (prev[id]) {
          notify.warn("Reservatório", `${reservoirs.find(r => r.id === id)?.name || id}: status não atualizado em 1 minuto`);
          const next = { ...prev };
          delete next[id];
          return next;
        }
        return prev;
      });
    }, 60000);
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
        notify.ok("Reservatório", `${newR.name}: status atualizado com sucesso`);
      }
    });
    prevReservoirs.current = reservoirs;
  }, [reservoirs, refreshing]);

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
          return (
            <div
              key={res.id}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors ${
                isOffline
                  ? "bg-muted/30 border border-border opacity-70"
                  : isLow
                    ? "bg-destructive/10 border border-destructive/40 animate-alert-flash"
                    : isFull
                      ? "bg-primary/10 border border-primary/40 animate-alert-flash"
                      : "bg-secondary/20"
              }`}
            >
              <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className={`text-xs font-semibold truncate ${isOffline ? "text-muted-foreground" : "text-foreground"}`}>{res.name}</span>
                  {!isOffline && res.alarm && <Bell className="w-3 h-3 text-warning animate-pulse-alert shrink-0" />}
                  {isOffline && (
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider shrink-0 px-1.5 py-0.5 rounded bg-muted/50 border border-border">
                      Offline
                    </span>
                  )}
                  {isLow && (
                    <span className="text-xs font-extrabold text-destructive uppercase tracking-wider animate-alert-flash shrink-0">
                      ⚠ {t.empty}
                    </span>
                  )}
                  {isFull && (
                    <span className="text-xs font-extrabold text-primary uppercase tracking-wider animate-alert-flash shrink-0">
                      ⚠ {t.full}
                    </span>
                  )}
                  <span className={`text-xs font-bold ml-auto ${isOffline ? "text-muted-foreground" : getLevelColor(res.percent)}`}>
                    {isOffline ? "—" : `${res.percent}%`}
                  </span>
                </div>
                <div className={isOffline ? "opacity-50 grayscale" : ""}>
                  <MiniBar percent={isOffline ? 0 : res.percent} />
                </div>
                <div className="flex items-center gap-1">
                  <div className="flex items-center gap-1.5">
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
                          onClick={(e) => { e.stopPropagation(); handleRefresh(res.id); }}
                          className={`flex items-center shrink-0 transition-colors ${isOffline ? "text-muted-foreground hover:text-foreground" : "text-primary hover:text-primary"}`}
                          title="Atualizar status"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${refreshing[res.id] ? "animate-spin" : ""}`} />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent side="top" className="w-auto p-2 text-xs space-y-0.5">
                        <p className="font-semibold text-foreground">Última atualização</p>
                        {res.lastReading && (
                          <p className="text-muted-foreground">📡 {res.lastReading}</p>
                        )}
                        <div className="border-t border-border my-1" />
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRefresh(res.id); }}
                          className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground hover:text-primary transition-colors w-full"
                        >
                          <RefreshCw className={`w-3 h-3 ${refreshing[res.id] ? "animate-spin" : ""}`} />
                          {refreshing[res.id] ? "Atualizando..." : "Atualizar status"}
                        </button>
                      </PopoverContent>
                    </Popover>
                  </div>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
