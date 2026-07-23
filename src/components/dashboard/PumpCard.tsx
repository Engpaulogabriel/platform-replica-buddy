// ─────────────────────────────────────────────────────────────────────────────
// PumpCard — card individual do grid "Poços e Bombas".
// Extraído de PumpTable e envolto em React.memo com comparator por valor:
// toggle/refresh em 1 bomba NÃO re-renderiza as outras 28.
// ─────────────────────────────────────────────────────────────────────────────
import { memo, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Droplets, Bot, AlertTriangle, Signal, XCircle, RotateCcw, RefreshCw,
  CheckCircle2, MapPin, Layers, Tractor, Zap, ZapOff, MessageCircle, Lock,
  Hand, Info,
} from "lucide-react";

import { formatLastSeen } from "@/hooks/useDashboardEquipment";
import { clearAutomationGuard } from "@/lib/automationGuard";
import { derivePumpState } from "@/lib/pumpStateMachine";
import { findSectorForEquipment, type Farm, type Sector } from "@/lib/sectors";
import { notify } from "@/lib/notify";

import { LazyVisible } from "@/components/LazyVisible";
import { usePermission } from "@/contexts/MasterManagerContext";
import type { Pump } from "./PumpTable";


export interface PumpCardProps {
  pump: Pump;
  expanded: boolean;
  refreshing: boolean;
  refreshResult?: "success" | "fail";
  lastFailed: boolean;
  flashStatus?: "Ligado" | "Desligado";
  isGuarded: boolean;
  /** True quando o equipamento tem ao menos uma programação ATIVA na nuvem
   *  e o motor de automação está ligado. Derivado do hook
   *  useAutomationActiveEquipments — funciona igualmente para poços e
   *  bombas de captação (não depende do flag eventual `pump.mode`). */
  isAutoSchedule?: boolean;
  /** True quando o equipamento está em MANUTENÇÃO (bloqueado individualmente). */
  inMaintenance?: boolean;
  /** Tooltip detalhado da manutenção (motivo + início). */
  maintenanceTooltip?: string;
  userOnline: boolean;
  maintenanceActive: boolean;
  voltageEnabled?: boolean;
  currentEnabled?: boolean;
  farms: Farm[];
  sectors: Sector[];
  defaultFarmName?: string | null;
  guardFarmId: string | null;
  virtualize: boolean;
  onToggle: (id: string) => void;
  onReset?: (id: string) => void;
  onRefresh: (id: string) => void;
  onOpenDialog: (pump: Pump) => void;
  onToggleExpand: (id: string) => void;
}

