// Card "Eficiência Energética" — permanente no dashboard, 24h.
// Conceito central: MIN-BOMBA (multiplicativo). Ex: 20 bombas × 17 min = 340 min-bomba.
// O KPI visual principal é o ATRASO MÉDIO POR BOMBA — gera pressão no operador.
import { useEffect, useState } from "react";
import { Zap, CheckCircle2, AlertTriangle, Clock, Activity } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface Summary {
  date: string;
  cycle_start?: string;
  efficiency_percent: number | null;
  pre_peak_shutdown_time: string | null;
  post_peak_startup_time: string | null;
  lost_minutes: number;
  lost_pump_minutes?: number;
  pumps_on_during_peak: number;
  pumps_operated: number;
  pumps_in_cycle?: number;
  pumps_running_now?: number;
  minutes_on_during_peak: number;
  pre_peak_ok_count: number;
  post_peak_ok_count: number;
  in_peak_window?: boolean;
  after_peak_window?: boolean;
  cycle_start_label?: string;
  avg_7d: number | null;
  avg_30d: number | null;
  lost_minutes_7d?: number;
  lost_minutes_30d?: number;
  lost_pump_minutes_7d?: number;
  lost_pump_minutes_30d?: number;
  post_lost_minutes_today?: number;     // max atraso individual
  post_lost_pump_minutes?: number;      // soma min-bomba pós-ponta
  post_late_pumps?: number;
  post_last_on?: string | null;          // última bomba ligada
  peak_pump_minutes?: number;
  gap_minutes_today?: number;
  gap_pumps_today?: number;
  cycle_capacity_pump_minutes?: number;
  pre_late_pumps?: number;               // bombas na tarifa 3x
  pre_avg_late?: number;                 // atraso médio pré-ponta
  pre_last_off?: string | null;          // última bomba desligada
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** "340 min-bomba" / "11h 40min-bomba" */
function fmtPumpMin(total: number): string {
  if (total < 0) total = 0;
  if (total < 60) return `${total} min-bomba`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m > 0 ? `${h}h ${m}min-bomba` : `${h}h-bomba`;
}

/** Cor do total perdido: <100 verde · 100-500 amarelo · >500 vermelho */
function lossTone(pumpMin: number) {
  if (pumpMin < 100) return { text: "text-emerald-500", bg: "bg-emerald-500/10", border: "border-emerald-500/30" };
  if (pumpMin <= 500) return { text: "text-amber-500", bg: "bg-amber-500/10", border: "border-amber-500/30" };
  return { text: "text-destructive", bg: "bg-destructive/10", border: "border-destructive/40" };
}

function effTone(eff: number) {
  if (eff >= 95) return { text: "text-emerald-500", bg: "bg-emerald-500/10", border: "border-emerald-500/30", glow: "shadow-emerald-500/20" };
  if (eff >= 80) return { text: "text-amber-500", bg: "bg-amber-500/10", border: "border-amber-500/30", glow: "shadow-amber-500/20" };
  return { text: "text-destructive", bg: "bg-destructive/10", border: "border-destructive/30", glow: "shadow-destructive/20" };
}

/** Cor do atraso médio: ≤5 verde · 6-15 amarelo · 16-30 laranja · >30 vermelho */
function delayTone(avgMin: number) {
  if (avgMin <= 5)  return { text: "text-emerald-500",   bg: "bg-emerald-500/10",   border: "border-emerald-500/30" };
  if (avgMin <= 15) return { text: "text-amber-500",     bg: "bg-amber-500/10",     border: "border-amber-500/30" };
  if (avgMin <= 30) return { text: "text-orange-500",    bg: "bg-orange-500/10",    border: "border-orange-500/30" };
  return { text: "text-destructive", bg: "bg-destructive/10", border: "border-destructive/40" };
}

function delayLabel(avgMin: number) {
  if (avgMin <= 5)  return "✅ excelente";
  if (avgMin <= 15) return "⚠️ aceitável";
  if (avgMin <= 30) return "🟠 ruim";
  return "🔴 crítico";
}

interface TariffInfo {
  reserved: number;
  off_peak: number;
  intermediate: number;
  peak: number;
  utility_name: string | null;
  avg_power_kw: number;
  peakStartMin: number;
  peakEndMin: number;
  peakStartLabel: string;   // "18:00"
  peakEndLabel: string;     // "21:00"
}

interface PumpEquipment {
  id: string;
  name: string;
  power_kw: number | null;
  saida: number | null;
  last_outputs_state: string | null;
}

type EnergyMoment = "before_peak" | "pre_shutdown" | "peak" | "post_restart" | "reserved";

const fmtBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 });

