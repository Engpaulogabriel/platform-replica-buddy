import { useState, useEffect, useRef, useCallback } from "react";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Droplets, Bot, Clock, Calendar, Zap, ZapOff, WifiOff, AlertTriangle, Signal, XCircle, RotateCcw, RefreshCw, CheckCircle2, MapPin, Layers, Tractor, Power, PowerOff } from "lucide-react";
import { notify } from "@/lib/notify";
import { loadFarms, loadSectors, findSectorForEquipment } from "@/lib/sectors";
import { formatLastSeen } from "@/hooks/useDashboardEquipment";
import { useAutomationGuards } from "@/hooks/useAutomationGuards";
import { clearAutomationGuard } from "@/lib/automationGuard";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useDefaultFarm } from "@/hooks/useDefaultFarm";
import { useCloudAutomation } from "@/hooks/useCloudAutomation";
import { useCadastrosCloud } from "@/hooks/useCadastrosCloud";
import { enqueueProtectiveOffOnDisable } from "@/lib/automationProtectiveOff";
import { supabase } from "@/integrations/supabase/client";
import { derivePumpState } from "@/lib/pumpStateMachine";
import { useUserOnline } from "@/contexts/UserOnlineContext";
import { useCurrentFarmMaintenance } from "@/hooks/useCurrentFarmMaintenance";
import { LazyVisible } from "@/components/LazyVisible";
import { PumpCard } from "./PumpCard";
import { useAutomationActiveEquipments } from "@/hooks/useAutomationActiveEquipments";
import { useEquipmentMaintenance, formatMaintenanceStartedAt } from "@/hooks/useEquipmentMaintenance";

export interface PumpCommandLog {
  action: string; // "Ligar remoto", "Desligar remoto", "Ligar local", "Desligar local"
  time: string;
  result: "success" | "fail";
}

export interface PumpStatusLog {
  status: "Ligado" | "Desligado";
  source: "remoto" | "local";
  time: string;
}

export type PumpCommunicationStatus = "online" | "unstable" | "offline";

export interface Pump {
  id: string;
  /** hw_id na nuvem (4 chars hex, ex "1107") — usado para montar frames RS-232. */
  hwId?: string;
  /** Override por equipamento do rádio do Servidor (R1/R2/R3). null/undef = usa global da fazenda. */
  rfRadio?: "R1" | "R2" | "R3" | null;
  /** Override por equipamento de via repetidor. null/undef = usa global da fazenda. */
  rfViaRep?: boolean | null;
  name: string;
  online: boolean;
  communicationStatus?: PumpCommunicationStatus;
  running: boolean;
  pending?: "turning_on" | "turning_off" | "resetting" | "error" | "comm_fail";
  /** timestamp (ms) de quando entrou em pending — usado para timeout de transição. */
  pendingStartedAt?: number;
  /**
   * timestamp (ms) de quando o usuário recebeu confirmação do comando manual.
   * Enquanto a nuvem não publicar uma `last_communication` posterior a este valor,
   * o hook NÃO sobrescreve `running` com o `cloudRunning` (que pode estar atrasado).
   * Evita o bug "liga e desliga sozinho" causado por leituras de polling antigas.
   */
  lastUserConfirmedAt?: number;
  /** Origem da última mudança de estado da bomba: 'remote' (plataforma) ou 'local' (chave física). */
  actuationOrigin?: "remote" | "local" | "whatsapp" | null;
  /** Timestamp ISO em que o operador reconheceu o aviso LOCAL (dismiss via double-click no badge). */
  localAckAt?: string | null;
  /** Bomba bloqueada para novos comandos até este timestamp (acionamento local detectado). */
  commandBlockedUntil?: string | null;
  horimetroMes: string;
  hasFlow: boolean;
  flowRate?: string;
  dailyConsumption?: string;
  /** Modo de vazão/consumo do próprio equipamento (poço/bomba). */
  vazaoMode?: "off" | "estimated" | "real" | null;
  /** Vazão instantânea em m³/h a exibir no card (real=firmware; estimado=cadastrada quando ligada). */
  vazaoAtualM3h?: number;
  /** Consumo acumulado no mês corrente em m³ (soma de daily_consumption). */
  consumoMesM3?: number;
  /** Totalizador absoluto em m³ (equipments.flow_total_m3). */
  flowTotalM3?: number;
  lat?: number;
  lng?: number;
  mode: "manual" | "auto";
  signalRF?: number;
  voltage?: number;
  current?: number;
  lastCommand?: { action: string; time: string; result: "success" | "fail" };
  lastReading?: string;
  /** ISO timestamp da última comunicação RF (vindo de equipments.last_communication) */
  lastCommunication?: string | null;
  commandHistory?: PumpCommandLog[];
  statusHistory?: PumpStatusLog[];
}

