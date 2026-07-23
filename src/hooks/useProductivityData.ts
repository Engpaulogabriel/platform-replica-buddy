// Hook que carrega dados para a aba Produtividade/INEMA:
// - Config de tarifas/deslocamento da fazenda
// - Sessões pump_runtime no período + equipments (vazão, kW)
// - Feriados nacionais
// - Comandos remotos (para ROI deslocamento)
// Faz os cálculos por bomba e retorna estrutura pronta para UI/PDF.
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import {
  splitSessionByPost,
  computeEnergyCost,
  type TariffRates,
  type TariffPost,
} from "@/lib/tariff";

export interface ProductivityConfig {
  travel_minutes_avg: number;
  travel_distance_km: number;
  worker_cost_per_hour: number;
  vehicle_cost_per_km: number;
  tariff_off_peak: number;
  tariff_peak: number;
  tariff_reserved: number;
  tariff_intermediate: number;
  contracted_demand_kw: number;
  demand_cost_per_kw: number;
  utility_name?: string | null;
}

export const DEFAULT_PROD_CFG: ProductivityConfig = {
  travel_minutes_avg: 30,
  travel_distance_km: 10,
  worker_cost_per_hour: 25,
  vehicle_cost_per_km: 2.5,
  tariff_off_peak: 0.55,
  tariff_peak: 2.8,
  tariff_reserved: 0.32,
  tariff_intermediate: 1.20,
  contracted_demand_kw: 0,
  demand_cost_per_kw: 35,
  utility_name: null,
};

export interface PumpProductivity {
  equipmentId: string;
  name: string;
  estimated_flow_m3h: number | null;
  power_kw: number | null;
  hours_total: number;
  hours_by_post: Record<TariffPost, number>;
  kwh_by_post: Record<TariffPost, number>;
  cost_by_post: Record<TariffPost, number>;
  cost_total: number;
  volume_m3: number;
  /** Diferença entre custo real (com horas em ponta) e custo se essas horas fossem fora-ponta */
  peak_overcost: number;
  /** Custo se TODA operação tivesse sido em horário reservado (potencial de economia) */
  reserved_potential_cost: number;
}

export interface DailyVolume { day: string; volume_m3: number; hours: number }

export interface ProductivityResult {
  loading: boolean;
  cfg: ProductivityConfig;
  pumps: PumpProductivity[];
  dailyVolume: DailyVolume[];
  remoteCommandsCount: number;
  travelSavings: number;
  totals: {
    hours: number;
    volume_m3: number;
    cost: number;
    cost_per_m3: number;
    peak_overcost: number;
    reserved_potential_savings: number;
    kwh: number;
  };
  reload: () => void;
}

interface RuntimeRow {
  equipment_id: string;
  started_at: string;
  ended_at: string | null;
}

interface EquipmentRow {
  id: string;
  name: string;
  estimated_flow_m3h: number | null;
  power_kw: number | null;
}

