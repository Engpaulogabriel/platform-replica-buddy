// Hook que monta as séries diárias para os gráficos de Indicadores Gerenciais.
// Lê pump_runtime (horas/volume), automation_log (acionamentos) e
// energy_efficiency_daily (eficiência) — todos filtrados pelo período e por
// equipamento selecionado.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { PeriodRange, PumpOption } from "@/components/indicadores/PeriodPicker";

export interface DailyProductivityRow {
  day: string;            // YYYY-MM-DD
  volumeM3: number;       // captação estimada do dia
  hoursOn: number;        // total de horas ligadas
  triggers: number;       // acionamentos (turn_on + turn_off)
  turnOns: number;        // só turn_on (ciclos de acionamento)
  efficiency: number | null; // % do dia (energy_efficiency_daily)
}

export interface ProductivityHistory {
  rows: DailyProductivityRow[];
  pumps: PumpOption[];
  loading: boolean;
  avgFlowM3h: number;     // vazão média (m³/h) das bombas no escopo
  totals: {
    volumeM3: number;
    hoursOn: number;
    triggers: number;
    turnOns: number;
    avgEfficiency: number | null;
  };
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

function ymdOf(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

// PostgREST limita cada resposta a 1000 linhas (max-rows), mesmo com .limit(10000).
// Pagina com .range() em blocos de 1000 até esgotar.
const PAGE = 1000;
const MAX_PAGES = 20;
async function fetchAllPages<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const { data, error } = await buildQuery(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

export function useProductivityHistory(
  farmId: string | null,
  range: PeriodRange,
  pumpFilter: string,
): ProductivityHistory {
  const [data, setData] = useState<ProductivityHistory>({
    rows: [], pumps: [], loading: false, avgFlowM3h: 0,
    totals: { volumeM3: 0, hoursOn: 0, triggers: 0, turnOns: 0, avgEfficiency: null },
  });

  useEffect(() => {
    if (!farmId) {
      setData({ rows: [], pumps: [], loading: false, avgFlowM3h: 0, totals: { volumeM3: 0, hoursOn: 0, triggers: 0, turnOns: 0, avgEfficiency: null } });
      return;
    }
    let cancelled = false;
    (async () => {
      setData((d) => ({ ...d, loading: true }));
      const fromIso = `${range.fromIso}T00:00:00`;
      const toIso = `${range.toIso}T23:59:59.999`;

      // 1) Equipamentos + config da fazenda (vazão padrão como fallback)
      const [eqRes, cfgRes] = await Promise.all([
        supabase
          .from("equipments")
          .select("id, name, estimated_flow_m3h")
          .eq("farm_id", farmId)
          .in("type", ["poco", "bombeamento"] as any),
        supabase
          .from("farm_productivity_config")
          .select("default_flow_m3h")
          .eq("farm_id", farmId)
          .maybeSingle(),
      ]);
      const eqs = (eqRes.data ?? []) as Array<{ id: string; name: string; estimated_flow_m3h: number | null }>;
      const defaultFlow = Number((cfgRes.data as any)?.default_flow_m3h ?? 0);
      const flowById = new Map(eqs.map(e => {
        const own = Number(e.estimated_flow_m3h ?? 0);
        return [e.id, own > 0 ? own : defaultFlow];
      }));
      const pumps: PumpOption[] = eqs.map(e => ({ id: e.id, name: e.name }));

      // 2) Runtime + acionamentos em paralelo (paginado — PostgREST corta em 1000 linhas)
      const runtimePromise = fetchAllPages<any>((from, to) =>
        supabase
          .from("pump_runtime")
          .select("equipment_id, started_at, ended_at, duration_seconds")
          .eq("farm_id", farmId)
          .gte("started_at", fromIso)
          .lte("started_at", toIso)
          .order("started_at", { ascending: true })
          .range(from, to),
      );

      const logPromise = fetchAllPages<any>((from, to) =>
        supabase
          .from("automation_log")
          .select("equipment_id, action, occurred_at")
          .eq("farm_id", farmId)
          .in("action", ["turn_on", "turn_off"] as any)
          .gte("occurred_at", fromIso)
          .lte("occurred_at", toIso)
          .order("occurred_at", { ascending: true })
          .range(from, to),
      );

      const effQuery = supabase
        .from("energy_efficiency_daily")
        .select("date, efficiency_percent")
        .eq("farm_id", farmId)
        .gte("date", range.fromIso)
        .lte("date", range.toIso);

      const [runtimeRows, logRows, effRes] = await Promise.all([runtimePromise, logPromise, effQuery]);
      if (cancelled) return;

      // Agrupa por dia
      const days = eachDay(range.fromIso, range.toIso);
      const map = new Map<string, DailyProductivityRow>();
      for (const day of days) {
        map.set(day, { day, volumeM3: 0, hoursOn: 0, triggers: 0, turnOns: 0, efficiency: null });
      }

      const matchPump = (id?: string | null) => !id ? false : (pumpFilter === "all" || pumpFilter === id);

      for (const r of runtimeRows as any[]) {
        if (!matchPump(r.equipment_id)) continue;
        const day = ymdOf(r.started_at);
        const row = map.get(day);
        if (!row) continue;
        const seconds = r.duration_seconds ??
          (r.ended_at ? Math.max(0, (new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000) : 0);
        const hours = seconds / 3600;
        row.hoursOn += hours;
        row.volumeM3 += hours * (flowById.get(r.equipment_id) ?? 0);
      }

      for (const l of logRows as any[]) {
        if (!matchPump(l.equipment_id)) continue;
        const day = ymdOf(l.occurred_at);
        const row = map.get(day);
        if (!row) continue;
        row.triggers += 1;
        if (l.action === "turn_on") row.turnOns += 1;
      }

      for (const e of (effRes.data ?? []) as any[]) {
        const row = map.get(e.date);
        if (!row) continue;
        row.efficiency = Number(e.efficiency_percent);
      }

      const rows = Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
      const totals = rows.reduce(
        (acc, r) => {
          acc.volumeM3 += r.volumeM3;
          acc.hoursOn += r.hoursOn;
          acc.triggers += r.triggers;
          acc.turnOns += r.turnOns;
          if (r.efficiency != null) {
            acc.effSum += r.efficiency;
            acc.effCount += 1;
          }
          return acc;
        },
        { volumeM3: 0, hoursOn: 0, triggers: 0, turnOns: 0, effSum: 0, effCount: 0 },
      );

      // Vazão média das bombas no escopo (apenas as filtradas)
      const flowsInScope = eqs
        .filter(e => pumpFilter === "all" || pumpFilter === e.id)
        .map(e => flowById.get(e.id) ?? 0)
        .filter(f => f > 0);
      const avgFlowM3h = flowsInScope.length > 0
        ? flowsInScope.reduce((a, b) => a + b, 0) / flowsInScope.length
        : defaultFlow;

      setData({
        rows,
        pumps,
        loading: false,
        avgFlowM3h,
        totals: {
          volumeM3: totals.volumeM3,
          hoursOn: totals.hoursOn,
          triggers: totals.triggers,
          turnOns: totals.turnOns,
          avgEfficiency: totals.effCount > 0 ? totals.effSum / totals.effCount : null,
        },
      });
    })();
    return () => { cancelled = true; };
  }, [farmId, range.fromIso, range.toIso, pumpFilter]);

  return data;
}