// Programações vêm da nuvem (useCloudAutomation). Não usamos mais localStorage aqui.

const weekDays = [
  { key: "seg", label: "Seg" },
  { key: "ter", label: "Ter" },
  { key: "qua", label: "Qua" },
  { key: "qui", label: "Qui" },
  { key: "sex", label: "Sex" },
  { key: "sab", label: "Sáb" },
  { key: "dom", label: "Dom" },
];

interface PumpTableProps {
  pumps: Pump[];
  onToggle: (id: string) => void;
  onReset?: (id: string) => void;
  onModeChange?: (id: string, mode: "manual" | "auto") => void;
  onRefreshStatus?: (id: string) => void;
  flowEnabled: boolean;
  consumptionEnabled: boolean;
  voltageEnabled?: boolean;
  currentEnabled?: boolean;
  hideHeader?: boolean;
}

export function PumpTable({ pumps, onToggle, onReset, onModeChange, onRefreshStatus, voltageEnabled, currentEnabled, hideHeader }: PumpTableProps) {
  const { online: userOnline } = useUserOnline();
  const { active: maintenanceActive } = useCurrentFarmMaintenance();
  const [selectedPump, setSelectedPump] = useState<Pump | null>(null);
  const cloudAutomation = useCloudAutomation();
  const { equipments: cloudEquipments, plcs: cloudPlcs } = useCadastrosCloud();
  const [flashStatus, setFlashStatus] = useState<Record<string, "Ligado" | "Desligado">>({});
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
  const [refreshResult, setRefreshResult] = useState<Record<string, "success" | "fail">>({});
  const [lastFailed, setLastFailed] = useState<Record<string, boolean>>({});
  // IDs de cards expandidos no mobile (<640px). No desktop os cards mostram
  // tudo por padrão; no mobile só nome + dot + switch para reduzir DOM nodes
  // (29 cards × 20 nodes = 580 nodes era o gargalo no iPad). Tocar no card
  // expande os detalhes (sinal RF, refresh, V/A, badges).
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const refreshTimers = useRef<Record<string, NodeJS.Timeout>>({});
  const resultTimers = useRef<Record<string, NodeJS.Timeout>>({});
  const prevPumpsRef = useRef<Pump[]>(pumps);
  const [farms, setFarms] = useState(() => loadFarms());
  const [sectors, setSectors] = useState(() => loadSectors());
  const guardSet = useAutomationGuards();
  const guardFarmId = useDefaultFarmId();
  const { farm: defaultFarmInfo } = useDefaultFarm();

  useEffect(() => {
    const refresh = () => { setFarms(loadFarms()); setSectors(loadSectors()); };
    window.addEventListener("sectors:updated", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("sectors:updated", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const showResult = useCallback((id: string, result: "success" | "fail") => {
    setRefreshResult(prev => ({ ...prev, [id]: result }));
    if (resultTimers.current[id]) clearTimeout(resultTimers.current[id]);
    if (result === "fail") {
      // Falha persiste até próxima atualização (manual ou automática). Sem timer.
      setLastFailed(prev => ({ ...prev, [id]: true }));
    } else {
      setLastFailed(prev => { const next = { ...prev }; delete next[id]; return next; });
      // Sucesso (verde) permanece por 4 minutos a menos que ocorra nova atualização
      resultTimers.current[id] = setTimeout(() => {
        setRefreshResult(prev => { const next = { ...prev }; delete next[id]; return next; });
        delete resultTimers.current[id];
      }, 4 * 60 * 1000);
    }
  }, []);

  const handleRefresh = useCallback((id: string) => {
    if (refreshing[id]) return;
    setRefreshResult(prev => { const next = { ...prev }; delete next[id]; return next; });
    if (resultTimers.current[id]) { clearTimeout(resultTimers.current[id]); delete resultTimers.current[id]; }
    setRefreshing(prev => ({ ...prev, [id]: true }));
    onRefreshStatus?.(id);

    // Timeout de 30s: se a bomba não responder nesse prazo, marca como falha (vermelho)
    // e o ícone vermelho permanece até a próxima atualização (manual ou automática).
    refreshTimers.current[id] = setTimeout(() => {
      setRefreshing(prev => {
        if (prev[id]) {
          const pumpName = pumps.find(p => p.id === id)?.name || id;
          notify.fail("Bombas", `${pumpName}: bomba não respondeu em 30s — status NÃO foi atualizado`);
          const next = { ...prev };
          delete next[id];
          return next;
        }
        return prev;
      });
      showResult(id, "fail");
    }, 30000);
  }, [refreshing, onRefreshStatus, pumps, showResult]);

  // Limpa o estado de falha (vermelho) quando chega QUALQUER leitura automática nova
  // (mudança em lastCommunication sem haver refresh manual em andamento).
  useEffect(() => {
    const prev = prevPumpsRef.current;
    pumps.forEach((newP) => {
      const oldP = prev.find(p => p.id === newP.id);
      if (!oldP || refreshing[newP.id]) return;
      if (oldP.lastCommunication !== newP.lastCommunication && newP.lastCommunication) {
        if (lastFailed[newP.id] || refreshResult[newP.id] === "fail") {
          setLastFailed(p => { const next = { ...p }; delete next[newP.id]; return next; });
          setRefreshResult(p => { const next = { ...p }; delete next[newP.id]; return next; });
        }
      }
    });
  }, [pumps, refreshing, lastFailed, refreshResult]);

  // Detecta resposta REAL da bomba: lastCommunication (vindo de equipments.last_communication
  // via Realtime) muda quando o agente recebe RX e chama apply_pump_telemetry.
  // Não usamos lastReading porque ele pode ser atualizado localmente e geraria sucesso fictício.
  useEffect(() => {
    const prev = prevPumpsRef.current;
    Object.keys(refreshing).forEach(id => {
      if (!refreshing[id]) return;
      const oldP = prev.find(p => p.id === id);
      const newP = pumps.find(p => p.id === id);
      if (oldP && newP && oldP.lastCommunication !== newP.lastCommunication && newP.lastCommunication) {
        clearTimeout(refreshTimers.current[id]);
        delete refreshTimers.current[id];
        setRefreshing(prev => { const next = { ...prev }; delete next[id]; return next; });
        notify.ok("Bombas", `${newP.name}: status atualizado (resposta real da bomba)`);
        showResult(id, "success");
        const statusLabel: "Ligado" | "Desligado" = newP.running ? "Ligado" : "Desligado";
        setFlashStatus(f => ({ ...f, [id]: statusLabel }));
        setTimeout(() => {
          setFlashStatus(f => { const next = { ...f }; delete next[id]; return next; });
        }, 3000);
      }
    });
  }, [pumps, refreshing, showResult]);

  useEffect(() => {
    const prev = prevPumpsRef.current;
    const newFlash: Record<string, "Ligado" | "Desligado"> = {};
    pumps.forEach((p) => {
      const old = prev.find((o) => o.id === p.id);
      if (old && old.pending && !p.pending && old.pending !== "error") {
        newFlash[p.id] = p.running ? "Ligado" : "Desligado";
      }
    });
    if (Object.keys(newFlash).length > 0) {
      setFlashStatus((f) => ({ ...f, ...newFlash }));
      const ids = Object.keys(newFlash);
      setTimeout(() => {
        setFlashStatus((f) => {
          const next = { ...f };
          ids.forEach((id) => delete next[id]);
          return next;
        });
      }, 3000);
    }
    prevPumpsRef.current = pumps;
  }, [pumps]);

  // Programações vêm da nuvem (useCloudAutomation) — Realtime atualiza sozinho.
  const pumpSchedules = selectedPump
    ? cloudAutomation.schedules.filter((s) => s.equipmentId === selectedPump.id)
    : [];

  const toggleSchedule = useCallback(async (scheduleId: string) => {
    const sched = cloudAutomation.schedules.find((s) => s.id === scheduleId);
    if (!sched) return;
    const newState = !sched.active;
    console.log("[MODE_CHANGE] Dashboard schedule toggle clicked. Equipment:", sched.equipmentId, "Schedule:", scheduleId, "New state:", newState);
    try {
      // Se está desativando uma programação ativa, dispara protective OFF para garantir
      // que a bomba seja efetivamente desligada caso esteja em janela.
      if (sched.active && guardFarmId) {
        try {
          const { data: farmRow } = await supabase
            .from("farms").select("timezone").eq("id", guardFarmId).maybeSingle();
          const timezone = farmRow?.timezone || "America/Sao_Paulo";
          await enqueueProtectiveOffOnDisable({
            farmId: guardFarmId,
            timezone,
            schedules: cloudAutomation.schedules,
            equipments: cloudEquipments,
            plcs: cloudPlcs,
            holidayConfigs: cloudAutomation.holidayConfigs,
            scheduleIdScope: scheduleId,
          });
        } catch (e) {
          console.error("[PumpTable] protective off failed", e);
        }
      }
      await cloudAutomation.toggleSchedule(scheduleId);
      console.log("[MODE_CHANGE] Dashboard schedule toggle finished. Equipment:", sched.equipmentId, "Schedule:", scheduleId, "New state:", newState);
      notify.ok("Bombas", sched.active ? "Programação desativada" : "Programação ativada");
    } catch (e) {
      console.error("[MODE_CHANGE] Dashboard schedule toggle failed. Equipment:", sched.equipmentId, "Schedule:", scheduleId, "New state:", newState, e);
      notify.fail("Bombas", e instanceof Error ? e.message : String(e));
    }
  }, [cloudAutomation, cloudEquipments, cloudPlcs, guardFarmId]);

  const setAllSchedules = useCallback(async (active: boolean) => {
    if (!selectedPump) return;
    const targets = cloudAutomation.schedules.filter(
      (s) => s.equipmentId === selectedPump.id && s.active !== active
    );
    if (targets.length === 0) {
      notify.tip("Bombas", active ? "Todas já estão ativas" : "Todas já estão desativadas");
      return;
    }
    try {
      for (const s of targets) {
        console.log("[MODE_CHANGE] Dashboard bulk schedule toggle clicked. Equipment:", s.equipmentId, "Schedule:", s.id, "New state:", active);
        await cloudAutomation.updateSchedule(s.id, { active });
      }
      console.log("[MODE_CHANGE] Dashboard bulk schedule toggle finished. Equipment:", selectedPump.id, "New state:", active, "Count:", targets.length);
      notify.ok("Bombas", `${targets.length} ${targets.length === 1 ? "programação" : "programações"} ${active ? "ativadas" : "desativadas"}`);
    } catch (e) {
      console.error("[MODE_CHANGE] Dashboard bulk schedule toggle failed. Equipment:", selectedPump.id, "New state:", active, e);
      notify.fail("Bombas", e instanceof Error ? e.message : String(e));
    }
  }, [selectedPump, cloudAutomation]);

  // Callback estável: toggle de expansão por id (chamado pelo PumpCard).
  const toggleExpand = useCallback((id: string) => {
    if (typeof window !== "undefined" && window.innerWidth >= 1024) return;
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const virtualize = pumps.length > 8;
  const autoActiveSet = useAutomationActiveEquipments();
  const { rows: maintRows } = useEquipmentMaintenance();
  const maintMap = new Map(maintRows.map((r) => [r.id, r]));



  return (
    <>
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-1.5 p-2">
          {pumps.map((pump) => {
            const mRow = maintMap.get(pump.id);
            const inMaint = !!mRow?.maintenance_mode;
            const maintTip = inMaint
              ? `Em manutenção desde ${formatMaintenanceStartedAt(mRow?.maintenance_started_at)}${mRow?.maintenance_reason ? ` — ${mRow.maintenance_reason}` : ""}`
              : undefined;
            return (
              <PumpCard
                key={pump.id}
                pump={pump}
                expanded={expandedIds.has(pump.id)}
                refreshing={!!refreshing[pump.id]}
                refreshResult={refreshResult[pump.id]}
                lastFailed={!!lastFailed[pump.id]}
                flashStatus={flashStatus[pump.id]}
                isGuarded={guardSet.has(pump.id)}
                isAutoSchedule={autoActiveSet.has(pump.id)}
                inMaintenance={inMaint}
                maintenanceTooltip={maintTip}
                userOnline={userOnline}
                maintenanceActive={maintenanceActive}
                voltageEnabled={voltageEnabled}
                currentEnabled={currentEnabled}
                farms={farms}
                sectors={sectors}
                defaultFarmName={defaultFarmInfo?.name ?? null}
                guardFarmId={guardFarmId}
                virtualize={virtualize}
                onToggle={onToggle}
                onReset={onReset}
                onRefresh={handleRefresh}
                onOpenDialog={setSelectedPump}
                onToggleExpand={toggleExpand}
              />
            );
          })}
        </div>
      </div>


      {/* Dialog de programações do poço */}
      <Dialog open={!!selectedPump} onOpenChange={(open) => !open && setSelectedPump(null)}>
        <DialogContent className="sm:max-w-lg p-0 overflow-hidden">
          {selectedPump && (() => {
            const total = pumpSchedules.length;
            const activeCount = pumpSchedules.filter((s) => s.active).length;
            const allActive = total > 0 && activeCount === total;
            const noneActive = activeCount === 0;

            const renderRow = (schedule: typeof pumpSchedules[number]) => {
              const isOn = schedule.mode === "on-only";
              const time = isOn ? schedule.timeOn : schedule.timeOff;
              return (
                <div
                  key={schedule.id}
                  onClick={() => toggleSchedule(schedule.id)}
                  className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 cursor-pointer transition-all ${
                    schedule.active
                      ? isOn
                        ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
                        : "border-destructive/40 bg-destructive/5 hover:bg-destructive/10"
                      : "border-border bg-muted/20 hover:bg-muted/40 opacity-60"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {isOn ? (
                      <Power className={`w-4 h-4 shrink-0 ${schedule.active ? "text-primary" : "text-muted-foreground"}`} />
                    ) : (
                      <PowerOff className={`w-4 h-4 shrink-0 ${schedule.active ? "text-destructive" : "text-muted-foreground"}`} />
                    )}
                    <span className="text-sm font-bold text-foreground tabular-nums">{time}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                      isOn ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive"
                    }`}>
                      {isOn ? "Ligar" : "Desligar"}
                    </span>
                  </div>
                  <Switch
                    checked={schedule.active}
                    onClick={(e) => e.stopPropagation()}
                    onCheckedChange={() => toggleSchedule(schedule.id)}
                    className="data-[state=checked]:bg-primary scale-90"
                  />
                </div>
              );
            };

            // Agrupa programações por dia da semana, ordenadas por horário
            const allSorted = [...pumpSchedules].sort((a, b) => {
              const ta = a.mode === "on-only" ? a.timeOn : a.timeOff;
              const tb = b.mode === "on-only" ? b.timeOn : b.timeOff;
              return (ta || "").localeCompare(tb || "");
            });
            const byDay: Record<string, typeof pumpSchedules> = {};
            for (const day of weekDays) byDay[day.key] = [];
            for (const s of allSorted) {
              for (const d of s.days) {
                if (byDay[d]) byDay[d].push(s);
              }
            }

            return (
              <>
                {/* Header com resumo */}
                <DialogHeader className="px-4 pt-4 pb-3 border-b border-border bg-secondary/30">
                  <DialogTitle className="flex items-center gap-2 text-foreground text-sm">
                    <Calendar className="w-4 h-4 text-primary" />
                    <span className="truncate">Programações — {selectedPump.name}</span>
                  </DialogTitle>
                  <div className="flex items-center justify-between gap-2 mt-2">
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold ${
                        activeCount > 0 ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                      }`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-current" />
                        {activeCount}/{total} ativas
                      </span>
                      {selectedPump.mode !== "auto" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning font-semibold">
                          Modo Manual
                        </span>
                      )}
                    </div>
                    {total > 0 && (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[10px] gap-1"
                          disabled={allActive}
                          onClick={() => setAllSchedules(true)}
                        >
                          <Power className="w-3 h-3" />
                          Ativar todas
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[10px] gap-1"
                          disabled={noneActive}
                          onClick={() => setAllSchedules(false)}
                        >
                          <PowerOff className="w-3 h-3" />
                          Desativar
                        </Button>
                      </div>
                    )}
                  </div>
                </DialogHeader>

                <div className="px-4 py-3 max-h-[60vh] overflow-y-auto">
                  {selectedPump.mode !== "auto" && total > 0 && (
                    <p className="text-[11px] text-muted-foreground bg-warning/10 border border-warning/20 rounded-md p-2 mb-3">
                      Para que as programações funcionem, mude o poço para o modo <strong>Automático</strong> no card.
                    </p>
                  )}

                  {total === 0 ? (
                    <div className="py-8 text-center">
                      <Calendar className="w-8 h-8 mx-auto text-muted-foreground/40 mb-2" />
                      <p className="text-sm text-muted-foreground">Nenhuma programação cadastrada.</p>
                      <p className="text-[11px] text-muted-foreground/70 mt-1">Acesse a página <strong>Automático</strong> para criar.</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {(() => {
                        const dayFullNames: Record<string, string> = {
                          seg: "Segunda-feira", ter: "Terça-feira", qua: "Quarta-feira",
                          qui: "Quinta-feira", sex: "Sexta-feira", sab: "Sábado", dom: "Domingo",
                        };
                        const todayMap = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
                        const todayKey = todayMap[new Date().getDay()];
                        return weekDays.map((day) => {
                          const items = byDay[day.key] || [];
                          if (items.length === 0) return null;
                          const isToday = day.key === todayKey;
                          const dayActive = items.filter((s) => s.active).length;
                          return (
                            <div
                              key={day.key}
                              className={`rounded-lg border ${
                                isToday ? "border-primary/50 bg-primary/[0.03]" : "border-border bg-card"
                              }`}
                            >
                              <div className={`flex items-center justify-between px-3 py-1.5 border-b ${
                                isToday ? "border-primary/30 bg-primary/10" : "border-border bg-secondary/40"
                              }`}>
                                <div className="flex items-center gap-2">
                                  <span className={`text-xs font-bold ${isToday ? "text-primary" : "text-foreground"}`}>
                                    {dayFullNames[day.key]}
                                  </span>
                                  {isToday && (
                                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground font-bold uppercase tracking-wide">
                                      Hoje
                                    </span>
                                  )}
                                </div>
                                <span className="text-[10px] text-muted-foreground font-semibold">
                                  {dayActive}/{items.length} ativas
                                </span>
                              </div>
                              <div className="p-2 space-y-1.5">
                                {items.map(renderRow)}
                              </div>
                            </div>
                          );
                        });
                      })()}
                      <p className="text-[10px] text-muted-foreground/70 text-center pt-1">
                        Toque na linha ou no interruptor para ativar/desativar.
                      </p>
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </>
  );
}