function PumpCardImpl(props: PumpCardProps) {
  const {
    pump, expanded, refreshing, refreshResult, lastFailed, flashStatus,
    isGuarded, isAutoSchedule, inMaintenance, maintenanceTooltip,
    userOnline, maintenanceActive, voltageEnabled, currentEnabled,
    farms, sectors, defaultFarmName, guardFarmId, virtualize,
    onToggle, onReset, onRefresh, onOpenDialog, onToggleExpand,
  } = props;
  const canCommandPumps = usePermission("can_command_pumps");
  // AUTO badge: vale tanto o flag local `mode` (sincronizado via efeito) quanto
  // o derivado direto da nuvem. Isto garante que poços recém-carregados
  // (ainda com mode="manual" antes do sync) exibam o badge corretamente.
  const inAutoMode = pump.mode === "auto" || !!isAutoSchedule;


  const stateInfo = derivePumpState(pump);
  const isTransitioning = pump.pending === "turning_on" || pump.pending === "turning_off" || pump.pending === "resetting";
  const isPending = !!pump.pending;
  const isOffline = pump.communicationStatus === "offline";
  const isUnstable = pump.communicationStatus === "unstable";
  const isCommFail = stateInfo.isCommFail;

  // ── Badge de origem LOCAL ─────────────────────────────────────────────────
  // Indicador permanente: último acionamento foi no painel físico do poço.
  const showLocal = !isOffline && pump.actuationOrigin === "local";

  const bg = inMaintenance
    ? "bg-[#FFF3E0] dark:bg-amber-950/30 border-l-[3px] border-l-amber-500 border-amber-300/60"
    : isOffline
      ? "bg-muted/60 border-muted-foreground/30 opacity-70 grayscale"
      : isCommFail
        ? "bg-destructive/25 border-destructive/70"
        : isTransitioning
          ? "bg-warning/20 border-warning/60"
          : pump.running
            ? "bg-primary/25 border-primary/70 shadow-[0_0_0_1px_hsl(var(--primary)/0.3)]"
            : "bg-destructive/20 border-destructive/60";

  const dotColor = inMaintenance
    ? "bg-muted-foreground"
    : isOffline
      ? "bg-muted-foreground"
      : isCommFail
        ? "bg-destructive animate-pulse"
        : isTransitioning
          ? "bg-warning animate-pulse"
          : pump.running
            ? "bg-primary"
            : "bg-destructive";


  const cardNode = (
    <div
      className={`flex flex-col gap-1 px-2 py-1.5 rounded-md border-2 ${bg} transition-all duration-300 cursor-pointer select-none ${
        !inMaintenance && !isOffline && pump.running && !isPending ? "animate-pump-glow" : ""
      }`}

      onClick={() => onToggleExpand(pump.id)}
      onDoubleClick={() => onOpenDialog(pump)}
    >
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotColor} ${!isOffline && pump.running && !isPending ? "animate-dot-pulse" : ""}`} />
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className={`text-xs font-bold truncate text-left hover:underline focus:outline-none focus:underline ${isOffline ? "text-muted-foreground" : "text-foreground"}`}
                title="Ver fazenda e setor"
              >
                {pump.name}
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-[260px] p-0 text-xs overflow-hidden">
              <div className="flex items-center gap-1.5 px-3 py-2 bg-secondary/70 border-b border-border">
                <MapPin className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="text-xs font-bold text-foreground truncate">Localização do equipamento</span>
              </div>
              {(() => {
                const sector = findSectorForEquipment(pump.id, sectors);
                const farm = sector ? farms.find((f) => f.id === sector.farmId) : undefined;
                return (
                  <div className="p-3 space-y-2">
                    <div className="flex items-start gap-2 bg-muted/40 rounded-md px-2 py-1.5">
                      <Tractor className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground/80">Fazenda</p>
                        <p className="text-xs font-bold text-foreground truncate">
                          {farm?.nome ?? defaultFarmName ?? <span className="text-muted-foreground italic">—</span>}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2 bg-muted/40 rounded-md px-2 py-1.5">
                      <Layers className="w-3.5 h-3.5 mt-0.5 shrink-0 text-info" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground/80">Setor / Grupo</p>
                        <p className="text-xs font-bold text-foreground truncate">
                          {sector?.nome ?? <span className="text-muted-foreground italic">Sem setor</span>}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 bg-secondary/40 rounded-md px-2 py-1.5">
                      <Droplets className="w-3.5 h-3.5 shrink-0 text-primary" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground/80">Equipamento</p>
                        <p className="text-xs font-bold text-foreground truncate">{pump.name}</p>
                      </div>
                    </div>
                    {!sector && (
                      <p className="text-[10px] text-muted-foreground text-center pt-1">
                        Atribua este poço a um setor em <span className="font-semibold text-foreground">Cadastros → Setores</span>.
                      </p>
                    )}
                  </div>
                );
              })()}
            </PopoverContent>
          </Popover>
          {isOffline && (
            <span
              className="text-[9px] font-bold uppercase tracking-wider px-1 py-0.5 rounded bg-muted text-muted-foreground border border-muted-foreground/40 shrink-0"
              title={`Sem comunicação há mais de 20 min — última: ${formatLastSeen(pump.lastCommunication)}`}
            >
              Offline
            </span>
          )}
          {/* Badges LOCAL/AUTO/MANUTENÇÃO ficam na LINHA 2 (abaixo), nunca na linha do nome. */}


        </div>
        <div className="flex items-center gap-1 shrink-0">
          {inMaintenance ? (
            <span
              className="flex items-center justify-center w-5 h-5 rounded text-muted-foreground"
              title={maintenanceTooltip || "Equipamento em MANUTENÇÃO — controles bloqueados"}
              onClick={(e) => e.stopPropagation()}
            >
              <Lock className="w-3.5 h-3.5" />
            </span>
          ) : (
            <>
              {(pump.pending === "turning_on" || (pump.pending === "error" && pump.running)) && onReset ? (
                <button
                  onClick={(e) => { e.stopPropagation(); onReset(pump.id); }}
                  className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-destructive/15 text-destructive font-bold text-[10px] uppercase tracking-wide border border-destructive/30 hover:bg-destructive/25 transition-colors"
                  title="Resetar comando — forçar desligamento"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset
                </button>
              ) : null}
              <Switch
                checked={pump.running || pump.pending === "turning_on"}
                onCheckedChange={() => onToggle(pump.id)}
                disabled={
                  !canCommandPumps ||
                  !userOnline ||
                  maintenanceActive ||
                  isOffline ||
                  inAutoMode ||
                  pump.pending === "turning_off" ||
                  pump.pending === "resetting" ||
                  (!!pump.commandBlockedUntil && new Date(pump.commandBlockedUntil).getTime() > Date.now())
                }
                className="data-[state=checked]:bg-primary scale-[0.6] shrink-0"
                title={!canCommandPumps ? "Sem permissão para acionar bombas" : stateInfo.label}
              />

            </>
          )}
        </div>

      </div>
      <div className="flex items-center gap-2 h-4">
        <div className="flex items-center gap-2">
          {pump.signalRF != null && (
            <span
              className="flex items-center gap-1"
              title={
                isOffline
                  ? `Sem sinal RF — última comunicação ${formatLastSeen(pump.lastCommunication)}`
                  : isUnstable
                    ? `Sinal instável — última comunicação ${formatLastSeen(pump.lastCommunication)}`
                    : `Sinal RF: ${pump.signalRF}% — última comunicação ${formatLastSeen(pump.lastCommunication)}`
              }
            >
              <span className="flex gap-[1px] items-end h-3">
                {[25, 50, 75, 100].map((threshold) => (
                  <span
                    key={threshold}
                    className={`w-[3px] rounded-[1px] ${
                      isOffline
                        ? "bg-border"
                        : pump.signalRF! >= threshold
                          ? pump.signalRF! >= 70 ? "bg-primary" : pump.signalRF! >= 40 ? "bg-warning" : "bg-destructive"
                          : "bg-border"
                    }`}
                    style={{ height: `${threshold / 100 * 12}px` }}
                  />
                ))}
              </span>
            </span>
          )}
          {pump.vazaoMode && pump.vazaoMode !== "off" && (
            <FlowInfoPopover pump={pump} />
          )}
          <Popover>
            <PopoverTrigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                className={`flex items-center shrink-0 transition-colors hover:text-primary ${
                  isOffline
                    ? "text-muted-foreground"
                    : refreshing || isTransitioning
                      ? lastFailed ? "text-destructive" : "text-warning"
                      : refreshResult === "success"
                        ? "text-primary"
                        : refreshResult === "fail" || lastFailed
                          ? "text-destructive"
                          : isUnstable
                            ? "text-info"
                            : "text-primary"
                }`}
                title={
                  refreshing
                    ? "Atualizando leitura da bomba..."
                    : isPending && pump.pending !== "error"
                      ? pump.pending === "turning_on" ? "Ligando..." : pump.pending === "resetting" ? "Resetando..." : "Desligando..."
                      : refreshResult === "success"
                        ? "Leitura confirmada com sucesso"
                        : refreshResult === "fail" || lastFailed
                          ? "Falha na última leitura — clique para tentar novamente"
                          : "Atualizar status (faz nova leitura na bomba)"
                }
              >
                {refreshing || (isPending && pump.pending !== "error") ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : refreshResult === "success" ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : refreshResult === "fail" || lastFailed ? (
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
                  <span className="text-xs font-bold text-foreground truncate">{pump.name}</span>
                </div>
                {isCommFail ? (
                  <span
                    className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-destructive/20 text-destructive border border-destructive/40"
                    title="Falha de comunicação — sem confirmação física em 120s"
                  >
                    <XCircle className="w-3 h-3" />
                    Falha de Comm
                  </span>
                ) : showLocal && !isTransitioning ? (
                  <span
                    className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-warning/20 text-warning border border-warning/40"
                    title="Último acionamento via painel local"
                  >
                    <Hand className="w-3 h-3" />
                    Local
                  </span>
                ) : (
                  <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                    isOffline
                      ? "bg-muted text-muted-foreground"
                      : isUnstable
                        ? "bg-warning/20 text-warning"
                        : pump.running
                          ? "bg-primary/20 text-primary"
                          : "bg-destructive/20 text-destructive"
                  }`}>
                    {isOffline ? "Offline" : isUnstable ? "Instável" : pump.running ? "Ligado" : "Desligado"}
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
                        {showLocal && !isTransitioning ? (
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

                <button
                  onClick={(e) => { e.stopPropagation(); onRefresh(pump.id); }}
                  disabled={refreshing}
                  className="flex items-center justify-center gap-1.5 text-[11px] font-bold text-primary hover:bg-primary/10 transition-colors w-full py-1.5 rounded border border-primary/30 disabled:opacity-60"
                >
                  <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
                  {refreshing ? "Atualizando..." : "Atualizar status agora"}
                </button>
              </div>
            </PopoverContent>
          </Popover>
          {/* Badge LOCAL/AUTO — LINHA 2, à direita dos ícones. Mutuamente exclusivos.
              LOCAL ganha de AUTO (último acionamento foi no painel físico).
              MANUTENÇÃO é independente — aparece SEMPRE que ativa, junto dos outros. */}
          <div className="ml-auto flex items-center gap-1 shrink-0">
            {inMaintenance && (
              <span
                className="flex items-center gap-0.5 px-1 py-0 rounded bg-orange-500/20 text-orange-600 dark:text-orange-400 font-bold text-[9px] uppercase tracking-wide border border-orange-500/50 shrink-0"
                title={maintenanceTooltip || "Em manutenção"}
              >
                🔧 MANUTENÇÃO
              </span>
            )}

            {showLocal && (
              <span
                className="flex items-center gap-0.5 px-1 py-0 rounded bg-warning/20 text-warning font-bold text-[9px] uppercase tracking-wide border border-warning/40 shrink-0"
                title={
                  pump.running
                    ? "Último acionamento via painel local/botoeira"
                    : "Bomba não respondeu ao último comando remoto — pode estar em modo LOCAL/botoeira"
                }
                aria-label="Bomba em modo local"
              >
                <Hand className="w-2.5 h-2.5" />
                LOCAL
              </span>
            )}
            {/* WhatsApp icon (origin) e AUTO badge são INDEPENDENTES — podem aparecer juntos. */}
            {!isOffline && pump.actuationOrigin === "whatsapp" && (
              <span
                className="flex items-center justify-center w-5 h-5 rounded-full bg-[#25D366]/20 border border-[#25D366]/50 shrink-0"
                title="Último acionamento veio via WhatsApp"
                aria-label="WhatsApp"
              >
                <MessageCircle className="w-3 h-3 text-[#1ea952]" />
              </span>
            )}
            {inAutoMode && !isOffline && (
              <span
                className="flex items-center gap-0.5 px-1 py-0 rounded bg-info/20 text-info font-bold text-[9px] uppercase tracking-wide border border-info/40 shrink-0"
                title="Bomba em modo Automático — controlada por programação"
                aria-label="Modo automático"
              >
                <Bot className="w-2.5 h-2.5" />
                AUTO
              </span>
            )}

          </div>
        </div>
        <div className="flex items-center gap-1 ml-auto">

          {pump.online && !inMaintenance && (() => {
            const pendingLabel = pump.pending === "turning_on" ? "Ligando..." : pump.pending === "turning_off" ? "Desligando..." : pump.pending === "resetting" ? "Resetando..." : null;
            const label = pendingLabel || flashStatus;
            if (!label) return null;
            const color = pendingLabel
              ? "text-warning"
              : flashStatus === "Ligado" ? "text-primary" : "text-destructive";
            return (
              <span className={`text-[10px] font-bold uppercase tracking-wide ${color} ${pendingLabel ? "animate-pulse" : ""}`}>
                {label}
              </span>
            );
          })()}
        </div>
      </div>
      {pump.online && (voltageEnabled || currentEnabled) && (
        <div className="flex items-center gap-1.5 pt-1 border-t border-border/40">
          {voltageEnabled && (
            <div className="flex-1 min-w-0" title={`Tensão: ${pump.voltage ?? 0} V (0 a 380 V)`}>
              <div className="flex items-center justify-between text-[9px] uppercase tracking-wide font-bold text-muted-foreground">
                <span>V</span>
                <span className={`${(pump.voltage ?? 0) > 0 ? "text-info" : "text-muted-foreground"}`}>{pump.voltage ?? 0} V</span>
              </div>
              <div className="h-1 rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full bg-info transition-all"
                  style={{ width: `${Math.min(100, ((pump.voltage ?? 0) / 380) * 100)}%` }}
                />
              </div>
            </div>
          )}
          {currentEnabled && (
            <div className="flex-1 min-w-0" title={`Corrente: ${pump.current ?? 0} A (0 a 1300 A)`}>
              <div className="flex items-center justify-between text-[9px] uppercase tracking-wide font-bold text-muted-foreground">
                <span>A</span>
                <span className={`${(pump.current ?? 0) > 0 ? "text-warning" : "text-muted-foreground"}`}>{pump.current ?? 0} A</span>
              </div>
              <div className="h-1 rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full bg-warning transition-all"
                  style={{ width: `${Math.min(100, ((pump.current ?? 0) / 1300) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  if (virtualize) {
    return <LazyVisible minHeight={56}>{cardNode}</LazyVisible>;
  }
  return cardNode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparator: skip render when nothing relevant changed.
// Toggle de 1 bomba ⇒ React.memo bloqueia re-render dos outros 28.
// ─────────────────────────────────────────────────────────────────────────────
function areEqual(prev: PumpCardProps, next: PumpCardProps): boolean {
  const a = prev.pump, b = next.pump;
  if (
    a.id !== b.id ||
    a.name !== b.name ||
    a.online !== b.online ||
    a.running !== b.running ||
    a.communicationStatus !== b.communicationStatus ||
    a.pending !== b.pending ||
    a.pendingStartedAt !== b.pendingStartedAt ||
    a.lastUserConfirmedAt !== b.lastUserConfirmedAt ||
    a.actuationOrigin !== b.actuationOrigin ||
    a.localAckAt !== b.localAckAt ||
    a.commandBlockedUntil !== b.commandBlockedUntil ||
    a.mode !== b.mode ||
    a.signalRF !== b.signalRF ||
    a.voltage !== b.voltage ||
    a.current !== b.current ||
    a.lastReading !== b.lastReading ||
    a.lastCommunication !== b.lastCommunication ||
    a.horimetroMes !== b.horimetroMes ||
    a.hasFlow !== b.hasFlow ||
    a.flowRate !== b.flowRate ||
    a.dailyConsumption !== b.dailyConsumption ||
    a.vazaoMode !== b.vazaoMode ||
    a.vazaoAtualM3h !== b.vazaoAtualM3h ||
    a.consumoMesM3 !== b.consumoMesM3 ||
    a.flowTotalM3 !== b.flowTotalM3 ||
    a.lat !== b.lat ||
    a.lng !== b.lng ||
    a.hwId !== b.hwId
  ) return false;

  // Histories: comparar primeiro item + tamanho (suficiente — mini-relatório
  // mostra só os 3 mais recentes; mudança vira novo primeiro item).
  const aCmd = a.commandHistory, bCmd = b.commandHistory;
  if ((aCmd?.length || 0) !== (bCmd?.length || 0)) return false;
  if (aCmd?.[0]?.time !== bCmd?.[0]?.time || aCmd?.[0]?.action !== bCmd?.[0]?.action || aCmd?.[0]?.result !== bCmd?.[0]?.result) return false;

  const aSt = a.statusHistory, bSt = b.statusHistory;
  if ((aSt?.length || 0) !== (bSt?.length || 0)) return false;
  if (aSt?.[0]?.time !== bSt?.[0]?.time || aSt?.[0]?.status !== bSt?.[0]?.status || aSt?.[0]?.source !== bSt?.[0]?.source) return false;

  // Per-card state
  if (
    prev.expanded !== next.expanded ||
    prev.refreshing !== next.refreshing ||
    prev.refreshResult !== next.refreshResult ||
    prev.lastFailed !== next.lastFailed ||
    prev.flashStatus !== next.flashStatus ||
    prev.isGuarded !== next.isGuarded ||
    prev.isAutoSchedule !== next.isAutoSchedule ||
    prev.inMaintenance !== next.inMaintenance ||
    prev.maintenanceTooltip !== next.maintenanceTooltip
  ) return false;

  // Shared flags
  if (
    prev.userOnline !== next.userOnline ||
    prev.maintenanceActive !== next.maintenanceActive ||
    prev.voltageEnabled !== next.voltageEnabled ||
    prev.currentEnabled !== next.currentEnabled ||
    prev.virtualize !== next.virtualize ||
    prev.defaultFarmName !== next.defaultFarmName ||
    prev.guardFarmId !== next.guardFarmId
  ) return false;

  // Arrays e callbacks por referência (parent estabiliza via useState/useCallback)
  if (prev.farms !== next.farms || prev.sectors !== next.sectors) return false;
  if (
    prev.onToggle !== next.onToggle ||
    prev.onReset !== next.onReset ||
    prev.onRefresh !== next.onRefresh ||
    prev.onOpenDialog !== next.onOpenDialog ||
    prev.onToggleExpand !== next.onToggleExpand
  ) return false;

  return true;
}

export const PumpCard = memo(PumpCardImpl, areEqual);

// ─────────────────────────────────────────────────────────────────────────────
// FlowInfoPopover — ícone (i) que abre popover com vazão/consumo detalhado.
// Só aparece para equipamentos com vazao_mode !== "off".
// ─────────────────────────────────────────────────────────────────────────────
function FlowInfoPopover({ pump }: { pump: Pump }) {
  const [open, setOpen] = useState(false);

  const instant = pump.vazaoAtualM3h ?? 0;
  const flowTotal = pump.flowTotalM3 ?? 0;
  const consumoMes = pump.consumoMesM3 ?? 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="flex items-center justify-center shrink-0 h-4 w-4 p-0 leading-none text-muted-foreground hover:text-primary transition-colors"
          title="Ver detalhes de vazão e consumo"
          aria-label="Detalhes de vazão e consumo"
        >
          <Info className="w-3 h-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[280px] p-0 text-xs overflow-hidden">
        <div className="flex items-center gap-1.5 px-3 py-2 bg-secondary/70 border-b border-border">
          <Droplets className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-xs font-bold text-foreground truncate">Vazão & Consumo</span>
        </div>
        <div className="p-3 space-y-2">
          <FlowRow
            label="Vazão Instantânea"
            value={instant > 0
              ? `${instant.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} m³/h`
              : "Parada"}
          />
          <FlowRow
            label="Consumo Diário"
            value={`${flowTotal.toLocaleString("pt-BR", { maximumFractionDigits: 0 })} m³`}
            hint="Acumulado desde o último reset (00h)"
          />
          <FlowRow
            label="Consumo Mês"
            value={`${consumoMes.toLocaleString("pt-BR", { maximumFractionDigits: 0 })} m³`}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}


function FlowRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground" title={hint}>{label}</span>
      <span className="font-semibold text-foreground tabular-nums">{value}</span>
    </div>
  );
}
