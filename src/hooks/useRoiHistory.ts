// Hook do histórico de ROI — agrega economia diária por categoria a partir de
// pump_runtime (sessões reais), automation_log (acionamentos remotos) e
// farm_productivity_config (tarifas, custos). Mesmo modelo de fórmulas do
// RoiTravelCard, porém distribuído por dia para permitir histórico real.
// Energia = economia real por posto tarifário (tariff.ts); NÃO há mais o item
// sintético "captação extra" (campo mantido em 0 só p/ compat. do painel).
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { splitSessionByPost } from "@/lib/tariff";
import type { PeriodRange } from "@/components/indicadores/PeriodPicker";

export interface RoiDailyRow {
  day: string;          // YYYY-MM-DD
  captacao: number;     // R$ — descontinuado (sempre 0); mantido p/ compat.
  energia: number;
  deslocamento: number;
  maoObra: number;
  multas: number;
  total: number;
  cumulative: number;
}

export interface RoiMonthlyRow {
  month: string;        // YYYY-MM
  captacao: number;
  energia: number;
  deslocamento: number;
  maoObra: number;
  multas: number;
  total: number;
}

export interface RoiHistory {
  daily: RoiDailyRow[];
  monthly: RoiMonthlyRow[];
  totals: Omit<RoiMonthlyRow, "month">;
  loading: boolean;
}