export function useProductivityData(args: { from: Date; to: Date }): ProductivityResult {
  const farmId = useDefaultFarmId();
  const [loading, setLoading] = useState(true);
  const [cfg, setCfg] = useState<ProductivityConfig>(DEFAULT_PROD_CFG);
  const [pumps, setPumps] = useState<PumpProductivity[]>([]);
  const [dailyVolume, setDailyVolume] = useState<DailyVolume[]>([]);
  const [remoteCommandsCount, setRemoteCommandsCount] = useState(0);

  const fromIso = args.from.toISOString();
  const toIso = args.to.toISOString();

  const load = useCallback(async () => {
    if (!farmId) return;
    setLoading(true);
    const [cfgRes, eqRes, runRes, holRes, cmdRes] = await Promise.all([
      supabase.from("farm_productivity_config" as any).select("*").eq("farm_id", farmId).maybeSingle(),
      supabase.from("equipments").select("id, name, estimated_flow_m3h, power_kw")
        .eq("farm_id", farmId).in("type", ["poco", "bombeamento"] as any),
      supabase.from("pump_runtime").select("equipment_id, started_at, ended_at")
        .eq("farm_id", farmId)
        .gte("started_at", fromIso)
        .lte("started_at", toIso),
      supabase.from("national_holidays" as any).select("holiday_date")
        .gte("holiday_date", fromIso.slice(0, 10))
        .lte("holiday_date", toIso.slice(0, 10)),
      supabase.from("commands").select("id", { count: "exact", head: true })
        .eq("farm_id", farmId)
        .gte("created_at", fromIso)
        .lte("created_at", toIso),
    ]);

    const cfgData = (cfgRes.data as any) ?? DEFAULT_PROD_CFG;
    const finalCfg: ProductivityConfig = {
      travel_minutes_avg: Number(cfgData.travel_minutes_avg ?? DEFAULT_PROD_CFG.travel_minutes_avg),
      travel_distance_km: Number(cfgData.travel_distance_km ?? DEFAULT_PROD_CFG.travel_distance_km),
      worker_cost_per_hour: Number(cfgData.worker_cost_per_hour ?? DEFAULT_PROD_CFG.worker_cost_per_hour),
      vehicle_cost_per_km: Number(cfgData.vehicle_cost_per_km ?? DEFAULT_PROD_CFG.vehicle_cost_per_km),
      tariff_off_peak: Number(cfgData.tariff_off_peak ?? DEFAULT_PROD_CFG.tariff_off_peak),
      tariff_peak: Number(cfgData.tariff_peak ?? DEFAULT_PROD_CFG.tariff_peak),
      tariff_reserved: Number(cfgData.tariff_reserved ?? DEFAULT_PROD_CFG.tariff_reserved),
      tariff_intermediate: Number(cfgData.tariff_intermediate ?? DEFAULT_PROD_CFG.tariff_intermediate),
      contracted_demand_kw: Number(cfgData.contracted_demand_kw ?? 0),
      demand_cost_per_kw: Number(cfgData.demand_cost_per_kw ?? DEFAULT_PROD_CFG.demand_cost_per_kw),
      utility_name: cfgData.utility_name ?? null,
    };
    setCfg(finalCfg);

    const equipments: EquipmentRow[] = (eqRes.data as any) ?? [];
    const sessions: RuntimeRow[] = (runRes.data as any) ?? [];
    const holidaySet = new Set<string>(((holRes.data as any) ?? []).map((h: any) => h.holiday_date));
    setRemoteCommandsCount(cmdRes.count ?? 0);

    const rates: TariffRates = {
      off_peak: finalCfg.tariff_off_peak,
      peak: finalCfg.tariff_peak,
      reserved: finalCfg.tariff_reserved,
      intermediate: finalCfg.tariff_intermediate,
    };

    // Inicializa por bomba
    const byPump = new Map<string, PumpProductivity>();
    const dailyMap = new Map<string, DailyVolume>();
    for (const eq of equipments) {
      byPump.set(eq.id, {
        equipmentId: eq.id,
        name: eq.name,
        estimated_flow_m3h: eq.estimated_flow_m3h,
        power_kw: eq.power_kw,
        hours_total: 0,
        hours_by_post: { peak: 0, intermediate: 0, reserved: 0, off_peak: 0 },
        kwh_by_post: { peak: 0, intermediate: 0, reserved: 0, off_peak: 0 },
        cost_by_post: { peak: 0, intermediate: 0, reserved: 0, off_peak: 0 },
        cost_total: 0,
        volume_m3: 0,
        peak_overcost: 0,
        reserved_potential_cost: 0,
      });
    }

    for (const s of sessions) {
      const cur = byPump.get(s.equipment_id);
      if (!cur) continue;
      const start = new Date(s.started_at);
      const rawEnd = s.ended_at ? new Date(s.ended_at) : new Date();
      // Limita ao período
      const end = rawEnd > args.to ? args.to : rawEnd;
      const realStart = start < args.from ? args.from : start;
      if (end <= realStart) continue;

      const split = splitSessionByPost(realStart, end, holidaySet);
      cur.hours_by_post.peak += split.peak;
      cur.hours_by_post.intermediate += split.intermediate;
      cur.hours_by_post.reserved += split.reserved;
      cur.hours_by_post.off_peak += split.off_peak;
      const sessionHours = split.peak + split.intermediate + split.reserved + split.off_peak;
      cur.hours_total += sessionHours;

      // série diária
      const dayKey = realStart.toISOString().slice(0, 10);
      const flow = cur.estimated_flow_m3h ?? 0;
      const dv = dailyMap.get(dayKey) ?? { day: dayKey, volume_m3: 0, hours: 0 };
      dv.volume_m3 += sessionHours * flow;
      dv.hours += sessionHours;
      dailyMap.set(dayKey, dv);
    }

    // Calcula custos e ROI
    for (const p of byPump.values()) {
      const power = p.power_kw ?? 0;
      const flow = p.estimated_flow_m3h ?? 0;
      const energy = computeEnergyCost(p.hours_by_post, power, rates);
      p.kwh_by_post = energy.kwh;
      p.cost_by_post = energy.cost;
      p.cost_total = energy.total;
      p.volume_m3 = p.hours_total * flow;
      // overcost de ponta: diferença entre o que pagou na ponta vs se tivesse sido fora-ponta
      p.peak_overcost = energy.kwh.peak * (rates.peak - rates.off_peak);
      // potencial: se TUDO tivesse sido em reservado
      const totalKwh = energy.kwh.peak + energy.kwh.intermediate + energy.kwh.reserved + energy.kwh.off_peak;
      p.reserved_potential_cost = totalKwh * rates.reserved;
    }

    setPumps(Array.from(byPump.values()).sort((a, b) => a.name.localeCompare(b.name)));
    setDailyVolume(Array.from(dailyMap.values()).sort((a, b) => a.day.localeCompare(b.day)));
    setLoading(false);
  }, [farmId, fromIso, toIso, args.from, args.to]);

  useEffect(() => { void load(); }, [load]);

  const totals = pumps.reduce((acc, p) => ({
    hours: acc.hours + p.hours_total,
    volume_m3: acc.volume_m3 + p.volume_m3,
    cost: acc.cost + p.cost_total,
    peak_overcost: acc.peak_overcost + p.peak_overcost,
    reserved_potential: acc.reserved_potential + p.reserved_potential_cost,
    kwh: acc.kwh + (p.kwh_by_post.peak + p.kwh_by_post.reserved + p.kwh_by_post.off_peak),
  }), { hours: 0, volume_m3: 0, cost: 0, peak_overcost: 0, reserved_potential: 0, kwh: 0 });

  const travelSavings =
    remoteCommandsCount *
    ((cfg.travel_minutes_avg / 60) * cfg.worker_cost_per_hour +
      cfg.travel_distance_km * cfg.vehicle_cost_per_km);

  return {
    loading,
    cfg,
    pumps,
    dailyVolume,
    remoteCommandsCount,
    travelSavings,
    totals: {
      hours: totals.hours,
      volume_m3: totals.volume_m3,
      cost: totals.cost,
      cost_per_m3: totals.volume_m3 > 0 ? totals.cost / totals.volume_m3 : 0,
      peak_overcost: totals.peak_overcost,
      reserved_potential_savings: Math.max(0, totals.cost - totals.reserved_potential),
      kwh: totals.kwh,
    },
    reload: load,
  };
}

export interface InemaConfig {
  outorga_numero: string | null;
  outorga_processo: string | null;
  outorga_validade: string | null;
  vazao_outorgada_m3h: number | null;
  orgao: string | null;
  responsavel_tecnico: string | null;
  observacoes: string | null;
}

export function useInemaConfig() {
  const farmId = useDefaultFarmId();
  const [data, setData] = useState<InemaConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!farmId) return;
    setLoading(true);
    const { data } = await supabase.from("farm_inema_config" as any).select("*").eq("farm_id", farmId).maybeSingle();
    setData((data as any) ?? null);
    setLoading(false);
  }, [farmId]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, loading, reload, farmId };
}

export function useNationalHolidaysSet() {
  const [set, setSet] = useState<Set<string>>(new Set());
  useEffect(() => {
    void supabase.from("national_holidays" as any).select("holiday_date")
      .then(({ data }) => {
        if (data) setSet(new Set((data as any).map((h: any) => h.holiday_date)));
      });
  }, []);
  return set;
}
