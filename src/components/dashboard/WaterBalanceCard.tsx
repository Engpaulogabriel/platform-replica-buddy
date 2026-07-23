// ─────────────────────────────────────────────────────────────────────────────
// WaterBalanceCard — Indicador de Balanço Hídrico
//
// Estados:
//   positiva        → níveis subindo (bombas ligadas)
//   equilibrada     → níveis estáveis (bombas ligadas)
//   insuficiente    → caindo COM bombas ligadas (consumo > captação)
//   sem_captacao    → caindo SEM bombas ligadas
//   pausada_ponta   → 0 bombas ligadas DURANTE horário de ponta (esperado)
//   parada_fora     → 0 bombas ligadas FORA do horário de ponta (atenção)
//   ponta_violacao  → BOMBAS LIGADAS DENTRO DA PONTA (alerta crítico tarifa 5x)
//   sem_dados       → ainda sem leituras suficientes
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import {
  TrendingUp, TrendingDown, Minus, AlertTriangle, Droplets, HelpCircle, Pause, AlertOctagon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isPeakNow } from "@/lib/tariff";

interface WaterBalance {
  status: "positiva" | "equilibrada" | "insuficiente" | "sem_captacao" | "sem_dados" | "parada";
  rate_per_min: number;
  rate_per_hour: number;
  sensor_rate_per_hour: number;
  avg_level_percent: number | null;
  active_pumps: number;
  total_pumps: number;
  sensors_with_data: number;
  prediction_hours: number | null;
  calculated_at: string;
}

interface RunningPump {
  id: string;
  name: string;
  power_kw: number;
  on_since: string | null; // ISO from automation_log
}

interface PumpStat {
  id: string;
  running: boolean;
  offline: boolean;
}

interface Props {
  farmId: string | null;
  /**
   * Lista autoritativa de bombas vinda do Dashboard (mesma fonte do "Centro
   * de Comando"). Quando fornecida, sobrescreve a contagem feita via
   * `equipments.communication_status` — que pode estar defasada por não
   * considerar varreduras PLC (TSNN) e leva o badge X/Y a divergir do
   * card do topo.
   */
  pumpStats?: PumpStat[];
}

const STATUS_META = {
  positiva: {
    title: "Captação positiva",
    subtitle: "Reservatórios enchendo",
    icon: TrendingUp,
    accent: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-500/10 border-emerald-500/30",
    badge: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  },
  equilibrada: {
    title: "Captação equilibrada",
    subtitle: "Nível estável",
    icon: Minus,
    accent: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-500/10 border-amber-500/30",
    badge: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  },
  insuficiente: {
    title: "Captação insuficiente",
    subtitle: "Consumo maior que captação",
    icon: TrendingDown,
    accent: "text-destructive",
    bg: "bg-destructive/10 border-destructive/30",
    badge: "bg-destructive/20 text-destructive",
  },
  sem_captacao: {
    title: "Sem captação",
    subtitle: "Bombas desligadas e nível caindo",
    icon: AlertTriangle,
    accent: "text-destructive",
    bg: "bg-destructive/10 border-destructive/30",
    badge: "bg-destructive/20 text-destructive",
  },
  pausada_ponta: {
    title: "Captação pausada — Horário de Ponta",
    subtitle: "Todas as bombas desligadas (economia de energia)",
    icon: Pause,
    accent: "text-sky-600 dark:text-sky-400",
    bg: "bg-sky-500/10 border-sky-500/30",
    badge: "bg-sky-500/20 text-sky-700 dark:text-sky-300",
  },
  parada_fora: {
    title: "Captação parada",
    subtitle: "Nenhuma bomba operando fora do horário de ponta",
    icon: AlertTriangle,
    accent: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-500/10 border-amber-500/30",
    badge: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  },
  ponta_violacao: {
    title: "🔴 BOMBA LIGADA NO HORÁRIO DE PONTA!",
    subtitle: "Tarifa muito mais cara que horário reservado",
    icon: AlertOctagon,
    accent: "text-destructive",
    bg: "bg-destructive/15 border-destructive",
    badge: "bg-destructive/30 text-destructive",
  },
  sem_dados: {
    title: "Sem dados suficientes",
    subtitle: "Aguardando leituras dos sensores de nível",
    icon: HelpCircle,
    accent: "text-muted-foreground",
    bg: "bg-muted/40 border-border",
    badge: "bg-muted text-muted-foreground",
  },
} as const;

const fmtBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });

function minutesAgo(iso: string | null): string {
  if (!iso) return "—";
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "agora";
  if (min === 1) return "1 min";
  return `${min} min`;
}

export function WaterBalanceCard({ farmId, pumpStats }: Props) {
  const [wb, setWb] = useState<WaterBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningPumps, setRunningPumps] = useState<RunningPump[]>([]);
  const [onlinePumpsTotal, setOnlinePumpsTotal] = useState<number>(0);
  // Ref para o fetch (detalhes/violação) sem re-disparar o efeito a cada render
  const pumpStatsRef = useRef<PumpStat[] | undefined>(pumpStats);
  pumpStatsRef.current = pumpStats;
  const [tariffPeak, setTariffPeak] = useState<number>(1.884);
  const [tariffReserved, setTariffReserved] = useState<number>(0.3878);
  const [now, setNow] = useState(new Date());

  // ticker pra atualizar "há X min" e re-classificar peak
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!farmId) { setWb(null); setLoading(false); return; }
    let cancelled = false;
    const fetchOnce = async () => {
      const fourHoursAgo = new Date(Date.now() - 4 * 3600_000).toISOString();
      const [
        { data: wbData, error: wbErr },
        { data: cfg },
        { data: eqs },
        { data: logs },
      ] = await Promise.all([
        supabase.rpc("get_water_balance", { _farm_id: farmId }),
        supabase.from("farm_productivity_config" as any)
          .select("tariff_peak, tariff_reserved")
          .eq("farm_id", farmId)
          .maybeSingle(),
        supabase.from("equipments")
          .select("id, name, power_kw, last_outputs_state, saida, communication_status, last_communication")
          .eq("farm_id", farmId)
          .eq("active", true)
          .in("type", ["poco", "bombeamento"] as any),
        supabase.from("automation_log")
          .select("equipment_id, occurred_at, action, result")
          .eq("farm_id", farmId)
          .eq("action", "on" as any)
          .gte("occurred_at", fourHoursAgo)
          .order("occurred_at", { ascending: false })
          .limit(500),
      ]);
      if (cancelled) return;
      if (!wbErr && wbData) setWb(wbData as unknown as WaterBalance);
      if (cfg) {
        const c = cfg as any;
        if (c.tariff_peak != null) setTariffPeak(Number(c.tariff_peak));
        if (c.tariff_reserved != null) setTariffReserved(Number(c.tariff_reserved));
      }
      // Regra de contagem (igual ao grid POÇOS E BOMBAS):
      //  - communication_status !== 'offline' → entra no denominador
      //  - ligada = estado REAL do último RX (last_outputs_state), independente
      //    de modo local/remoto. NUNCA usar desired_running.
      const onSinceByEq = new Map<string, string>();
      for (const l of (logs as any[] | null) ?? []) {
        if (!onSinceByEq.has(l.equipment_id)) {
          onSinceByEq.set(l.equipment_id, l.occurred_at);
        }
      }
      const isRunningFromOutputs = (e: any): boolean => {
        const payload = String(e.last_outputs_state ?? "");
        const saidaIndex = (e.saida ? Number(e.saida) : 1) - 1;
        // Payload curto (poço, 1 dígito): "1" = ligado
        if (payload.length === 1) return payload === "1";
        if (!/^[01]{1,6}$/.test(payload)) return false;
        if (saidaIndex < 0 || saidaIndex >= payload.length) return false;
        return payload[saidaIndex] === "1";
      };
      const running: RunningPump[] = [];
      // Conjunto autoritativo vindo do Dashboard (Centro de Comando), lido via
      // ref para não re-disparar o fetch a cada render do Dashboard.
      const authStats = pumpStatsRef.current;
      const authMap = authStats
        ? new Map(authStats.map((p) => [p.id, p] as const))
        : null;
      for (const e of (eqs as any[] | null) ?? []) {
        const auth = authMap?.get(e.id);
        const isRunning = auth ? auth.running && !auth.offline : isRunningFromOutputs(e);
        if (isRunning) {
          running.push({
            id: e.id,
            name: e.name ?? "Sem nome",
            power_kw: Number(e.power_kw ?? 75),
            on_since: onSinceByEq.get(e.id) ?? null,
          });
        }
      }
      setRunningPumps(running);
      // Denominador (fallback) = total cadastrado (todos os equipamentos ativos).
      const totalRegistered = ((eqs as any[]) ?? []).length;
      setOnlinePumpsTotal(totalRegistered);
      setLoading(false);
    };
    void fetchOnce();
    const id = window.setInterval(fetchOnce, 300_000); // 5 min p/ cota Cloud
    return () => { cancelled = true; window.clearInterval(id); };
  }, [farmId]);

  // Sem feriados disponíveis no client → set vazio (peak 18-21 dias úteis)
  const isPeakHour = useMemo(() => isPeakNow(new Set<string>(), now), [now]);

  const peakEndLabel = "Horário de ponta termina às 21:00";

  // ÚNICA FONTE DE VERDADE: mesma lista reativa do Centro de Comando.
  // Numerador = running && !offline; Denominador = total cadastrado.
  // Atualiza no MESMO tick que o Centro de Comando (sem fetch separado).
  const authActive = pumpStats
    ? pumpStats.filter((p) => p.running && !p.offline).length
    : null;
  const authTotal = pumpStats ? pumpStats.length : null;
  const activePumps = authActive ?? runningPumps.length;
  const totalPumps = authTotal ?? (onlinePumpsTotal || wb?.total_pumps || 0);
  const displayStatus = useMemo(() => {
    if (!wb) return "sem_dados" as const;
    if (activePumps > 0) {
      if (isPeakHour) return "ponta_violacao" as const;
      return wb.status;
    }
    if (isPeakHour) return "pausada_ponta" as const;
    return "parada_fora" as const;
  }, [wb, isPeakHour, activePumps]);

  if (!farmId) return null;
  if (loading && !wb) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-3 text-xs text-muted-foreground flex items-center gap-2">
          <Droplets className="w-3.5 h-3.5 animate-pulse" />
          Calculando balanço hídrico…
        </CardContent>
      </Card>
    );
  }
  if (!wb) return null;

  const meta = STATUS_META[displayStatus] ?? STATUS_META.sem_dados;
  const Icon = meta.icon;

  const isViolation = displayStatus === "ponta_violacao";
  const isPausedDuringPeak = displayStatus === "pausada_ponta";
  const isStoppedOutside = displayStatus === "parada_fora";

  // Cálculo de custo extra na ponta
  const totalKw = runningPumps.reduce((a, p) => a + (Number.isFinite(p.power_kw) ? p.power_kw : 0), 0);
  const tariffDiff = Math.max(0, tariffPeak - tariffReserved);
  const extraCostPerMin = (totalKw * tariffDiff) / 60;
  const tariffRatio = tariffReserved > 0 ? tariffPeak / tariffReserved : 0;

  const isCritical =
    isViolation ||
    (wb.prediction_hours !== null &&
      wb.prediction_hours < 4 &&
      (wb.status === "insuficiente" || wb.status === "sem_captacao"));

  const rateLabel =
    wb.active_pumps === 0
      ? "0 %/h"
      : `${wb.rate_per_hour > 0 ? "+" : ""}${wb.rate_per_hour.toFixed(2)} %/h`;

  const sensorRateLabel =
    wb.active_pumps === 0 && wb.sensor_rate_per_hour !== 0
      ? `${wb.sensor_rate_per_hour > 0 ? "+" : ""}${wb.sensor_rate_per_hour.toFixed(2)} %/h`
      : null;

  return (
    <Card
      className={cn(
        "border transition-colors",
        meta.bg,
        isCritical && "ring-2 ring-destructive animate-pulse",
      )}
    >
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-start gap-3 sm:gap-4">
          <div className={cn(
            "shrink-0 w-12 h-12 sm:w-14 sm:h-14 rounded-xl flex items-center justify-center bg-background/60",
            meta.accent,
          )}>
            <Icon className="w-7 h-7 sm:w-8 sm:h-8" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className={cn("text-sm sm:text-base font-bold leading-tight", meta.accent)}>
                {meta.title}
              </h3>
              <span className={cn(
                "text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full",
                meta.badge,
              )}>
                {activePumps}/{totalPumps} BOMBAS
              </span>
            </div>
            <p className={cn("text-xs mt-0.5 leading-snug", isViolation ? "text-destructive font-semibold" : "text-muted-foreground")}>
              {isViolation && tariffRatio > 0
                ? `⚠️ Tarifa ${tariffRatio.toFixed(1)}x mais cara que horário reservado`
                : meta.subtitle}
            </p>

            {wb.status !== "sem_dados" && !isViolation && (
              <div className="flex flex-wrap items-center gap-3 sm:gap-4 mt-1.5 text-[11px] sm:text-xs">
                <span className="text-muted-foreground">
                  Taxa: <span className={cn("font-semibold", meta.accent)}>{rateLabel}</span>
                </span>
                {sensorRateLabel && (
                  <span className="text-muted-foreground">
                    Variação do nível: <span className="font-semibold text-amber-600 dark:text-amber-400">{sensorRateLabel} (inércia)</span>
                  </span>
                )}
                {wb.avg_level_percent !== null && (
                  <span className="text-muted-foreground">
                    Nível médio: <span className="font-semibold text-foreground">{wb.avg_level_percent.toFixed(0)}%</span>
                  </span>
                )}
                {wb.prediction_hours !== null && wb.rate_per_hour < 0 && (
                  <span className={cn("font-semibold", isCritical ? "text-destructive" : "text-amber-600 dark:text-amber-400")}>
                    {isCritical ? "🚨" : "⏱"} esvazia em ~{wb.prediction_hours.toFixed(1)} h
                  </span>
                )}
                {isPausedDuringPeak && (
                  <span className="font-semibold text-sky-600 dark:text-sky-400">
                    {peakEndLabel}
                  </span>
                )}
                {isStoppedOutside && (
                  <span className="font-semibold text-amber-600 dark:text-amber-400">
                    ⚠️ Atenção: bombas deveriam estar operando
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Bloco de violação de ponta — lista de bombas + custo */}
        {isViolation && (
          <div className="mt-3 pt-3 border-t border-destructive/30 space-y-2.5">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-destructive mb-1.5">
                Bombas ligadas agora:
              </div>
              <ul className="space-y-1 text-xs">
                {runningPumps.length === 0 && (
                  <li className="text-muted-foreground">Carregando bombas…</li>
                )}
                {runningPumps.map((p) => (
                  <li key={p.id} className="flex items-baseline gap-2">
                    <span className="text-destructive">•</span>
                    <span className="font-semibold text-foreground truncate">{p.name}</span>
                    <span className="text-muted-foreground tabular-nums">({p.power_kw.toFixed(0)} kW)</span>
                    {p.on_since && (
                      <span className="text-muted-foreground text-[11px]">
                        — ligada há {minutesAgo(p.on_since)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div className="bg-background/60 rounded-md px-2.5 py-1.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Consumo atual</div>
                <div className="font-bold text-destructive tabular-nums">
                  {totalKw.toFixed(0)} kW <span className="text-[10px] font-medium text-muted-foreground">na tarifa de ponta</span>
                </div>
              </div>
              <div className="bg-background/60 rounded-md px-2.5 py-1.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Custo extra</div>
                <div className="font-bold text-destructive tabular-nums">
                  ~{fmtBRL(extraCostPerMin)}/min <span className="text-[10px] font-medium text-muted-foreground">vs reservado</span>
                </div>
              </div>
            </div>

            <div className="text-[11px] text-muted-foreground">
              {peakEndLabel}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