function isRunning(eq: PumpEquipment): boolean {
  const payload = eq.last_outputs_state ?? "";
  const idx = (eq.saida ?? 1) - 1;
  if (payload.length === 1) return payload === "1";
  return payload[idx] === "1";
}

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function fmtDuration(min: number): string {
  const safe = Math.max(0, Math.floor(min));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  if (h <= 0) return `${m}min`;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function getEnergyMoment(now: Date, peakStartMin: number, peakEndMin: number): EnergyMoment {
  const m = minutesOfDay(now);
  const preShutdownStart = peakStartMin - 5;
  if (m >= preShutdownStart && m < peakStartMin) return "pre_shutdown";
  if (m >= peakStartMin && m < peakEndMin) return "peak";
  if (m >= peakEndMin && m < peakEndMin + 30) return "post_restart";
  if (m >= 6 * 60 && m < preShutdownStart) return "before_peak";
  return "reserved";
}

interface HistoricEff {
  lastDate: string | null;        // YYYY-MM-DD
  lastEff: number | null;         // % do último ciclo fechado
  lastUpdatedAt: string | null;   // updated_at do registro
  avg7d: number | null;           // média dos últimos 7 dias com dados
}

interface HeroPeriodStats {
  avgEff: number | null;         // score_final × 10 (nova fórmula 5 sub-indicadores)
  score: number | null;          // 0-10
  subScores: { post: number; pre: number; peak: number; mode: number; uptime: number } | null;
  avgFirstLate: number;          // média do atraso da PRIMEIRA bomba de cada dia (min)
  avgLastAntic: number;          // média da antecipação da ÚLTIMA bomba pré-ponta (min)
  totalLostPumpMin: number;      // soma de lost_pump_minutes (dias úteis)
  avgPumpsLate: number;          // média de bombas atrasadas por dia
  infractionDays: number;        // dias com peak_pump_minutes > 0
  workingDays: number;           // dias úteis considerados
}

interface HeroStats {
  d7: HeroPeriodStats;
  d30: HeroPeriodStats;
  activePumps: number;           // total dinâmico de bombas ativas na fazenda
}

const EMPTY_PERIOD: HeroPeriodStats = {
  avgEff: null, score: null, subScores: null, avgFirstLate: 0, avgLastAntic: 0, totalLostPumpMin: 0, avgPumpsLate: 0, infractionDays: 0, workingDays: 0,
};


// ═══ Fórmulas dos 5 sub-indicadores (mesmas do FarmScoreCard) ═══
function scorePost(avgMin: number): number {
  if (avgMin <= 8) return 10;
  if (avgMin <= 12) return +(9 - ((avgMin - 8) / 4) * 4).toFixed(1);
  if (avgMin <= 30) return +(5 - ((avgMin - 12) / 18) * 5).toFixed(1);
  return 0;
}
function scorePre(avgAnticMin: number): number {
  if (avgAnticMin <= 5) return 10;
  if (avgAnticMin >= 105) return 0;
  return +(10 - ((avgAnticMin - 5) / 100) * 10).toFixed(1);
}
function scorePeakFn(totalPeakMin: number, pumpsWithPeak: number, maxPeak: number): number {
  if (totalPeakMin === 0) return 10;
  if (maxPeak > 30) return 0;
  if (pumpsWithPeak >= 2) return 3;
  if (pumpsWithPeak === 1 && totalPeakMin <= 5) return 7;
  if (pumpsWithPeak === 1) return 5;
  return 10;
}
function scoreLinear10(pct: number): number {
  return Math.max(0, Math.min(10, +(pct / 10).toFixed(1)));
}

import { usePermission } from "@/contexts/MasterManagerContext";

export interface HeroCustomPeriod {
  startDate: string; // YYYY-MM-DD (inclusive)
  endDate: string;   // YYYY-MM-DD (inclusive)
  label: string;     // e.g. "Últimos 60 dias" / "Período selecionado"
}

interface InnerProps {
  farmId: string | null;
  customPeriod?: HeroCustomPeriod;
}

function EnergyEfficiencyCardInner({ farmId, customPeriod }: InnerProps) {


  const [data, setData] = useState<Summary | null>(null);
  const [tariff, setTariff] = useState<TariffInfo | null>(null);
  const [equipments, setEquipments] = useState<PumpEquipment[]>([]);
  const [now, setNow] = useState(new Date());
  const [showBands, setShowBands] = useState(false);
  const [historic, setHistoric] = useState<HistoricEff>({ lastDate: null, lastEff: null, lastUpdatedAt: null, avg7d: null });
  const [hero, setHero] = useState<HeroStats>({ d7: EMPTY_PERIOD, d30: EMPTY_PERIOD, activePumps: 0 });
  const periodLabel = customPeriod?.label ?? "Últimos 30 dias";


  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!farmId) { setData(null); return; }
    let cancelled = false;
    const load = async () => {
      const { data: res, error } = await supabase.rpc("get_energy_efficiency_summary", { _farm_id: farmId });
      if (!cancelled && !error && res && typeof res === "object" && !("error" in (res as object))) {
        setData(res as unknown as Summary);
      }
    };
    void load();
    const t = setInterval(load, 300_000); // 5 min p/ cota Cloud
    return () => { cancelled = true; clearInterval(t); };
  }, [farmId]);

  // Histórico persistente — eficiência NUNCA desaparece. Mesmo se o ciclo
  // atual ainda não fechou (RPC retorna null), mostramos o último valor real
  // de energy_efficiency_daily e a média 7d como base do score.
  useEffect(() => {
    if (!farmId) { setHistoric({ lastDate: null, lastEff: null, lastUpdatedAt: null, avg7d: null }); return; }
    let cancelled = false;
    const load = async () => {
      const sevenAgoIso = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
      const { data: rows } = await supabase
        .from("energy_efficiency_daily")
        .select("date, efficiency_percent, updated_at")
        .eq("farm_id", farmId)
        .gte("date", sevenAgoIso)
        .order("date", { ascending: false })
        .limit(30);
      if (cancelled) return;
      const arr = (rows ?? []) as Array<{ date: string; efficiency_percent: number; updated_at: string }>;
      const last = arr[0] ?? null;
      const valid = arr.filter(r => r.efficiency_percent != null);
      const avg7d = valid.length > 0 ? valid.reduce((s, r) => s + Number(r.efficiency_percent), 0) / valid.length : null;
      setHistoric({
        lastDate: last?.date ?? null,
        lastEff: last ? Number(last.efficiency_percent) : null,
        lastUpdatedAt: last?.updated_at ?? null,
        avg7d,
      });
    };
    void load();
    const t = setInterval(load, 300_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [farmId]);

  // ═══ Hero: agregados 7d / 30d, apenas dias úteis (is_free_demand = false)
  // Fonte: energy_efficiency_daily + energy_efficiency_daily_pumps.
  // Exclui o dia atual (< CURRENT_DATE) — o card já mostra o ciclo de hoje em outra seção.
  useEffect(() => {
    if (!farmId) { setHero({ d7: EMPTY_PERIOD, d30: EMPTY_PERIOD, activePumps: 0 }); return; }
    let cancelled = false;
    const load = async () => {
      const today = new Date();
      const toIso = (d: Date) => d.toISOString().slice(0, 10);
      const todayIso = toIso(today);

      // Período customizado (History Panel) OU últimos 30 dias por padrão
      const periodStartIso = customPeriod?.startDate ?? toIso(new Date(today.getTime() - 30 * 86400_000));
      const periodEndIso = customPeriod?.endDate ?? todayIso;

      // 7d fixo (sempre últimos 7 dias reais)
      const cutoff7Date = toIso(new Date(today.getTime() - 7 * 86400_000));
      const cutoff7Ts = new Date(today.getTime() - 7 * 86400_000).toISOString();

      // Query cobre a união dos dois intervalos
      const fromIso = periodStartIso < cutoff7Date ? periodStartIso : cutoff7Date;
      const untilIso = periodEndIso > todayIso ? periodEndIso : todayIso;
      const fromTs = new Date(fromIso + "T00:00:00").toISOString();
      const fiveMinAgo = new Date(today.getTime() - 5 * 60_000).toISOString();

      const [dailyRes, pumpsRes, logRes, eqRes] = await Promise.all([
        supabase
          .from("energy_efficiency_daily")
          .select("date, efficiency_percent, lost_pump_minutes, peak_pump_minutes, is_free_demand")
          .eq("farm_id", farmId)
          .gte("date", fromIso)
          .lte("date", untilIso)
          .order("date", { ascending: false }),
        supabase
          .from("energy_efficiency_daily_pumps")
          .select("date, first_on, last_off, late_min, early_off_min, peak_minutes, post_status, pre_status")
          .eq("farm_id", farmId)
          .gte("date", fromIso)
          .lte("date", untilIso),
        supabase
          .from("automation_log")
          .select("origin, occurred_at")
          .eq("farm_id", farmId)
          .gte("occurred_at", fromTs)
          .in("origin", ["local", "remote", "auto", "system"] as any),
        supabase
          .from("equipments")
          .select("id, last_communication")
          .eq("farm_id", farmId)
          .in("type", ["poco", "bombeamento", "conjunto", "rio"] as any)
          .eq("active", true),
      ]);
      if (cancelled) return;

      type DailyRow = { date: string; efficiency_percent: number | null; lost_pump_minutes: number | null; peak_pump_minutes: number | null; is_free_demand: boolean | null };
      type PumpRow = { date: string; first_on: string | null; last_off: string | null; late_min: number | null; early_off_min: number | null; peak_minutes: number | null; post_status: string | null; pre_status: string | null };
      type LogRow = { origin: string; occurred_at: string };
      const daily = ((dailyRes.data ?? []) as DailyRow[]).filter(r => r.is_free_demand !== true);
      const workingDates = new Set(daily.map(r => r.date));
      const pumps = ((pumpsRes.data ?? []) as PumpRow[]).filter(r => workingDates.has(r.date));
      const logs = ((logRes.data ?? []) as LogRow[]);
      const eqs = ((eqRes.data ?? []) as { last_communication: string | null }[]);
      const activePumps = eqs.length;

      // Uptime é snapshot — mesmo valor para 7d e 30d
      let uptimePct = 100;
      if (eqs.length > 0) {
        const online = eqs.filter(e => e.last_communication && new Date(e.last_communication).toISOString() >= fiveMinAgo).length;
        uptimePct = (online / eqs.length) * 100;
      }
      const uptimeScore = scoreLinear10(uptimePct);

      const aggregate = (
        dailySubset: DailyRow[],
        pumpsSubset: PumpRow[],
        logsSubset: LogRow[],
      ): HeroPeriodStats => {
        if (dailySubset.length === 0) return { ...EMPTY_PERIOD };

        // ═ Agrupa pumps por dia para achar 1ª/última bomba ═
        const byDate = new Map<string, PumpRow[]>();
        pumpsSubset.forEach(r => {
          const arr = byDate.get(r.date) ?? [];
          arr.push(r);
          byDate.set(r.date, arr);
        });

        // Atraso da PRIMEIRA bomba (menor first_on) de cada dia
        const firstBombDelays: number[] = [];
        // Antecipação da ÚLTIMA bomba (maior last_off) de cada dia
        const lastBombAntics: number[] = [];
        byDate.forEach(rows => {
          const withFirst = rows.filter(r => r.first_on);
          if (withFirst.length > 0) {
            withFirst.sort((a, b) => (a.first_on! < b.first_on! ? -1 : 1));
            firstBombDelays.push(Math.max(0, Number(withFirst[0].late_min ?? 0)));
          }
          const withLast = rows.filter(r => r.last_off);
          if (withLast.length > 0) {
            withLast.sort((a, b) => (a.last_off! < b.last_off! ? 1 : -1));
            lastBombAntics.push(Math.max(0, Number(withLast[0].early_off_min ?? 0)));
          }
        });
        const avgFirstLate = firstBombDelays.length > 0
          ? Math.round(firstBombDelays.reduce((s, v) => s + v, 0) / firstBombDelays.length)
          : 0;
        const avgLastAntic = lastBombAntics.length > 0
          ? Math.round(lastBombAntics.reduce((s, v) => s + v, 0) / lastBombAntics.length)
          : 0;

        const post = scorePost(avgFirstLate);
        const pre = scorePre(avgLastAntic);

        const peakRows = pumpsSubset.filter(p => Number(p.peak_minutes ?? 0) > 0);
        const totalPeak = peakRows.reduce((s, r) => s + Number(r.peak_minutes), 0);
        const maxPeak = peakRows.reduce((m, r) => Math.max(m, Number(r.peak_minutes)), 0);
        const peakScore = scorePeakFn(totalPeak, peakRows.length, maxPeak);

        const remoteN = logsSubset.filter(l => ["remote", "auto", "system"].includes(l.origin)).length;
        const localN = logsSubset.filter(l => l.origin === "local").length;
        const totalOps = remoteN + localN;
        const pctRemote = totalOps > 0 ? (remoteN / totalOps) * 100 : 100;
        const modeScore = scoreLinear10(pctRemote);

        const score = +((post + pre + peakScore + modeScore + uptimeScore) / 5).toFixed(1);
        const avgEff = +(score * 10).toFixed(1);

        const latePumps = pumpsSubset.filter(p => Number(p.late_min ?? 0) > 0);
        const avgPumpsLate = dailySubset.length > 0 ? latePumps.length / dailySubset.length : 0;
        const totalLostPumpMin = dailySubset.reduce((s, r) => s + Number(r.lost_pump_minutes ?? 0), 0);
        const infractionDays = dailySubset.filter(r => Number(r.peak_pump_minutes ?? 0) > 0).length;

        return {
          avgEff, score,
          subScores: { post, pre, peak: peakScore, mode: modeScore, uptime: uptimeScore },
          avgFirstLate, avgLastAntic, totalLostPumpMin, avgPumpsLate, infractionDays,
          workingDays: dailySubset.length,
        };
      };

      // 7d = últimos 7 dias reais (excluindo hoje)
      const daily7 = daily.filter(r => r.date >= cutoff7Date && r.date < todayIso);
      const pumps7 = pumps.filter(r => r.date >= cutoff7Date && r.date < todayIso);
      const logs7 = logs.filter(l => l.occurred_at >= cutoff7Ts);

      // Período (custom ou 30d default) — inclui o intervalo escolhido
      const dailyP = daily.filter(r => r.date >= periodStartIso && r.date <= periodEndIso);
      const pumpsP = pumps.filter(r => r.date >= periodStartIso && r.date <= periodEndIso);
      const periodStartTs = new Date(periodStartIso + "T00:00:00").toISOString();
      const periodEndTs = new Date(periodEndIso + "T23:59:59").toISOString();
      const logsP = logs.filter(l => l.occurred_at >= periodStartTs && l.occurred_at <= periodEndTs);

      setHero({ d7: aggregate(daily7, pumps7, logs7), d30: aggregate(dailyP, pumpsP, logsP), activePumps });
    };
    void load();
    const t = setInterval(load, 300_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [farmId, customPeriod?.startDate, customPeriod?.endDate]);




  // Carrega tarifas + potência média das bombas (1x por farmId)
  useEffect(() => {
    if (!farmId) { setTariff(null); setEquipments([]); return; }
    let cancelled = false;
    const loadEnergyContext = async () => {
      const [cfgRes, eqRes] = await Promise.all([
        supabase.from("farm_productivity_config")
          .select("tariff_reserved, tariff_off_peak, tariff_intermediate, tariff_peak, utility_name, peak_hour_start, peak_hour_end")
          .eq("farm_id", farmId).maybeSingle(),
        supabase.from("equipments")
          .select("id, name, power_kw, saida, last_outputs_state").eq("farm_id", farmId).in("type", ["poco", "bombeamento", "conjunto", "rio"] as any),
      ]);
      if (cancelled) return;
      const cfg = cfgRes.data;
      const eqs = (eqRes.data ?? []) as PumpEquipment[];
      const powers = eqs.map(e => Number(e.power_kw ?? 0)).filter(p => p > 0);
      const avg = powers.length > 0 ? powers.reduce((a, b) => a + b, 0) / powers.length : 0;
      const parseHM = (v: string | null | undefined, fallback: number): number => {
        if (!v) return fallback;
        const [h, m] = v.split(":");
        return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
      };
      const peakStartMin = parseHM(cfg?.peak_hour_start as any, 18 * 60);
      const peakEndMin   = parseHM(cfg?.peak_hour_end   as any, 21 * 60);
      const hm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
      setEquipments(eqs);
      setTariff({
        reserved: Number(cfg?.tariff_reserved ?? 0.32),
        off_peak: Number(cfg?.tariff_off_peak ?? 0.55),
        intermediate: Number(cfg?.tariff_intermediate ?? 1.20),
        peak: Number(cfg?.tariff_peak ?? 2.80),
        utility_name: cfg?.utility_name ?? null,
        avg_power_kw: avg,
        peakStartMin,
        peakEndMin,
        peakStartLabel: hm(peakStartMin),
        peakEndLabel: hm(peakEndMin),
      });
    };
    void loadEnergyContext();
    const t = setInterval(loadEnergyContext, 180_000); // 3 min p/ cota Cloud
    return () => { cancelled = true; clearInterval(t); };
  }, [farmId]);

  // Helper p/ formatar o badge de contexto histórico
  const fmtHistContext = (): string | null => {
    if (historic.lastEff == null) return null;
    const when = historic.lastUpdatedAt
      ? new Date(historic.lastUpdatedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
      : (historic.lastDate ?? "");
    return `Último ciclo fechado: ${historic.lastEff.toFixed(1)}% (${when})`;
  };

  if (!data) {
    // Fallback contextual — NUNCA mostra "—". Quando ainda não recebemos o
    // resumo do ciclo, exibimos a média 7d e o último ciclo registrado.
    const peakStartMin = tariff?.peakStartMin ?? 18 * 60;
    const peakEndMin = tariff?.peakEndMin ?? 21 * 60;
    const fallbackMoment = getEnergyMoment(now, peakStartMin, peakEndMin);
    const minutesToRestartFallback = Math.max(0, peakEndMin - minutesOfDay(now));
    const histScore = historic.avg7d ?? historic.lastEff;
    const tScore = histScore != null ? effTone(histScore) : null;
    let fallbackMsg: string;
    if (!farmId) {
      fallbackMsg = "Carregando fazenda — eficiência energética permanece disponível.";
    } else if (fallbackMoment === "peak") {
      fallbackMsg = `Horário de ponta ativo — bombas desligadas (economia). Religamento às ${tariff?.peakEndLabel ?? "21:00"} (em ${fmtDuration(minutesToRestartFallback)}).`;
    } else if (fallbackMoment === "pre_shutdown") {
      fallbackMsg = "Janela pré-ponta — desligamento em curso.";
    } else if (fallbackMoment === "post_restart") {
      fallbackMsg = "Religamento pós-ponta em andamento.";
    } else {
      fallbackMsg = "Aguardando início do próximo ciclo de bombeamento.";
    }
    const tone = tScore ?? { text: "text-muted-foreground", border: "border-border/50", bg: "bg-background/60", glow: "" };

    return (
      <div className={`rounded-xl border ${tone.border} ${tone.bg} p-4 mb-3 shadow-sm`}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Zap className={`w-5 h-5 ${tone.text}`} />
            <h3 className="font-bold text-foreground tracking-wide uppercase text-xs">Eficiência Energética</h3>
          </div>
          <span className="text-[10px] text-muted-foreground uppercase">
            {fallbackMoment === "peak" ? "Ciclo Fechado" : "Histórico"}
          </span>
        </div>

        {histScore != null ? (
          <>
            <div className="flex items-baseline justify-center gap-2 mb-2">
              <span className={`text-5xl font-black ${tone.text} tabular-nums leading-none`}>{histScore.toFixed(1)}%</span>
              <span className="text-xs text-muted-foreground">média 7 dias</span>
            </div>
            {fmtHistContext() && (
              <div className="text-[11px] text-muted-foreground text-center mb-2">{fmtHistContext()}</div>
            )}
          </>
        ) : (
          <div className="text-center text-muted-foreground text-xs mb-2">Sem ciclos registrados ainda.</div>
        )}

        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg bg-background/60 border border-border/50`}>
          <Activity className={`w-4 h-4 text-muted-foreground`} />
          <span className="text-xs text-foreground">{fallbackMsg}</span>
        </div>
      </div>
    );
  }

  const eff = data.efficiency_percent == null ? null : Number(data.efficiency_percent);
  const t = effTone(eff ?? historic.avg7d ?? historic.lastEff ?? 100);
  const operated = data.pumps_in_cycle ?? data.pumps_operated ?? 0;
  const runningNow = data.pumps_running_now ?? 0;
  const inPeak = !!data.in_peak_window;
  const afterPeak = !!data.after_peak_window;

  // ── Componentes do tempo perdido ──
  const postPumpMin = data.post_lost_pump_minutes ?? 0;
  const postLatePumps = data.post_late_pumps ?? 0;
  const postAvgLate = postLatePumps > 0 ? Math.round(postPumpMin / postLatePumps) : 0;
  const postDt = delayTone(postAvgLate);

  const gapPumpMin = data.gap_minutes_today ?? 0;
  const gapPumps = data.gap_pumps_today ?? 0;
  const peakPumpMin = data.peak_pump_minutes ?? 0;
  const peakPumps = data.pumps_on_during_peak ?? 0;
  // Fonte única: total consolidado retornado pelo RPC.
  // Não somar componentes aqui, porque lost_pump_minutes já inclui a regra oficial.
  const totalPumpMin = Number(data.lost_pump_minutes ?? data.lost_minutes ?? 0);
  const lt = lossTone(totalPumpMin);

  // Pré-ponta
  const preLatePumps = data.pre_late_pumps ?? 0;
  const preAvgLate = data.pre_avg_late ?? 0;
  const preDt = delayTone(preAvgLate);

  const moment = getEnergyMoment(now, tariff?.peakStartMin ?? 18 * 60, tariff?.peakEndMin ?? 21 * 60);
  const runningPumps = equipments.filter(isRunning);
  const stoppedPumps = equipments.filter(e => !isRunning(e));
  const totalPumps = Math.max(equipments.length, operated, runningPumps.length);
  const runningCount = Math.max(runningNow, runningPumps.length);
  const nowMin = minutesOfDay(now);
  const minutesToPeak = Math.max(0, 18 * 60 - nowMin);
  const minutesToRestart = Math.max(0, 21 * 60 - nowMin);
  const minutesSinceRestart = Math.max(0, nowMin - 21 * 60);
  const runningKw = runningPumps.reduce((sum, e) => sum + Number(e.power_kw ?? 0), 0);
  const peakDiff = tariff ? Math.max(0, tariff.peak - tariff.reserved) : 0;
  const peakExtraPerMinute = runningKw * peakDiff / 60;
  const progress = totalPumps > 0 ? Math.round((runningCount / totalPumps) * 100) : 0;
  const cycleStartAt = data.cycle_start ? new Date(data.cycle_start) : null;
  const cycleEndAt = data.pre_peak_shutdown_time ? new Date(data.pre_peak_shutdown_time) : null;
  const cycleDuration = cycleStartAt && cycleEndAt ? fmtDuration((cycleEndAt.getTime() - cycleStartAt.getTime()) / 60_000) : "—";
  // Eficiência sempre visível — usa o ciclo atual; se ainda não fechou,
  // mostra média 7d ou último ciclo registrado (nunca "—").
  const histFallback = historic.avg7d ?? historic.lastEff;
  const effDisplay: number | null = eff ?? histFallback;
  const effLabel = eff != null
    ? `HOJE: ${eff.toFixed(1)}%`
    : histFallback != null
      ? `MÉDIA 7D: ${histFallback.toFixed(1)}%`
      : "AGUARDANDO 1º CICLO";
  const headlineStatus = moment === "pre_shutdown"
    ? "⚠️ DESLIGANDO"
    : moment === "peak" && runningCount > 0
      ? "🔴🔴🔴 INFRAÇÃO"
      : moment === "peak"
        ? `🔴 PONTA · ${histFallback != null ? `${histFallback.toFixed(1)}%` : "—"}`
        : moment === "post_restart"
          ? "⏱️ RELIGANDO..."
          : effLabel;
  const cardTone = moment === "peak" && runningCount > 0
    ? { text: "text-destructive", bg: "bg-destructive/10", border: "border-destructive/40", glow: "shadow-destructive/20" }
    : moment === "pre_shutdown" && runningCount > 0
      ? { text: "text-amber-500", bg: "bg-amber-500/10", border: "border-amber-500/30", glow: "shadow-amber-500/20" }
      : t;

  // Texto de impacto
  let impactText = "";
  let whatIfText = "";
  if (totalPumpMin > 0 && operated > 0) {
    const perPump = Math.round(totalPumpMin / operated);
    const h = Math.floor(totalPumpMin / 60);
    const m = totalPumpMin % 60;
    const oneStr = h > 0 ? (m > 0 ? `${h}h ${m}min` : `${h}h`) : `${m}min`;
    impactText = `Equivale a 1 bomba parada por ${oneStr}, ou ${operated} bombas paradas por ~${perPump} min cada.`;
    // Frase de impacto contextual
    if (postAvgLate > 5) {
      const savedMin = postAvgLate - 5;
      const sh = Math.floor(savedMin / 60);
      const sm = savedMin % 60;
      whatIfText = `Se ligasse às 21:05, teria ${sh > 0 ? `${sh}h ` : ""}${sm}min a mais de captação por bomba hoje.`;
    }
  }

  // Hero helper — faixas: ≥90% Excelente · 80-89% Ruim · <80% Crítico
  const heroEffTone = (eff: number | null) => {
    if (eff == null) return { text: "text-muted-foreground", border: "border-border/40", bg: "bg-background/40", label: "—" };
    if (eff >= 90) return { text: "text-emerald-500", border: "border-emerald-500/30", bg: "bg-emerald-500/10", label: "Excelente" };
    if (eff >= 80) return { text: "text-orange-500",  border: "border-orange-500/30",  bg: "bg-orange-500/10",  label: "Ruim" };
    return { text: "text-destructive", border: "border-destructive/40", bg: "bg-destructive/10", label: "Crítico" };
  };

  const renderHeroBox = (label: string, stats: HeroPeriodStats) => {
    const tone = heroEffTone(stats.avgEff);
    return (
      <div className={`rounded-lg border ${tone.border} ${tone.bg} p-3`}>
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</div>
          <span className={`text-[10px] font-semibold uppercase ${tone.text}`}>{tone.label}</span>
        </div>
        {stats.workingDays === 0 ? (
          <div className="text-xs text-muted-foreground py-2">Sem dias úteis registrados.</div>
        ) : (
          <>
            <div className="flex items-baseline gap-1 mb-1.5">
              <span className={`text-4xl font-black ${tone.text} tabular-nums leading-none`}>
                {stats.avgEff != null ? stats.avgEff.toFixed(1) : "—"}
              </span>
              <span className={`text-lg font-bold ${tone.text}`}>%</span>
              {stats.score != null && (
                <span className="text-[11px] text-muted-foreground ml-1 tabular-nums">= {stats.score.toFixed(1)}/10</span>
              )}
              <span className="text-[10px] text-muted-foreground ml-1">({stats.workingDays}d úteis)</span>
            </div>
            <div className="text-[11px] text-muted-foreground space-y-0.5">
              <div>Atraso 1ª bomba: <span className="font-semibold text-foreground tabular-nums">{stats.avgFirstLate} min</span></div>
              <div>Antecipação última bomba: <span className="font-semibold text-foreground tabular-nums">{stats.avgLastAntic} min</span></div>
              <div>Tempo perdido: <span className="font-semibold text-foreground tabular-nums">{fmtPumpMin(stats.totalLostPumpMin)}</span></div>
              <div>Bombas atrasadas/dia: <span className="font-semibold text-foreground tabular-nums">{stats.avgPumpsLate.toFixed(1)}{hero.activePumps > 0 ? `/${hero.activePumps}` : ""}</span></div>
              {stats.infractionDays > 0 && (
                <div className="text-destructive">Infrações na ponta: <span className="font-semibold tabular-nums">{stats.infractionDays} dia(s)</span></div>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className={`rounded-xl border ${cardTone.border} ${cardTone.bg} p-4 mb-3 shadow-md ${cardTone.glow}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Zap className={`w-5 h-5 ${cardTone.text}`} />
          <h3 className="font-bold text-foreground tracking-wide uppercase text-xs">Eficiência Energética</h3>
        </div>
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">tendência</span>
      </div>

      {/* ═══ HERO: MÉDIAS 7D E 30D (destaque principal) ═══ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
        {renderHeroBox("Últimos 7 dias", hero.d7)}
        {renderHeroBox(periodLabel, hero.d30)}
      </div>


      {/* Rodapé Acumulado 7d/30d removido — agora exibido em destaque no topo (HERO). */}

    </div>
  );
}

export function EnergyEfficiencyCard(props: { farmId: string | null; customPeriod?: HeroCustomPeriod }) {
  const canViewFinancial = usePermission("can_view_financial");
  if (!canViewFinancial) return null;
  return <EnergyEfficiencyCardInner {...props} />;
}
