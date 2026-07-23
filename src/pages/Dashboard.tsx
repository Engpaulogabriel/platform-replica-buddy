import { Card, CardContent } from "@/components/ui/card";
import {
  Droplets, WifiOff, AlertTriangle, Gauge,
  Wifi, MapPin, LayoutList, Info, Settings2, ArrowUp, ArrowDown, ChevronsUp, ChevronsDown, GripVertical,
  Activity, ChevronDown, ChevronUp, Building2, Layers, Server, GitBranch, LayoutDashboard, SlidersHorizontal, Check, Plane
} from "lucide-react";
import { useGuidedTour } from "@/hooks/useGuidedTour";

import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PumpTable, type Pump } from "@/components/dashboard/PumpTable";
import { ReservoirGauges, type Reservoir } from "@/components/dashboard/ReservoirGauges";
import { PumpDetails } from "@/components/dashboard/PumpDetails";
// Leaflet é ~150 KB — só carrega quando a aba "Mapa" é aberta.
const PumpMap = lazy(() => import("@/components/dashboard/PumpMap"));
import { MapErrorBoundary } from "@/components/dashboard/MapErrorBoundary";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { notify } from "@/lib/notify";
import { notifyCommand } from "@/lib/notify";
import { confirmAction } from "@/lib/confirmDialog";
import { loadFarms, loadSectors, loadPlcGroups, groupEquipmentByFarm } from "@/lib/sectors";
import { logEvent } from "@/lib/automationLog";
import { useAuth } from "@/contexts/AuthContext";
import { useDefaultFarm } from "@/hooks/useDefaultFarm";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Diagrama hidráulico só carrega quando a aba "Diagrama" é aberta.
const WaterFlowDiagram = lazy(() => import("@/components/dashboard/WaterFlowDiagram"));
import { useDashboardEquipment } from "@/hooks/useDashboardEquipment";
import { BridgeStatusCard } from "@/components/dashboard/BridgeStatusCard";
import { WaterBalanceCard } from "@/components/dashboard/WaterBalanceCard";
import { IndicatorsMiniSummary } from "@/components/dashboard/IndicatorsMiniSummary";
import { useRfMeasurement } from "@/hooks/useRfMeasurement";
import { barsToPercent } from "@/lib/rfSignal";
import { buildEquipmentFrame } from "@/lib/rfRouting";
import { enqueueManualPumpCommand, enqueueManualStatusRead, enqueueResetPumpCommand, enqueueManualLevelRead } from "@/lib/commandQueue";
import { waitForCommand } from "@/hooks/useCommandTracker";
import { useAutomationActiveEquipments } from "@/hooks/useAutomationActiveEquipments";
import { useFarmFeatures } from "@/hooks/useFarmFeatures";
import { triggerAutomationGuard, wasScheduledOffRecently } from "@/lib/automationGuard";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useFarmAccess } from "@/hooks/useFarmAccess";
import { useMasterManager } from "@/contexts/MasterManagerContext";
import { useNavigate } from "react-router-dom";



const getStatsFromData = (pumps: Pump[], reservoirCount: number, t: ReturnType<typeof import("@/contexts/LanguageContext").useLanguage>["t"]) => {
  const totalBombas = pumps.length;
  const bombasOnline = pumps.filter((p) => p.communicationStatus === "online").length;
  const bombasInstaveis = pumps.filter((p) => p.communicationStatus === "unstable").length;
  const bombasOffline = pumps.filter((p) => p.communicationStatus === "offline").length;
  const bombasLigadas = pumps.filter((p) => p.communicationStatus !== "offline" && p.running).length;
  const bombasDesligadas = pumps.filter((p) => p.communicationStatus !== "offline" && !p.running).length;

  return {
    operational: [
      { title: "Ligadas", value: String(bombasLigadas), icon: Droplets, color: "text-primary" },
      { title: "Desligadas", value: String(bombasDesligadas), icon: Droplets, color: "text-warning" },
      { title: t.offline, value: String(bombasOffline), icon: WifiOff, color: "text-destructive" },
      { title: "Online", value: String(bombasOnline), icon: Wifi, color: "text-primary" },
    ],
    equipment: [
      { title: "Bombas", value: String(totalBombas), icon: Gauge, color: "text-info", desc: "Poços + Bombeamento" },
      { title: t.levels, value: String(reservoirCount), icon: Activity, color: "text-accent", desc: "Sensores de nível" },
    ],
  };
};