function eachDay(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const start = new Date(`${fromIso}T00:00:00`);
  const end = new Date(`${toIso}T00:00:00`);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function ymd(iso: string): string { return new Date(iso).toISOString().slice(0, 10); }
function ym(iso: string): string { return iso.slice(0, 7); }

export function useRoiHistory(farmId: string | null, range: PeriodRange): RoiHistory {
  const [data, setData] = useState<RoiHistory>({
    daily: [], monthly: [], loading: false,
    totals: { captacao: 0, energia: 0, deslocamento: 0, maoObra: 0, multas: 0, total: 0 },
  });

  useEffect(() => {
    if (!farmId) {
      setData({ daily: [], monthly: [], loading: false, totals: { captacao: 0, energia: 0, deslocamento: 0, maoObra: 0, multas: 0, total: 0 } });
      return;
    }
    let cancelled = false;
    (async () => {
      setData((d) => ({ ...d, loading: true }));
      const fromIso = `${range.fromIso}T00:00:00`;
      const toIso = `${range.toIso}T23:59:59.999`;

      const [cfgRes, eqRes, runtimeRes, logRes, holRes] = await Promise.all([
        supabase.from("farm_productivity_config")
          .select("worker_cost_per_hour, vehicle_cost_per_km, travel_distance_km, travel_minutes_avg, manual_operation_time_minutes, remote_operation_time_minutes, cycles_per_day, tariff_peak, tariff_reserved, tariff_off_peak, tariff_intermediate, default_flow_m3h")
          .eq("farm_id", farmId).maybeSingle(),
        supabase.from("equipments")
          .select("id, power_kw, estimated_flow_m3h, active, type")
          .eq("farm_id", farmId).in("type", ["poco", "bombeamento"] as any),
        supabase.from("pump_runtime")
          .select("equipment_id, started_at, ended_at, duration_seconds")
          .eq("farm_id", farmId)
          .gte("started_at", fromIso)
          .lte("started_at", toIso)
          .order("started_at", { ascending: true })
          .limit(10000),
        supabase.from("automation_log")
          .select("equipment_id, occurred_at, origin, action")
          .eq("farm_id", farmId)
          .in("action", ["turn_on", "turn_off"] as any)
          .gte("occurred_at", fromIso)
          .lte("occurred_at", toIso)
          .limit(10000),
        supabase.from("national_holidays" as any).select("holiday_date"),
      ]);
      if (cancelled) return;

      const cfg: any = cfgRes.data ?? {};
      const workerCost = Number(cfg.worker_cost_per_hour ?? 25);
      const vehicleCost = Number(cfg.vehicle_cost_per_km ?? 2.5);
      const travelDistKm = Number(cfg.travel_distance_km ?? 10);
      const travelMin = Number(cfg.travel_minutes_avg ?? 30);
      const manualMin = Number(cfg.manual_operation_time_minutes ?? 80);
      const remoteMin = Number(cfg.remote_operation_time_minutes ?? 5);
      const cyclesDay = Number(cfg.cycles_per_day ?? 2);
      const tariffPeak = Number(cfg.tariff_peak ?? 1.884);
      const tariffReserved = Number(cfg.tariff_reserved ?? 0.3878);
      const tariffOffPeak = Number(cfg.tariff_off_peak ?? tariffReserved);
      const tariffInter = Number(cfg.tariff_intermediate ?? tariffPeak);

      const eqs = (eqRes.data ?? []) as Array<{ id: string; power_kw: number | null; estimated_flow_m3h: number | null; active: boolean | null }>;
      const activeEqs = eqs.filter(e => e.active);
      const numPumps = activeEqs.length;
      const avgPowerKw = numPumps > 0 ? activeEqs.reduce((a, e) => a + Number(e.power_kw ?? 75), 0) / numPumps : 75;
      // Potência por equipamento (inclui inativos p/ não perder runtime histórico).
      const powerById = new Map<string, number>(eqs.map(e => {
        const p = Number(e.power_kw);
        return [e.id, Number.isFinite(p) && p > 0 ? p : avgPowerKw];
      }));
      const holidaySet = new Set<string>(((holRes.data as any[]) ?? []).map((h: any) => h.holiday_date));

      const costPerTrip = travelDistKm * 2 * 1.3 * vehicleCost + (travelMin / 60) * workerCost;
      const gainMinPerCycle = Math.max(0, manualMin - remoteMin);
      // Mão de obra constante diária
      const maoObraDay = (gainMinPerCycle * cyclesDay * workerCost) / 60;

      const days = eachDay(range.fromIso, range.toIso);
      const map = new Map<string, RoiDailyRow>();
      for (const d of days) {
        map.set(d, { day: d, captacao: 0, energia: 0, deslocamento: 0, maoObra: maoObraDay, multas: 0, total: 0, cumulative: 0 });
      }

      // Energia REAL por dia = para cada sessão de pump_runtime, fatia por posto
      // tarifário (tariff.ts) × potência real × diferença vs. ponta. Horas em
      // ponta contribuem 0. Sem sessões no dia → energia = 0 (não inventa nada).
      for (const r of (runtimeRes.data ?? []) as any[]) {
        const day = ymd(r.started_at);
        const row = map.get(day);
        if (!row) continue;
        const start = new Date(r.started_at);
        const end = r.ended_at
          ? new Date(r.ended_at)
          : new Date(start.getTime() + (Number(r.duration_seconds) || 0) * 1000);
        if (!(end.getTime() > start.getTime())) continue;
        const power = powerById.get(r.equipment_id) ?? avgPowerKw;
        const split = splitSessionByPost(start, end, holidaySet);
        row.energia += power * (
          split.off_peak * Math.max(0, tariffPeak - tariffOffPeak) +
          split.reserved * Math.max(0, tariffPeak - tariffReserved) +
          split.intermediate * Math.max(0, tariffPeak - tariffInter)
        );
      }


      // Deslocamento = nº de comandos REMOTOS no dia × custo/viagem evitada
      for (const l of (logRes.data ?? []) as any[]) {
        if (l.origin !== "remote") continue;
        const day = ymd(l.occurred_at);
        const row = map.get(day);
        if (!row) continue;
        row.deslocamento += costPerTrip;
      }

      // Total + acumulado
      let cum = 0;
      const daily = Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day)).map(r => {
        r.total = r.captacao + r.energia + r.deslocamento + r.maoObra + r.multas;
        cum += r.total;
        r.cumulative = cum;
        return r;
      });

      // Agrega mensal
      const monthMap = new Map<string, RoiMonthlyRow>();
      for (const r of daily) {
        const m = ym(r.day);
        const cur = monthMap.get(m) ?? { month: m, captacao: 0, energia: 0, deslocamento: 0, maoObra: 0, multas: 0, total: 0 };
        cur.captacao += r.captacao;
        cur.energia += r.energia;
        cur.deslocamento += r.deslocamento;
        cur.maoObra += r.maoObra;
        cur.multas += r.multas;
        cur.total += r.total;
        monthMap.set(m, cur);
      }
      const monthly = Array.from(monthMap.values()).sort((a, b) => a.month.localeCompare(b.month));

      const totals = daily.reduce((acc, r) => ({
        captacao: acc.captacao + r.captacao,
        energia: acc.energia + r.energia,
        deslocamento: acc.deslocamento + r.deslocamento,
        maoObra: acc.maoObra + r.maoObra,
        multas: acc.multas + r.multas,
        total: acc.total + r.total,
      }), { captacao: 0, energia: 0, deslocamento: 0, maoObra: 0, multas: 0, total: 0 });

      setData({ daily, monthly, totals, loading: false });
    })();
    return () => { cancelled = true; };
  }, [farmId, range.fromIso, range.toIso]);

  return data;
}
