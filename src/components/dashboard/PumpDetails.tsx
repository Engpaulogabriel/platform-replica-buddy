import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Bot, Clock, Droplets, Gauge, Hand, MapPin, Power, Zap, Activity, FileText, Signal, ZapOff, AlertTriangle } from "lucide-react";
import { useUserOnline } from "@/contexts/UserOnlineContext";
import { useCurrentFarmMaintenance } from "@/hooks/useCurrentFarmMaintenance";
import type { Pump } from "./PumpTable";

interface PumpDetailsProps {
  pumps: Pump[];
  onToggle: (id: string) => void;
  flowEnabled: boolean;
  consumptionEnabled: boolean;
  voltageEnabled?: boolean;
  currentEnabled?: boolean;
}

export function PumpDetails({ pumps, onToggle, flowEnabled, consumptionEnabled, voltageEnabled, currentEnabled }: PumpDetailsProps) {
  const { online: userOnline } = useUserOnline();
  const { active: maintenanceActive } = useCurrentFarmMaintenance();
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/50">
        <Power className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">Detalhes dos Poços</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1.5 p-2">
        {pumps.map((pump) => {
          // Amarelo APENAS em transição (ligando/desligando). Nunca em "Instável", "error" ou outros.
          const isTransitioning = pump.pending === "turning_on" || pump.pending === "turning_off" || pump.pending === "resetting";
          const isPending = !!pump.pending;
          const isOffline = pump.communicationStatus === "offline";
          const isUnstable = pump.communicationStatus === "unstable";
          const borderColor = isOffline
            ? "border-muted-foreground/30"
            : isTransitioning
              ? "border-warning/40"
              : pump.running
                ? "border-primary/40"
                : "border-destructive/40";
          const bgColor = isOffline
            ? "bg-muted"
            : isTransitioning
              ? "bg-warning/5"
              : pump.running
                ? "bg-primary/5"
                : "bg-destructive/5";
          const dotColor = isOffline
            ? "bg-muted-foreground"
            : isTransitioning
              ? "bg-warning animate-pulse"
              : pump.running
                ? "bg-primary"
                : "bg-destructive";
          const commBadgeClass = isOffline
            ? "bg-muted-foreground/15 text-muted-foreground"
            : isUnstable
              ? "bg-info/15 text-info"
              : "bg-primary/15 text-primary";
          const commBadgeLabel = isOffline ? "Offline" : isUnstable ? "Instável" : "Online";

          return (
            <div key={pump.id} className={`rounded-lg border-2 ${borderColor} ${bgColor} p-3 space-y-2 transition-all duration-300 ${
              !isOffline && pump.running && !isPending ? "animate-pump-glow" : ""
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-3 h-3 rounded-full ${dotColor} ${!isOffline && pump.running && !isPending ? "animate-dot-pulse" : ""}`} />
                  <span className={`font-bold text-sm ${isOffline ? "text-muted-foreground" : "text-foreground"}`}>{pump.name}</span>
                  {pump.mode === "auto" && (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-info/20 text-info font-bold text-[10px] uppercase tracking-wide border border-info/30">
                      <Bot className="w-3 h-3" />
                      AUTO
                    </span>
                  )}
                  {pump.actuationOrigin === "local" && !isOffline && !isTransitioning && (
                    <span
                      className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-warning/20 text-warning font-bold text-[10px] uppercase tracking-wide border border-warning/40"
                      title="Acionamento local detectado — bomba não obedeceu o comando remoto"
                    >
                      <AlertTriangle className="w-3 h-3" />
                      LOCAL
                    </span>
                  )}
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${commBadgeClass}`}>
                  {commBadgeLabel}
                </span>
              </div>

              <div className="space-y-1 text-xs">
                <div className="flex items-center gap-2 text-muted-foreground">
                  {pump.mode === "auto" ? <Bot className="w-3 h-3 shrink-0 text-info" /> : <Hand className="w-3 h-3 shrink-0" />}
                  <span>Modo:</span>
                  <span className={`font-semibold ml-auto ${pump.mode === "auto" ? "text-info" : "text-foreground"}`}>
                    {pump.mode === "auto" ? "Automático" : "Manual"}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Clock className="w-3 h-3 shrink-0" />
                  <span>Horímetro Mês:</span>
                  <span className="font-semibold text-foreground ml-auto">{pump.horimetroMes}</span>
                </div>
                {flowEnabled && pump.hasFlow && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Gauge className="w-3 h-3 shrink-0" />
                    <span>Total acum.:</span>
                    <span className="font-semibold text-foreground ml-auto">{pump.flowRate}</span>
                  </div>
                )}
                {consumptionEnabled && pump.hasFlow && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Droplets className="w-3 h-3 shrink-0" />
                    <span>Consumo Hoje:</span>
                    <span className="font-semibold text-foreground ml-auto">{pump.dailyConsumption}</span>
                  </div>
                )}
                {pump.lat != null && pump.lng != null && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <MapPin className="w-3 h-3 shrink-0" />
                    <span className="text-[10px]">{pump.lat.toFixed(5)}, {pump.lng.toFixed(5)}</span>
                  </div>
                )}
                {voltageEnabled && (
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Zap className="w-3 h-3 shrink-0 text-info" />
                      <span>Tensão:</span>
                      <span className="font-semibold ml-auto text-info">{pump.voltage ?? 0} V</span>
                      <span className="text-[9px] text-muted-foreground/70">/ 380 V</span>
                    </div>
                    <div className="h-1 rounded-full bg-secondary overflow-hidden">
                      <div className="h-full bg-info transition-all" style={{ width: `${Math.min(100, ((pump.voltage ?? 0) / 380) * 100)}%` }} />
                    </div>
                  </div>
                )}
                {currentEnabled && (
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Activity className="w-3 h-3 shrink-0 text-warning" />
                      <span>Corrente:</span>
                      <span className="font-semibold ml-auto text-warning">{pump.current ?? 0} A</span>
                      <span className="text-[9px] text-muted-foreground/70">/ 1300 A</span>
                    </div>
                    <div className="h-1 rounded-full bg-secondary overflow-hidden">
                      <div className="h-full bg-warning transition-all" style={{ width: `${Math.min(100, ((pump.current ?? 0) / 1300) * 100)}%` }} />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-1 border-t border-border/50">
                <span className={`text-xs font-bold ${
                  !pump.online
                    ? "text-muted-foreground"
                    : isTransitioning
                      ? "text-warning"
                      : pump.pending === "error"
                        ? "text-destructive"
                        : pump.running
                          ? "text-primary"
                          : "text-destructive"
                }`}>
                  {!pump.online
                    ? "Offline"
                    : pump.pending === "error"
                      ? "⚠ Verificar Poço - Problema no comando"
                      : isPending
                        ? pump.pending === "turning_on" ? "⏳ Ligando..." : pump.pending === "resetting" ? "⏳ Resetando..." : "⏳ Desligando..."
                        : pump.running ? "⚡ Ligada" : "Desligada"}
                </span>
                <div className="flex items-center gap-1.5">
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        title="Mini-relatório (últimos comandos e leituras)"
                        className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-1.5 py-1 rounded border border-border bg-secondary/60 hover:bg-secondary text-foreground transition-colors"
                      >
                        <FileText className="w-3 h-3 text-primary" />
                        Mini-relatório
                      </button>
                    </PopoverTrigger>
                    <PopoverContent side="top" align="end" className="w-[320px] p-0 text-xs overflow-hidden">
                      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-secondary/70 border-b border-border">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Droplets className="w-3.5 h-3.5 text-primary shrink-0" />
                          <span className="text-xs font-bold text-foreground truncate">{pump.name}</span>
                        </div>
                        {pump.online && pump.actuationOrigin === "local"
                          && pump.pending !== "turning_on" && pump.pending !== "turning_off" ? (
                          <span
                            className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-warning/20 text-warning border border-warning/40"
                            title="Acionada localmente no painel"
                          >
                            <AlertTriangle className="w-3 h-3" />
                            {pump.running ? "Ligado · Local" : "Desligado · Local"}
                          </span>
                        ) : (
                          <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                            !pump.online
                              ? "bg-muted text-muted-foreground"
                              : pump.running
                                ? "bg-primary/20 text-primary"
                                : "bg-destructive/20 text-destructive"
                          }`}>
                            {!pump.online ? "Offline" : pump.running ? "Ligado" : "Desligado"}
                          </span>
                        )}
                      </div>

                      <div className="p-3 space-y-2">
                        {pump.lastReading && (
                          <div className="flex items-start gap-1.5 text-muted-foreground bg-muted/40 rounded-md px-2 py-1.5">
                            <Signal className="w-3 h-3 mt-0.5 shrink-0 text-primary" />
                            <div className="flex-1 min-w-0">
                              <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground/80">Última leitura do poço</p>
                              <p className="text-xs font-semibold text-foreground truncate">{pump.lastReading}</p>
                              <p className="text-[10px] text-muted-foreground">
                                {pump.actuationOrigin === "local" ? (
                                  <span className="font-bold text-warning">Local</span>
                                ) : (
                                  <>
                                    Estava: <span className={`font-bold ${pump.running ? "text-primary" : "text-destructive"}`}>
                                      {pump.running ? "Ligado" : "Desligado"}
                                    </span>
                                  </>
                                )}
                              </p>
                            </div>
                          </div>
                        )}

                        {pump.commandHistory && pump.commandHistory.length > 0 && (
                          <div>
                            <p className="text-[10px] uppercase tracking-wide font-bold text-foreground mb-1 flex items-center gap-1">
                              <Bot className="w-3 h-3 text-info" />
                              Últimos comandos
                            </p>
                            <div className="space-y-1">
                              {pump.commandHistory.slice(0, 3).map((cmd, i) => {
                                const isOn = /ligar/i.test(cmd.action);
                                const isLocal = /local/i.test(cmd.action);
                                const failed = !isLocal && cmd.result === "fail";
                                return (
                                  <div key={i} className="flex items-center gap-1.5 px-1.5 py-1 rounded bg-secondary/40">
                                    {isOn ? (
                                      <Zap className={`w-3 h-3 shrink-0 ${failed ? "text-destructive" : "text-primary"}`} />
                                    ) : (
                                      <ZapOff className={`w-3 h-3 shrink-0 ${failed ? "text-destructive" : "text-muted-foreground"}`} />
                                    )}
                                    <span className={`font-semibold ${isOn ? "text-primary" : "text-foreground"}`}>
                                      {isOn ? "Ligar" : "Desligar"}
                                    </span>
                                    <span className={`text-[9px] font-bold uppercase tracking-wide px-1 py-px rounded border ${
                                      isLocal
                                        ? "bg-warning/15 text-warning border-warning/30"
                                        : "bg-info/15 text-info border-info/30"
                                    }`}>
                                      {isLocal ? "Local" : "Remoto"}
                                    </span>
                                    {failed && (
                                      <span className="text-[9px] font-bold text-destructive uppercase">Falhou</span>
                                    )}
                                    <span className="text-[10px] text-muted-foreground ml-auto whitespace-nowrap">{cmd.time}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {pump.statusHistory && pump.statusHistory.length > 0 && (
                          <div>
                            <p className="text-[10px] uppercase tracking-wide font-bold text-foreground mb-1 flex items-center gap-1">
                              <Signal className="w-3 h-3 text-primary" />
                              Últimas leituras de status
                            </p>
                            <div className="space-y-1">
                              {pump.statusHistory.slice(0, 3).map((st, i) => {
                                const isLocal = st.source === "local";
                                return (
                                  <div key={i} className="flex items-center gap-1.5 px-1.5 py-1 rounded bg-secondary/40">
                                    <span className={`w-2 h-2 rounded-full shrink-0 ${st.status === "Ligado" ? "bg-primary" : "bg-destructive"}`} />
                                    <span className={`font-semibold ${st.status === "Ligado" ? "text-primary" : "text-destructive"}`}>
                                      {st.status}
                                    </span>
                                    <span className={`text-[9px] font-bold uppercase tracking-wide px-1 py-px rounded border ${
                                      isLocal
                                        ? "bg-warning/15 text-warning border-warning/30"
                                        : "bg-info/15 text-info border-info/30"
                                    }`}>
                                      {isLocal ? "Local" : "Remoto"}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground ml-auto whitespace-nowrap">{st.time}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {(!pump.commandHistory?.length && !pump.statusHistory?.length) && (
                          <p className="text-[11px] text-muted-foreground text-center py-2">
                            Sem histórico disponível.
                          </p>
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Switch
                    checked={pump.running || pump.pending === "turning_on"}
                    onCheckedChange={() => onToggle(pump.id)}
                    disabled={
                      !userOnline ||
                      maintenanceActive ||
                      !pump.online ||
                      pump.mode === "auto" ||
                      ((pump.pending === "turning_off" || pump.pending === "resetting")) ||
                      (!!pump.commandBlockedUntil && new Date(pump.commandBlockedUntil).getTime() > Date.now())
                    }
                    className="data-[state=checked]:bg-primary scale-75"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