const now = () => { const d = new Date(); return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getFullYear()).slice(-2)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`; };

type SectionKey = "pumps" | "reservoirs";

interface LayoutConfig {
  order: SectionKey[];
  pumpOrder: string[];
  reservoirOrder: string[];
  farmOrder: string[];                       // ordem das fazendas
  sectorOrder: Record<string, string[]>;     // farmId → ordem dos setores
}

function getDefaultLayout(pumps: Pump[], reservoirs: Reservoir[]): LayoutConfig {
  return {
    order: ["pumps", "reservoirs"],
    pumpOrder: pumps.map(p => p.id),
    reservoirOrder: reservoirs.map(r => r.id),
    farmOrder: [],
    sectorOrder: {},
  };
}

/**
 * Carrega o layout salvo. Migra layouts antigos (number[]) para UUIDs (string[])
 * usando `cloud_id_map_v1` (mapa numericId → cloudUuid criado pela bridge da
 * Mensagem 1). IDs que não tiverem correspondente são descartados.
 */
function loadLayout(pumps: Pump[], reservoirs: Reservoir[]): LayoutConfig {
  try {
    const saved = localStorage.getItem("dashboard_layout");
    if (!saved) return getDefaultLayout(pumps, reservoirs);
    const parsed = JSON.parse(saved) as {
      order?: SectionKey[];
      pumpOrder?: Array<string | number>;
      reservoirOrder?: Array<string | number>;
    };

    const idMap = (() => {
      try {
        const raw = localStorage.getItem("cloud_id_map_v1");
        return raw ? (JSON.parse(raw) as Record<string, string>) : {};
      } catch { return {} as Record<string, string>; }
    })();

    const migrate = (arr: Array<string | number> | undefined): string[] => {
      if (!arr) return [];
      return arr
        .map((v) => typeof v === "string" ? v : (idMap[String(v)] ?? null))
        .filter((v): v is string => !!v);
    };

    return {
      order: parsed.order ?? ["pumps", "reservoirs"],
      pumpOrder: migrate(parsed.pumpOrder),
      reservoirOrder: migrate(parsed.reservoirOrder),
      farmOrder: Array.isArray((parsed as any).farmOrder) ? (parsed as any).farmOrder.filter((v: any) => typeof v === "string") : [],
      sectorOrder: (parsed as any).sectorOrder && typeof (parsed as any).sectorOrder === "object" ? (parsed as any).sectorOrder : {},
    };
  } catch {
    return getDefaultLayout(pumps, reservoirs);
  }
}

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const result = [...arr];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

const Dashboard = () => {
  const { t } = useLanguage();
  const { startMainTour } = useGuidedTour();
  const { user } = useAuth();
  const farmId = useDefaultFarmId();
  const { role: farmRole, isPlatformAdmin: isFarmPlatformAdmin } = useFarmAccess();
  const canViewIndicators = farmRole === "owner" || isFarmPlatformAdmin;
  const { isMasterManager, permissions } = useMasterManager();
  const navigate = useNavigate();
  useEffect(() => {
    if (isMasterManager && !permissions.can_view_dashboard) {
      // primeiro fallback: relatórios; senão manutenção
      if (permissions.can_view_reports) navigate("/relatorios", { replace: true });
      else navigate("/manutencao", { replace: true });
    }
  }, [isMasterManager, permissions, navigate]);

  const [profileName, setProfileName] = useState<string | null>(null);
  useEffect(() => {
    if (!user?.id) { setProfileName(null); return; }
    let cancelled = false;
    supabase
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setProfileName(data?.full_name ?? null);
      });
    return () => { cancelled = true; };
  }, [user?.id]);
  const userEmail = profileName ?? user?.user_metadata?.full_name ?? user?.email ?? "Sistema";

  // Fonte única: cadastros da nuvem + telemetria simulada
  const { pumps, reservoirs: allReservoirs, setPumps, setReservoirs, loading, cloudEquipments } = useDashboardEquipment();
  const farmFeatures = useFarmFeatures();
  // Quando o módulo de Níveis está desativado para a fazenda, oculta
  // completamente os reservatórios do dashboard (stats, listas, ordem, etc.).
  const reservoirs = farmFeatures.niveis ? allReservoirs : [];
  const { measure: measureRf, bridgePresent } = useRfMeasurement();
  const automationActiveSet = useAutomationActiveEquipments();

  // Mantém o flag `mode` das bombas em sincronia com as programações ativas
  // da aba Automático. Quando há programação ativa para o equipamento, o
  // modo vira "auto" (mostra badge AUTO no card e desabilita switch manual).
  useEffect(() => {
    setPumps((prev) => {
      let changed = false;
      const next = prev.map((p) => {
        const desired: "auto" | "manual" = automationActiveSet.has(p.id) ? "auto" : "manual";
        if (p.mode === desired) return p;
        changed = true;
        return { ...p, mode: desired };
      });
      return changed ? next : prev;
    });
  }, [automationActiveSet, setPumps]);

  // Notificações informativas do automático: quando o motor de automação
  // liga ou desliga uma bomba (origem remota/scheduler) enquanto ela está
  // em modo automático, mostra um toast informativo discreto. Nenhuma
  // ação corretiva é tomada — apenas log visual para o operador.
  const prevRunningRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    const prev = prevRunningRef.current;
    pumps.forEach((p) => {
      const wasRunning = prev.get(p.id);
      const inAuto = automationActiveSet.has(p.id);
      const isRemote = p.actuationOrigin !== "local";
      if (
        wasRunning !== undefined &&
        wasRunning !== p.running &&
        inAuto &&
        isRemote &&
        !p.pending &&
        p.communicationStatus !== "offline"
      ) {
        const hhmm = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        const msg = p.running
          ? `${p.name}: ligado pelo automático às ${hhmm}`
          : `${p.name}: desligado pelo automático às ${hhmm}`;
        toast.info(msg, { duration: 5000 });
      }
      prev.set(p.id, p.running);
    });
  }, [pumps, automationActiveSet]);



  const [flowEnabled, setFlowEnabled] = useState(false);
  const [consumptionEnabled, setConsumptionEnabled] = useState(false);
  const [voltageEnabled, setVoltageEnabled] = useState(false);
  const [currentEnabled, setCurrentEnabled] = useState(false);
  const [view, setView] = useState<"list" | "details" | "map" | "diagrama">("list");
  const [statsExpanded, setStatsExpanded] = useState(false);
  const [layout, setLayout] = useState<LayoutConfig>({ order: ["pumps", "reservoirs"], pumpOrder: [], reservoirOrder: [], farmOrder: [], sectorOrder: {} });
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);

  // Inicializa o layout assim que houver dados (uma vez) — primeiro do localStorage,
  // depois sobrescreve com o layout salvo na nuvem (compartilhado entre dispositivos).
  useEffect(() => {
    if (layoutLoaded) return;
    if (pumps.length === 0 && reservoirs.length === 0) return;
    setLayout(loadLayout(pumps, reservoirs));
    setLayoutLoaded(true);
  }, [pumps, reservoirs, layoutLoaded]);

  // Cloud sync: busca layout da fazenda e escuta realtime para refletir
  // mudanças feitas em outros dispositivos (desktop ↔ celular).
  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("dashboard_layouts")
        .select("layout")
        .eq("farm_id", farmId)
        .maybeSingle();
      if (cancelled || !data?.layout) return;
      const cloud = data.layout as Partial<LayoutConfig>;
      setLayout((prev) => ({
        order: cloud.order ?? prev.order ?? ["pumps", "reservoirs"],
        pumpOrder: cloud.pumpOrder ?? prev.pumpOrder ?? [],
        reservoirOrder: cloud.reservoirOrder ?? prev.reservoirOrder ?? [],
        farmOrder: cloud.farmOrder ?? prev.farmOrder ?? [],
        sectorOrder: cloud.sectorOrder ?? prev.sectorOrder ?? {},
      }));
      try { localStorage.setItem("dashboard_layout", JSON.stringify(cloud)); } catch {}
    })();
    const channel = supabase
      .channel(`dashboard_layouts:${farmId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "dashboard_layouts", filter: `farm_id=eq.${farmId}` },
        (payload) => {
          const next = (payload.new as any)?.layout as Partial<LayoutConfig> | undefined;
          if (!next) return;
          setLayout((prev) => ({
            order: next.order ?? prev.order,
            pumpOrder: next.pumpOrder ?? prev.pumpOrder,
            reservoirOrder: next.reservoirOrder ?? prev.reservoirOrder,
            farmOrder: next.farmOrder ?? prev.farmOrder,
            sectorOrder: next.sectorOrder ?? prev.sectorOrder,
          }));
        },
      )
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(channel); };
  }, [farmId]);

  // Farms / Sectors / PLC groups for visual grouping in dashboard
  const [farms, setFarms] = useState(() => loadFarms());
  const [sectors, setSectors] = useState(() => loadSectors());
  const [plcGroups, setPlcGroups] = useState(() => loadPlcGroups());
  const { farm: defaultFarm } = useDefaultFarm();

  useEffect(() => {
    const sync = () => {
      setFarms(loadFarms());
      setSectors(loadSectors());
      setPlcGroups(loadPlcGroups());
    };
    window.addEventListener("storage", sync);
    window.addEventListener("sectors:updated", sync as EventListener);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("sectors:updated", sync as EventListener);
    };
  }, []);

  // Voltage/current continuam como preferências locais (só UI); vazão/consumo
  // segue farms.modules.vazao_consumo (farm-wide) via farmFeatures.
  useEffect(() => {
    const syncModules = () => {
      const voltage = localStorage.getItem("module_voltage");
      const current = localStorage.getItem("module_current");
      setVoltageEnabled(voltage === "true");
      setCurrentEnabled(current === "true");
    };
    syncModules();
    window.addEventListener("modules:updated", syncModules);
    window.addEventListener("storage", syncModules);
    return () => {
      window.removeEventListener("modules:updated", syncModules);
      window.removeEventListener("storage", syncModules);
    };
  }, []);

  // Ativa/desativa vazão e consumo com base no módulo da fazenda
  useEffect(() => {
    setFlowEnabled(farmFeatures.vazao_consumo);
    setConsumptionEnabled(farmFeatures.vazao_consumo);
  }, [farmFeatures.vazao_consumo]);

  const saveLayout = useCallback((newLayout: LayoutConfig) => {
    setLayout(newLayout);
    localStorage.setItem("dashboard_layout", JSON.stringify(newLayout));
    if (farmId) {
      void supabase
        .from("dashboard_layouts")
        .upsert(
          { farm_id: farmId, layout: newLayout as any, updated_by: user?.id ?? null, updated_at: new Date().toISOString() },
          { onConflict: "farm_id" },
        );
    }
  }, [farmId, user?.id]);

  const toggleSectionOrder = () => {
    const newOrder = [...layout.order].reverse() as SectionKey[];
    saveLayout({ ...layout, order: newOrder });
  };

  /** Garante que todas as bombas existam em pumpOrder antes de mover. */
  const ensureFullOrder = (current: string[]): string[] => {
    const set = new Set(current);
    const missing = pumps.map(p => p.id).filter(id => !set.has(id));
    return missing.length === 0 ? current : [...current, ...missing];
  };

  const movePump = (index: number, direction: -1 | 1) => {
    const full = ensureFullOrder(layout.pumpOrder);
    const newIndex = index + direction;
    if (index < 0 || index >= full.length) return;
    if (newIndex < 0 || newIndex >= full.length) return;
    saveLayout({ ...layout, pumpOrder: moveItem(full, index, newIndex) });
  };
  const movePumpTo = (index: number, where: "top" | "bottom") => {
    const full = ensureFullOrder(layout.pumpOrder);
    const target = where === "top" ? 0 : full.length - 1;
    if (index < 0 || index >= full.length || index === target) return;
    saveLayout({ ...layout, pumpOrder: moveItem(full, index, target) });
  };

  /**
   * Move uma bomba dentro do seu setor: troca a posição global da bomba com
   * a posição global da bomba vizinha (anterior/próxima) DO MESMO setor.
   * Isso evita que o ↑/↓ "pule" sobre bombas de outros setores e a posição
   * visual dentro do setor não mude.
   */
  const movePumpWithinSector = (
    sectorPumpIds: string[],
    sectorIndex: number,
    direction: -1 | 1 | "top" | "bottom",
  ) => {
    const full = ensureFullOrder(layout.pumpOrder);
    const pumpId = sectorPumpIds[sectorIndex];
    if (!pumpId) return;
    const targetSectorIdx =
      direction === "top" ? 0
      : direction === "bottom" ? sectorPumpIds.length - 1
      : sectorIndex + direction;
    if (targetSectorIdx < 0 || targetSectorIdx >= sectorPumpIds.length || targetSectorIdx === sectorIndex) return;

    const fromGlobal = full.indexOf(pumpId);
    const targetPumpId = sectorPumpIds[targetSectorIdx];
    const targetGlobal = full.indexOf(targetPumpId);
    if (fromGlobal < 0 || targetGlobal < 0) return;

    const next = [...full];
    next[fromGlobal] = targetPumpId;
    next[targetGlobal] = pumpId;
    saveLayout({ ...layout, pumpOrder: next });
  };

  const moveReservoir = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= layout.reservoirOrder.length) return;
    saveLayout({ ...layout, reservoirOrder: moveItem(layout.reservoirOrder, index, newIndex) });
  };
  const moveReservoirTo = (index: number, where: "top" | "bottom") => {
    const target = where === "top" ? 0 : layout.reservoirOrder.length - 1;
    if (index === target) return;
    saveLayout({ ...layout, reservoirOrder: moveItem(layout.reservoirOrder, index, target) });
  };

  const moveFarm = (farmList: string[], index: number, direction: -1 | 1 | "top" | "bottom") => {
    const target = direction === "top" ? 0
      : direction === "bottom" ? farmList.length - 1
      : index + direction;
    if (target < 0 || target >= farmList.length || target === index) return;
    saveLayout({ ...layout, farmOrder: moveItem(farmList, index, target) });
  };

  const moveSector = (farmId: string, sectorList: string[], index: number, direction: -1 | 1 | "top" | "bottom") => {
    const target = direction === "top" ? 0
      : direction === "bottom" ? sectorList.length - 1
      : index + direction;
    if (target < 0 || target >= sectorList.length || target === index) return;
    const next = moveItem(sectorList, index, target);
    saveLayout({ ...layout, sectorOrder: { ...layout.sectorOrder, [farmId]: next } });
  };

  const sortedPumps = layout.pumpOrder
    .map(id => pumps.find(p => p.id === id))
    .filter(Boolean) as Pump[];
  const missingPumps = pumps.filter(p => !layout.pumpOrder.includes(p.id));
  const orderedPumps = [...sortedPumps, ...missingPumps];
  // PERFORMANCE: memoiza o array passado ao WaterBalanceCard. Sem isso, um
  // novo array é criado a cada render do Dashboard (várias vezes por segundo),
  // o que invalida o useMemo interno e força re-render do card.
  const waterBalancePumpStats = useMemo(
    () => pumps.map((p) => ({
      id: p.id,
      running: !!p.running,
      offline: p.communicationStatus === "offline",
    })),
    [pumps],
  );

  const sortedReservoirs = layout.reservoirOrder
    .map(id => reservoirs.find(r => r.id === id))
    .filter(Boolean) as Reservoir[];
  const missingRes = reservoirs.filter(r => !layout.reservoirOrder.includes(r.id));
  const orderedReservoirs = [...sortedReservoirs, ...missingRes];

  const togglePump = async (id: string) => {
    const target = pumps.find((p) => p.id === id);
    if (!target) return;
    // BLOQUEIO MODO AUTOMÁTICO: comando manual de ligar/desligar fica bloqueado
    // enquanto a bomba estiver em modo "auto" (engine + ao menos 1 schedule ativo).
    // Só desbloqueia quando o automático for desativado na aba Automático.
    if (target.mode === "auto") {
      notifyCommand.blocked(target.name, "desative o Modo Automático para controlar manualmente");
      return;
    }
    if (target.pending === "error" || target.pending === "comm_fail") {
      // Limpa o estado de falha e segue para reenviar o comando.
      setPumps((prev) => prev.map((p) => (p.id === id ? { ...p, pending: undefined } : p)));
      // Não return — continua o fluxo abaixo para enviar nova tentativa.
    } else {
      // Se estiver "Ligando..." e o operador desligar, isso vira um corte imediato
      // do relé com comando 0 (mesmo fluxo do Reset).
      if (target.pending === "turning_on") {
        resetPump(id);
        return;
      }
      // ANTI-SPAM (spec Manus): ignora clique se há comando em andamento
      // (turning_off ou resetting). turning_on já foi tratado acima.
      if (target.pending === "turning_off" || target.pending === "resetting") {
        notifyCommand.blocked(target.name, "aguarde — comando em andamento");
        return;
      }
    }
    // BLOQUEIO 30s após detecção de acionamento local
    if (target.commandBlockedUntil) {
      const until = new Date(target.commandBlockedUntil).getTime();
      if (until > Date.now()) {
        const sec = Math.ceil((until - Date.now()) / 1000);
        notifyCommand.blocked(target.name, `bloqueado por ${sec}s — acionamento local detectado`);
        return;
      }
    }
    const effectiveRunning = (target.pending as string) === "resetting" ? false : target.running;
    const willTurnOn = !effectiveRunning;

    // Confirmação obrigatória do operador antes de comandar a bomba.
    const ok = await confirmAction({
      title: willTurnOn ? `Deseja ligar ${target.name}?` : `Deseja desligar ${target.name}?`,
      confirmLabel: willTurnOn ? "Ligar" : "Desligar",
      variant: willTurnOn ? "default" : "destructive",
    });
    if (!ok) return;

    notifyCommand.sent(target.name, willTurnOn ? "ligar" : "desligar");
    const pendingState: "turning_on" | "turning_off" = willTurnOn ? "turning_on" : "turning_off";
    const command = willTurnOn ? "turn_on" : "turn_off";

    setPumps((prev) => prev.map((p) => (p.id === id ? { ...p, pending: pendingState, pendingStartedAt: Date.now() } : p)));

    // Se o equipamento tem hwId (vem da nuvem), usa fila real (Etapa 3).
    // Caso contrário cai no modo simulado antigo (preview sem cadastros).
    const useQueue = !!target.hwId;

    if (useQueue) {
      void (async () => {
        try {
          const enq = await enqueueManualPumpCommand({
            equipmentId: target.id,
            turnOn: willTurnOn,
            userId: user?.id ?? null,
            userName: userEmail,
          });
          

          // Janela única de obediência física: NÃO encerra "Ligando/Desligando"
          // só porque a bomba respondeu o estado antigo (0 ao ligar / 1 ao desligar).
          // O comando só finaliza antes de 120s se a telemetria confirmar o estado esperado
          // ou se o agente retornar erro real.
          const result = await waitForCommand(enq.commandId, 140_000);
          const succeeded = result.status === "executed";
          const isCommFail = !succeeded && (result.status === "timeout" || result.status === "unknown");

          setPumps((prev) =>
            prev.map((p) => {
              if (p.id !== id) return p;
              if (p.pending !== pendingState) return p;
              if (isCommFail) {
                // Falha após a janela completa de 120s: libera botões para nova tentativa.
                return { ...p, pending: "comm_fail" as const };
              }
              if (!succeeded) {
                return { ...p, pending: "error" as const };
              }
              return {
                ...p,
                // ACK do agente NÃO é confirmação física da bomba. Mantém
                // "Ligando…"/"Desligando…" (VERIFYING) até a telemetria real
                // (RX da bomba com payload correspondente) atualizar
                // last_outputs_state.
                running: p.running,
                pending: pendingState,
                pendingStartedAt: p.pendingStartedAt ?? Date.now(),
              };
            }),
          );

          // Só registra no log de automação quando há resultado DEFINITIVO:
          //   • succeeded → success
          //   • status === 'error' → fail (rejeição real do agente/bridge)
          // NUNCA registra fail em timeout/unknown (8s) — isso é apenas falha de
          // comunicação visual; a janela de 120s da telemetria + o motor da nuvem
          // (`mark_automation_command_failures`) decidem se houve falha real de
          // obediência da bomba e gravam o log no momento certo.
          // SUCESSO já é gravado pelo trigger SQL `trg_log_manual_command`
          // usando `commands.created_by` (usuário REAL que comandou).
          // Aqui só logamos FALHA (status=error), que o trigger não cobre.
          if (result.status === "error") {
            logEvent({
              equipmentId: target.id,
              pump: target.name,
              action: willTurnOn ? "Ligada" : "Desligada",
              origin: target.mode === "auto" ? "Automático" : "Remoto",
              user: target.mode === "auto" ? "Sistema" : userEmail,
              result: "fail",
            });
          }

          if (succeeded) {
            if (willTurnOn) notifyCommand.turnedOn(target.name);
            else notifyCommand.turnedOff(target.name);
          } else if (isCommFail) {
            notifyCommand.safetyExpired(target.name);
          } else if (result.status === "error") {
            notifyCommand.error(target.name, result.errorMessage ?? "falha no envio");
          } else {
            notifyCommand.notConfirmed(target.name);
          }
        } catch (e: any) {
          setPumps((prev) => prev.map((p) => (p.id === id ? { ...p, pending: "error" as const } : p)));
          notifyCommand.error(target.name, e?.message ?? "falha ao enfileirar comando");
        }
      })();
      return;
    }

    // Fallback simulado (preview sem cadastros / sem hwId)
    const frame = buildEquipmentFrame({
      hwId: target.hwId,
      command,
      radioOverride: target.rfRadio ?? null,
      viaRepetidorOverride: target.rfViaRep ?? null,
    }) ?? undefined;
    void measureRf({
      equipmentId: target.id,
      equipmentName: target.name,
      command,
      frame,
      expectedHwId: target.hwId,
    }).then((rfResult) => {
      const succeeded = !rfResult.timedOut;
      setPumps((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p;
          if (!succeeded) {
            return {
              ...p,
              pending: "error" as const,
              signalRF: 0,
              online: false,
            };
          }
          return {
            ...p,
            running: willTurnOn,
            pending: undefined,
            signalRF: barsToPercent(rfResult.bars),
            online: rfResult.bars > 0,
            lastReading: now(),
            lastCommunication: new Date().toISOString(),
          };
        }),
      );

      // Sucesso é registrado pelo trigger SQL com user REAL. Aqui só falha.
      if (!succeeded) {
        logEvent({
          equipmentId: target.id,
          pump: target.name,
          action: willTurnOn ? "Ligada" : "Desligada",
          origin: target.mode === "auto" ? "Automático" : "Remoto",
          user: target.mode === "auto" ? "Sistema" : userEmail,
          result: "fail",
        });
      }

      if (!succeeded) {
        notify.fail("Dashboard", `${target.name}: sem resposta em ${(rfResult.latencyMs / 1000).toFixed(1)}s — sinal perdido.`);
      } else if (!bridgePresent) {
        notify.tip("Dashboard", `${target.name}: ${rfResult.bars}/4 barras (${rfResult.latencyMs}ms — simulado)`);
      }
    });
  };

  const resetPump = (id: string) => {
    const target = pumps.find((p) => p.id === id);
    if (!target) return;

    if (target.hwId) {
      void (async () => {
        try {
          const enq = await enqueueResetPumpCommand({
            equipmentId: target.id,
            userId: user?.id ?? null,
            userName: userEmail,
          });
          setPumps((prev) =>
            prev.map((p) =>
              p.id !== id
                ? p
                : { ...p, pending: "resetting", pendingStartedAt: Date.now() }
            ),
          );
          

          // Reset também respeita confirmação física: só finaliza antes de 120s
          // quando a bomba confirmar 0; resposta antiga não corta o estado visual.
          const result = await waitForCommand(enq.commandId, 140_000);
          const succeeded = result.status === "executed";
          const isCommFail = !succeeded && (result.status === "timeout" || result.status === "unknown");

          if (isCommFail) {
            setPumps((prev) => prev.map((p) => (p.id === id && p.pending === "resetting" ? { ...p, pending: "comm_fail" as const } : p)));
          } else if (!succeeded) {
            setPumps((prev) => prev.map((p) => (p.id === id && p.pending === "resetting" ? { ...p, pending: "error" as const } : p)));
          }

          // Idem: só loga em resultado DEFINITIVO. Timeout/unknown do reset
          // não deve virar "Bomba não desligou" no sino — a confirmação física
          // (ou ausência dela após 120s) decide isso pela telemetria.
          // Sucesso é registrado pelo trigger SQL com user REAL. Aqui só falha.
          if (result.status === "error") {
            logEvent({
              equipmentId: target.id,
              pump: target.name,
              action: "Desligada",
              origin: "Remoto",
              user: userEmail,
              result: "fail",
            });
          }

          if (succeeded) {
            // ACK recebido — permanece em "Resetando..." (VERIFYING) até a
            // bomba confirmar fisicamente com payload "0".
            setPumps((prev) =>
              prev.map((p) =>
                p.id === id
                  ? { ...p, pending: "resetting", pendingStartedAt: p.pendingStartedAt ?? Date.now() }
                  : p,
              ),
            );
            notify.ok("Dashboard", `${target.name}: comando 0 confirmado fisicamente`);
          } else if (isCommFail) {
            notify.fail("Dashboard", `${target.name}: reset sem confirmação física em 120s`);
          } else {
            notify.fail("Dashboard", `${target.name}: erro no reset — ${result.errorMessage ?? "falha no envio"}`);
          }
        } catch (e: any) {
          setPumps((prev) => prev.map((p) => (p.id === id ? { ...p, pending: "error" as const } : p)));
          notify.fail("Dashboard", `${target.name}: ${e?.message ?? "falha ao enviar reset"}`);
        }
      })();
      return;
    }

    // Fallback simulado (preview sem cadastros)
    setPumps((prev) =>
      prev.map((p) => (p.id !== id ? p : { ...p, running: false, pending: undefined })),
    );
    if (target.running) {
      logEvent({
        equipmentId: target.id,
        pump: target.name,
        action: "Desligada",
        origin: "Remoto",
        user: userEmail,
        result: "success",
      });
    }
    notify.tip("Dashboard", "Comando resetado — bomba forçada para desligado.");
  };

  const changePumpMode = (id: string, mode: "manual" | "auto") => {
    setPumps(prev => prev.map(p => p.id === id ? { ...p, mode } : p));
  };

  const refreshPumpStatus = (id: string) => {
    const pump = pumps.find(p => p.id === id);
    if (!pump) return;
    const cloudPump = cloudEquipments.find((equipment) => equipment.id === id);
    notify.tip("Dashboard", `Atualizando status de ${pump.name}...`);

    // Modo produção (agente .exe headless): enfileira leitura prioritária na nuvem.
    // O agente recebe via Realtime, pré-empta polling em curso e responde em segundos.
    if (!bridgePresent && pump.hwId) {
      void (async () => {
        try {
          const realOutputs = cloudPump?.last_outputs_state ?? "";
          const realRunning = /^[01]$/.test(realOutputs)
            ? realOutputs === "1"
            : /^[01]{1,6}$/.test(realOutputs)
              ? realOutputs.charAt(Math.max(0, (cloudPump?.saida ?? 1) - 1)) === "1"
              : false;

          await enqueueManualStatusRead({
            equipmentId: pump.id,
            userId: user?.id ?? null,
            desiredRunning: (() => {
              if (pump.pending === "turning_off" || pump.pending === "resetting") return false;
              return realRunning;
            })(),
          });
          // NÃO atualizar lastReading local aqui — isso provocaria sucesso fictício.
          // O Realtime de equipments fornecerá last_communication real quando o
          // agente receber RX da bomba; o PumpTable detecta essa mudança e fecha
          // o estado "refreshing" exibindo sucesso. Se nada chegar em 8s, o
          // PumpTable mostra alerta de falha (timeout local).
        } catch (e: any) {
          notify.fail("Dashboard", `${pump.name}: falha ao enfileirar leitura — ${e?.message ?? e}`);
        }
      })();
      return;
    }

    // Modo bridge local (Electron janela web — legado/dev): cronometra latência direto.
    const frame = buildEquipmentFrame({
      hwId: pump.hwId,
      command: "status_read",
      radioOverride: pump.rfRadio ?? null,
      viaRepetidorOverride: pump.rfViaRep ?? null,
    }) ?? undefined;
    void measureRf({
      equipmentId: pump.id,
      equipmentName: pump.name,
      command: "status_read",
      frame,
      expectedHwId: pump.hwId,
    }).then((rfResult) => {
      setPumps(prev => prev.map(p =>
        p.id === id
          ? {
              ...p,
              lastReading: now(),
              signalRF: barsToPercent(rfResult.bars),
              online: rfResult.bars > 0,
              ...(rfResult.timedOut ? {} : { lastCommunication: new Date().toISOString() }),
            }
          : p,
      ));
      if (rfResult.timedOut) {
        notify.fail("Dashboard", `${pump.name}: sem resposta em ${(rfResult.latencyMs / 1000).toFixed(1)}s`);
      } else {
        notify.ok("Dashboard", `${pump.name}: ${rfResult.bars}/4 barras (${rfResult.latencyMs}ms)`);
      }
    });
  };

  const stats = getStatsFromData(pumps, reservoirs.length, t);
  const operationalStats = stats.operational;
  const equipmentStats = stats.equipment;

  const views = [
    { key: "list" as const, label: t.list, icon: LayoutList },
    { key: "details" as const, label: t.details, icon: Info },
    { key: "map" as const, label: t.map, icon: MapPin },
    { key: "diagrama" as const, label: "Diagrama", icon: GitBranch },
  ];

  const sectionLabels: Record<SectionKey, string> = {
    pumps: t.wellsAndPumps,
    reservoirs: t.reservoirs,
  };

  const pumpGroups = useMemo(() => {
    const ids = orderedPumps.map(p => p.id);
    // Não usa o nome da fazenda da nuvem como fallback — só agrupa pelas fazendas
    // realmente cadastradas pelo usuário (loadFarms). Equipamentos sem fazenda
    // associada caem no bucket "Sem fazenda" para evitar exibir nomes legados.
    const groups = groupEquipmentByFarm(ids, farms, sectors, undefined);
    const hasAnyConfig = farms.length > 0 || sectors.length > 0;
    if (!hasAnyConfig) return null;

    // Aplica ordem customizada de fazendas
    const farmIdx = (id: string) => {
      const i = layout.farmOrder.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const orderedGroups = [...groups].sort((a, b) => farmIdx(a.farm.id) - farmIdx(b.farm.id));

    // Aplica ordem customizada de setores dentro de cada fazenda
    return orderedGroups.map(g => {
      const orderForFarm = layout.sectorOrder[g.farm.id] ?? [];
      const sIdx = (id: string) => {
        const i = orderForFarm.indexOf(id);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      return { ...g, sectors: [...g.sectors].sort((a, b) => sIdx(a.sector.id) - sIdx(b.sector.id)) };
    });
  }, [orderedPumps, farms, sectors, layout.farmOrder, layout.sectorOrder]);

  const renderPumpsList = (list: Pump[], hideHeader = false) => {
    if (view === "list") return <PumpTable pumps={list} onToggle={togglePump} onReset={resetPump} onModeChange={changePumpMode} onRefreshStatus={refreshPumpStatus} flowEnabled={flowEnabled} consumptionEnabled={consumptionEnabled} voltageEnabled={voltageEnabled} currentEnabled={currentEnabled} hideHeader={hideHeader} />;
    if (view === "details") return <PumpDetails pumps={list} onToggle={togglePump} flowEnabled={flowEnabled} consumptionEnabled={consumptionEnabled} voltageEnabled={voltageEnabled} currentEnabled={currentEnabled} />;
    return null;
  };

  const renderSection = (key: SectionKey) => {
    if (key === "pumps") {
      // Sem bombas/poços cadastrados → não renderiza nada (nem card de fundo)
      if (orderedPumps.length === 0) return null;

      type FarmBlock = { farmName: string; pumps: Pump[] };
      let farmBlocks: FarmBlock[] | null = null;
      if (pumpGroups) {
        const blocks: FarmBlock[] = [];
        pumpGroups.forEach(fg => {
          const farmPumps: Pump[] = [];
          fg.sectors.forEach(sg => {
            const list = sg.equipmentIds
              .map(id => orderedPumps.find(p => p.id === id))
              .filter(Boolean) as Pump[];
            farmPumps.push(...list);
          });
          // Não exibe cabeçalho "Sem fazenda" quando não há fazenda vinculada.
          if (farmPumps.length > 0 && fg.farm.id !== "__unassigned__") {
            blocks.push({ farmName: fg.farm.nome, pumps: farmPumps });
          }
        });
        if (blocks.length > 0) farmBlocks = blocks;
      }

      return (
        <div className="space-y-1">
          <div className="flex items-center gap-2 px-1">
            <Droplets className="w-5 h-5 text-primary shrink-0" />
            <h2 className="text-sm sm:text-xs font-bold text-foreground uppercase tracking-wider">{t.wellsAndPumps}</h2>
            <div className="flex-1 h-px bg-border" />
            <Badge variant="secondary" className="text-xs sm:text-[10px] font-bold px-2 py-0.5">{orderedPumps.length}</Badge>
          </div>
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            {farmBlocks ? (
              <div className="space-y-2 p-2">
                {farmBlocks.map((b, i) => (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center gap-2 px-1">
                      <Building2 className="w-3.5 h-3.5 text-info shrink-0" />
                      <h3 className="text-xs font-bold text-foreground tracking-tight">{b.farmName}</h3>
                      <div className="flex-1 h-px bg-border" />
                      <Badge variant="secondary" className="text-[10px]">{b.pumps.length} bombas</Badge>
                    </div>
                    {renderPumpsList(b.pumps, true)}
                  </div>
                ))}
              </div>
            ) : (
              renderPumpsList(orderedPumps, true)
            )}
          </div>
        </div>
      );
    }
    if (key === "reservoirs") {
      // Sem reservatórios cadastrados → não renderiza nada
      if (orderedReservoirs.length === 0) return null;
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-2 px-1">
            <Activity className="w-3.5 h-3.5 text-accent shrink-0" />
            <h2 className="text-xs font-bold text-foreground uppercase tracking-wider">{t.reservoirs}</h2>
            <div className="flex-1 h-px bg-border" />
            <Badge variant="secondary" className="text-[10px]">{orderedReservoirs.length}</Badge>
          </div>
          <ReservoirGauges reservoirs={orderedReservoirs} onRefreshStatus={(id) => {
            const res = orderedReservoirs.find(r => r.id === id);
            const name = res?.name ?? "Reservatório";
            notify.tip("Dashboard", `Atualizando nível de ${name}...`);
            void enqueueManualLevelRead({ equipmentId: id, userId: user?.id ?? null })
              .catch((e: any) => notify.fail("Dashboard", `${name}: falha ao enfileirar leitura — ${e?.message ?? e}`));
          }} />
        </div>
      );
    }
    return null;
  };

  const isDiagram = view === "diagrama";
  const fitScreen = true;

  return (
    <div className={fitScreen ? "flex flex-col gap-2 min-h-full" : "space-y-3"}>




      {/* Header with view toggle */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground">{t.realTimeMonitoring}</p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => startMainTour()}
            className="h-8 w-8 p-0 shrink-0 hover:bg-primary/10 hover:border-primary/50 hover:text-primary transition-colors"
            title="Tour guiado — passo a passo do sistema"
            aria-label="Iniciar tour guiado"
          >
            <Plane className="w-4 h-4 text-primary -rotate-12" />
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 text-xs px-2 relative"
                data-tour="dashboard-cards"
                title={t.commandCenter}
              >
                <LayoutDashboard className="w-3.5 h-3.5 text-primary" />
                <span className="hidden md:inline">{t.commandCenter}</span>
                <Badge variant="secondary" className="h-4 px-1 text-[9px] font-bold">
                  {operationalStats[0].value}/{stats.equipment[0].value}
                </Badge>
                {Number(operationalStats[2].value) > 0 && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-destructive animate-pulse" />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-3 space-y-2">
              <div className="flex items-center gap-2 pb-1 border-b border-border">
                <LayoutDashboard className="w-4 h-4 text-primary" />
                <span className="text-xs font-bold text-foreground">{t.commandCenter}</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {operationalStats.map((stat) => (
                  <div key={stat.title} className="flex items-center gap-2 p-1.5 bg-secondary/40 rounded-md">
                    <div className="w-7 h-7 rounded-md bg-secondary flex items-center justify-center shrink-0">
                      <stat.icon className={`w-3.5 h-3.5 ${stat.color}`} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-base font-bold text-foreground leading-tight">{stat.value}</p>
                      <p className="text-[10px] text-muted-foreground leading-tight">{stat.title}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {equipmentStats.map((stat) => (
                  <div key={stat.title} className="flex items-center gap-2 p-1.5 bg-secondary/40 rounded-md">
                    <div className="w-7 h-7 rounded-md bg-secondary flex items-center justify-center shrink-0">
                      <stat.icon className={`w-3.5 h-3.5 ${stat.color}`} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-base font-bold text-foreground leading-tight">{stat.value}</p>
                      <p className="text-[10px] text-muted-foreground leading-tight">{stat.title}</p>
                    </div>
                  </div>
                ))}
              </div>
              <BridgeStatusCard />
            </PopoverContent>
          </Popover>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1 text-xs px-2" data-tour="dashboard-views" title="Visualização e Layout">
                <SlidersHorizontal className="w-3.5 h-3.5 text-primary" />
                <span className="hidden sm:inline">{views.find(v => v.key === view)?.label}</span>
                <ChevronDown className="w-3 h-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Visualização</DropdownMenuLabel>
              {views.map((v) => (
                <DropdownMenuItem key={v.key} onClick={() => setView(v.key)} className="gap-2 text-xs">
                  <v.icon className="w-3.5 h-3.5" />
                  <span className="flex-1">{v.label}</span>
                  {view === v.key && <Check className="w-3.5 h-3.5 text-primary" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setConfigOpen(true)} className="gap-2 text-xs">
                <Settings2 className="w-3.5 h-3.5" />
                <span>{t.layout}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {canViewIndicators && <IndicatorsMiniSummary farmId={farmId} />}
      <WaterBalanceCard farmId={farmId} pumpStats={waterBalancePumpStats} />


      {/* Main content - fills remaining viewport height */}
      {view === "map" ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <MapErrorBoundary>
            <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-muted-foreground">Carregando mapa…</div>}>
              <PumpMap pumps={orderedPumps} flowEnabled={flowEnabled} consumptionEnabled={consumptionEnabled} />
            </Suspense>
          </MapErrorBoundary>
        </div>
      ) : view === "diagrama" ? (
        <div className="flex-1 min-h-0">
          <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-muted-foreground">Carregando diagrama…</div>}>
            <WaterFlowDiagram pumps={orderedPumps} reservoirs={orderedReservoirs} cloudEquipments={cloudEquipments} />
          </Suspense>
        </div>
      ) : (
        <div className="flex-1 min-h-0 space-y-2">
          {layout.order.map(key => {
            const content = renderSection(key);
            if (!content) return null;
            return (
              <div key={key} data-tour={key === "pumps" ? "pump-list" : "reservoir-gauges"}>{content}</div>
            );
          })}
        </div>
      )}


      {/* Layout Config Dialog */}
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <Settings2 className="w-5 h-5 text-primary" />
              {t.customizeLayout}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto px-6 pb-6 flex-1 min-h-0">
            {/* 1) Ordem das seções principais */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-foreground">{t.sectionOrder}</p>
              <div className="space-y-1.5">
                {layout.order.map((key, i) => (
                  <div key={key} className="flex items-center gap-2 px-3 py-2 rounded-md bg-secondary/50 border border-border">
                    <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground flex-1">{sectionLabels[key]}</span>
                    <span className="text-[10px] text-muted-foreground mr-1">#{i + 1}</span>
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" className="w-full text-xs gap-1" onClick={toggleSectionOrder}>
                <ArrowUp className="w-3 h-3" /><ArrowDown className="w-3 h-3" />
                {t.invertOrder}
              </Button>
            </div>

            {/* 2) Fazendas → Setores → Bombas (hierarquia completa) */}
            {pumpGroups && pumpGroups.length > 0 && (() => {
              // Garante que farmOrder reflete todas as fazendas atualmente visíveis
              const visibleFarmIds = pumpGroups.map(g => g.farm.id);
              const farmList = [
                ...layout.farmOrder.filter(id => visibleFarmIds.includes(id)),
                ...visibleFarmIds.filter(id => !layout.farmOrder.includes(id)),
              ];
              const farmById = new Map(pumpGroups.map(g => [g.farm.id, g]));
              return (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-info" />
                    Ordem das Fazendas
                  </p>
                  <div className="space-y-2">
                    {farmList.map((farmId, fIdx) => {
                      const fg = farmById.get(farmId);
                      if (!fg) return null;

                      // Setores visíveis da fazenda (pela ordem do pumpGroups, já reordenado)
                      const visibleSectorIds = fg.sectors.map(s => s.sector.id);
                      const savedSectorOrder = layout.sectorOrder[farmId] ?? [];
                      const sectorList = [
                        ...savedSectorOrder.filter(id => visibleSectorIds.includes(id)),
                        ...visibleSectorIds.filter(id => !savedSectorOrder.includes(id)),
                      ];
                      const sectorById = new Map(fg.sectors.map(s => [s.sector.id, s]));

                      return (
                        <div key={farmId} className="rounded-md border border-border bg-secondary/30 overflow-hidden">
                          {/* Cabeçalho da fazenda */}
                          <div className="flex items-center gap-1 px-2 py-1.5 bg-secondary/60 border-b border-border">
                            <Building2 className="w-3.5 h-3.5 text-info shrink-0" />
                            <span className="text-xs font-semibold text-foreground flex-1 truncate">{fg.farm.nome}</span>
                            <span className="text-[10px] text-muted-foreground mr-1">#{fIdx + 1}</span>
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={fIdx === 0} onClick={() => moveFarm(farmList, fIdx, "top")} title="Topo">
                              <ChevronsUp className="w-3 h-3" />
                            </Button>
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={fIdx === 0} onClick={() => moveFarm(farmList, fIdx, -1)} title="Subir">
                              <ArrowUp className="w-3 h-3" />
                            </Button>
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={fIdx === farmList.length - 1} onClick={() => moveFarm(farmList, fIdx, 1)} title="Descer">
                              <ArrowDown className="w-3 h-3" />
                            </Button>
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={fIdx === farmList.length - 1} onClick={() => moveFarm(farmList, fIdx, "bottom")} title="Fim">
                              <ChevronsDown className="w-3 h-3" />
                            </Button>
                          </div>

                          {/* Setores da fazenda */}
                          <div className="p-1.5 space-y-1.5">
                            {sectorList.map((sectorId, sIdx) => {
                              const sg = sectorById.get(sectorId);
                              if (!sg) return null;
                              // Bombas do setor (na ordem global pumpOrder)
                              const sectorPumps = sg.equipmentIds
                                .map(id => pumps.find(p => p.id === id))
                                .filter(Boolean) as Pump[];
                              const orderedSectorPumps = [...sectorPumps].sort((a, b) => {
                                const ia = layout.pumpOrder.indexOf(a.id);
                                const ib = layout.pumpOrder.indexOf(b.id);
                                return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
                              });

                              return (
                                <div key={sectorId} className="rounded-md border border-border/50 bg-background/40">
                                  {/* Cabeçalho do setor */}
                                  <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50">
                                    <Layers className="w-3 h-3 text-accent shrink-0" />
                                    <span className="text-[11px] font-medium text-foreground flex-1 truncate">{sg.sector.nome}</span>
                                    <span className="text-[10px] text-muted-foreground mr-1">#{sIdx + 1}</span>
                                    <Button variant="ghost" size="sm" className="h-5 w-5 p-0" disabled={sIdx === 0} onClick={() => moveSector(farmId, sectorList, sIdx, "top")} title="Topo">
                                      <ChevronsUp className="w-3 h-3" />
                                    </Button>
                                    <Button variant="ghost" size="sm" className="h-5 w-5 p-0" disabled={sIdx === 0} onClick={() => moveSector(farmId, sectorList, sIdx, -1)} title="Subir">
                                      <ArrowUp className="w-3 h-3" />
                                    </Button>
                                    <Button variant="ghost" size="sm" className="h-5 w-5 p-0" disabled={sIdx === sectorList.length - 1} onClick={() => moveSector(farmId, sectorList, sIdx, 1)} title="Descer">
                                      <ArrowDown className="w-3 h-3" />
                                    </Button>
                                    <Button variant="ghost" size="sm" className="h-5 w-5 p-0" disabled={sIdx === sectorList.length - 1} onClick={() => moveSector(farmId, sectorList, sIdx, "bottom")} title="Fim">
                                      <ChevronsDown className="w-3 h-3" />
                                    </Button>
                                  </div>

                                  {/* Bombas do setor */}
                                  <div className="p-1 space-y-0.5">
                                    {orderedSectorPumps.length === 0 ? (
                                      <p className="text-[10px] text-muted-foreground px-2 py-1 italic">Sem bombas neste setor</p>
                                    ) : (() => {
                                      const sectorPumpIds = orderedSectorPumps.map(p => p.id);
                                      return orderedSectorPumps.map((p, sectorPumpIdx) => (
                                        <div key={p.id} className="flex items-center gap-1 px-2 py-1 rounded bg-secondary/20">
                                          <Droplets className="w-3 h-3 text-primary shrink-0" />
                                          <span className="text-[11px] text-foreground flex-1 truncate">{p.name}</span>
                                          <Button variant="ghost" size="sm" className="h-5 w-5 p-0" disabled={sectorPumpIdx === 0} onClick={() => movePumpWithinSector(sectorPumpIds, sectorPumpIdx, "top")} title="Topo">
                                            <ChevronsUp className="w-3 h-3" />
                                          </Button>
                                          <Button variant="ghost" size="sm" className="h-5 w-5 p-0" disabled={sectorPumpIdx === 0} onClick={() => movePumpWithinSector(sectorPumpIds, sectorPumpIdx, -1)} title="Subir">
                                            <ArrowUp className="w-3 h-3" />
                                          </Button>
                                          <Button variant="ghost" size="sm" className="h-5 w-5 p-0" disabled={sectorPumpIdx === sectorPumpIds.length - 1} onClick={() => movePumpWithinSector(sectorPumpIds, sectorPumpIdx, 1)} title="Descer">
                                            <ArrowDown className="w-3 h-3" />
                                          </Button>
                                          <Button variant="ghost" size="sm" className="h-5 w-5 p-0" disabled={sectorPumpIdx === sectorPumpIds.length - 1} onClick={() => movePumpWithinSector(sectorPumpIds, sectorPumpIdx, "bottom")} title="Fim">
                                            <ChevronsDown className="w-3 h-3" />
                                          </Button>
                                        </div>
                                      ));
                                    })()}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* 3) Lista plana de bombas (fallback / quando não há fazendas) */}
            {(!pumpGroups || pumpGroups.length === 0) && layout.pumpOrder.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-foreground">{t.pumpOrder}</p>
                <div className="space-y-1">
                  {layout.pumpOrder.map((pId, i) => {
                    const p = pumps.find(x => x.id === pId);
                    if (!p) return null;
                    return (
                      <div key={pId} className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-secondary/30 border border-border">
                        <span className="text-xs font-medium text-foreground flex-1 truncate">{p.name}</span>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={i === 0} onClick={() => movePumpTo(i, "top")} title="Topo">
                          <ChevronsUp className="w-3 h-3" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={i === 0} onClick={() => movePump(i, -1)}>
                          <ArrowUp className="w-3 h-3" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={i === layout.pumpOrder.length - 1} onClick={() => movePump(i, 1)}>
                          <ArrowDown className="w-3 h-3" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={i === layout.pumpOrder.length - 1} onClick={() => movePumpTo(i, "bottom")} title="Fim">
                          <ChevronsDown className="w-3 h-3" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 4) Reservatórios */}
            {layout.reservoirOrder.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-accent" />
                  {t.reservoirOrder}
                </p>
                <div className="space-y-1">
                  {layout.reservoirOrder.map((rId, i) => {
                    const r = reservoirs.find(x => x.id === rId);
                    if (!r) return null;
                    return (
                      <div key={rId} className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-secondary/30 border border-border">
                        <span className="text-xs font-medium text-foreground flex-1 truncate">{r.name}</span>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={i === 0} onClick={() => moveReservoirTo(i, "top")} title="Topo">
                          <ChevronsUp className="w-3 h-3" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={i === 0} onClick={() => moveReservoir(i, -1)}>
                          <ArrowUp className="w-3 h-3" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={i === layout.reservoirOrder.length - 1} onClick={() => moveReservoir(i, 1)}>
                          <ArrowDown className="w-3 h-3" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={i === layout.reservoirOrder.length - 1} onClick={() => moveReservoirTo(i, "bottom")} title="Fim">
                          <ChevronsDown className="w-3 h-3" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <Button variant="outline" size="sm" className="w-full text-xs" onClick={() => {
              saveLayout(getDefaultLayout(pumps, reservoirs));
              notify.ok("Dashboard", t.layoutRestored);
            }}>
              {t.restoreDefault}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Dashboard;
