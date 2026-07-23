// ─────────────────────────────────────────────────────────────────────────────
// useHorimetro — leitura real do horímetro a partir da tabela pump_runtime
// ─────────────────────────────────────────────────────────────────────────────
// Sessões são abertas/fechadas pelo trigger `track_pump_runtime` no banco
// sempre que `equipments.last_outputs_state` muda. As funções RPC
// `get_horimetro_daily` e `get_horimetro_month_total` somam essas sessões.

import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";

export interface HorimetroDailyRow {
  equipment_id: string;
  equipment_name: string;
  day: string; // YYYY-MM-DD
  hours: number;
}

export interface HorimetroByPump {
  equipmentId: string;
  pump: string;
  days: { day: string; hours: number }[];
  /** Total de horas no intervalo selecionado (filtros) */
  monthTotal: number;
  /** Total de horas no mês corrente (1º dia do mês até agora) */
  currentMonthTotal: number;
  /** Total de horas no ano corrente (1º de janeiro até agora) */
  yearTotal: number;
  /** Estado atual da bomba: true = ligada, false = desligada */
  isRunning: boolean;
  /** Origem da última atuação: 'remote' ou 'local' */
  actuationOrigin: "remote" | "local" | null;
  /** Timestamp da última comunicação */
  lastCommunication: string | null;
}

/** Formata YYYY-MM-DD → DD/MM */
function formatDayShort(iso: string): string {
  if (!iso) return iso;
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

function sumByEquipment(src: HorimetroDailyRow[]) {
  const m = new Map<string, number>();
  for (const r of src) {
    m.set(r.equipment_id, (m.get(r.equipment_id) ?? 0) + Number(r.hours));
  }
  return m;
}

type RuntimeRow = {
  equipment_id: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
};

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function aggregateRuntimeByDay(
  runtimes: RuntimeRow[],
  equipmentNameById: Map<string, string>,
  fromMs: number,
  toMs: number,
): HorimetroDailyRow[] {
  const grouped = new Map<string, HorimetroDailyRow>();

  for (const row of runtimes) {
    const sessionStart = Math.max(new Date(row.started_at).getTime(), fromMs);
    const sessionEnd = Math.min(row.ended_at ? new Date(row.ended_at).getTime() : Date.now(), toMs);
    if (!Number.isFinite(sessionStart) || !Number.isFinite(sessionEnd) || sessionEnd <= sessionStart) continue;

    let cursor = new Date(sessionStart);
    cursor.setHours(0, 0, 0, 0);
    while (cursor.getTime() <= sessionEnd) {
      const nextDay = new Date(cursor);
      nextDay.setDate(nextDay.getDate() + 1);
      const sliceStart = Math.max(sessionStart, cursor.getTime());
      const sliceEnd = Math.min(sessionEnd, nextDay.getTime() - 1);
      if (sliceEnd > sliceStart) {
        const day = ymd(cursor);
        const key = `${row.equipment_id}:${day}`;
        const current = grouped.get(key) ?? {
          equipment_id: row.equipment_id,
          equipment_name: equipmentNameById.get(row.equipment_id) ?? "Bomba",
          day,
          hours: 0,
        };
        current.hours += (sliceEnd - sliceStart) / 3600000;
        grouped.set(key, current);
      }
      cursor = nextDay;
    }
  }

  return Array.from(grouped.values())
    .map((row) => ({ ...row, hours: Math.round(row.hours * 100) / 100 }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.equipment_name.localeCompare(b.equipment_name));
}

/**
 * Carrega o horímetro real (horas/dia/bomba) entre duas datas.
 * Retorna agrupado por bomba para uso direto em tabelas/PDF/CSV.
 */
export function useHorimetro(args: { from: Date; to: Date; enabled?: boolean }) {
  const farmId = useDefaultFarmId();
  const enabled = args.enabled !== false;
  const [rows, setRows] = useState<HorimetroDailyRow[]>([]);
  const [equipments, setEquipments] = useState<Array<{
    id: string;
    name: string;
    last_outputs_state: string | null;
    last_actuation_origin: string | null;
    last_communication: string | null;
    saida: number | null;
  }>>([]);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fromIso = args.from.toISOString();
  const toIso = args.to.toISOString();

  const load = useCallback(async () => {
    if (!farmId || !enabled) return;
    setLoading(true);
    setHasLoaded(false);
    setError(null);

    const fromMs = args.from.getTime();
    const toMs = args.to.getTime();

    const runtimePromise = supabase
      .from("pump_runtime")
      .select("equipment_id, started_at, ended_at, duration_seconds")
      .eq("farm_id", farmId)
      .lte("started_at", toIso)
      .or(`ended_at.is.null,ended_at.gte.${fromIso}`)
      .order("created_at", { ascending: false })
      .limit(200);
    const eqPromise = supabase
      .from("equipments")
      .select("id, name, last_outputs_state, last_actuation_origin, last_communication, saida")
      .eq("farm_id", farmId)
      .in("type", ["poco", "bombeamento"]);

    try {
      const [runtimeRes, eqRes] = await Promise.all([runtimePromise, eqPromise]);

      const equipmentRows = !eqRes.error && eqRes.data ? eqRes.data : [];
      const equipmentNameById = new Map<string, string>(equipmentRows.map((eq) => [eq.id, eq.name]));

      if (runtimeRes.error) {
        setError(runtimeRes.error.message);
        setRows([]);
      } else {
        setRows(aggregateRuntimeByDay((runtimeRes.data ?? []) as RuntimeRow[], equipmentNameById, fromMs, toMs));
      }
      setEquipments(equipmentRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar horímetro");
      setRows([]);
    } finally {
      setHasLoaded(true);
      setLoading(false);
    }
  }, [farmId, fromIso, toIso, enabled]);

  useEffect(() => {
    if (!enabled || !farmId) {
      setRows([]);
      setEquipments([]);
      setLoading(false);
      setHasLoaded(false);
      setError(null);
      return;
    }
    void load();
  }, [load, enabled, farmId]);

  const periodTotals = useMemo(() => sumByEquipment(rows), [rows]);

  // Inclui todos os equipamentos do tipo bomba/poço (mesmo sem horas no período)
  const byPump: HorimetroByPump[] = useMemo(() => {
    const map = new Map<string, HorimetroByPump>();

    // Inicializa cada equipamento conhecido
    for (const eq of equipments) {
      const payload = eq.last_outputs_state ?? "";
      const saidaIndex = (eq.saida ?? 1) - 1;
      const isRunning = payload.length === 1
        ? payload === "1"
        : (payload[saidaIndex] === "1");
      map.set(eq.id, {
        equipmentId: eq.id,
        pump: eq.name,
        days: [],
        monthTotal: 0,
        currentMonthTotal: periodTotals.get(eq.id) ?? 0,
        yearTotal: periodTotals.get(eq.id) ?? 0,
        isRunning,
        actuationOrigin: (eq.last_actuation_origin as "remote" | "local" | null) ?? null,
        lastCommunication: eq.last_communication ?? null,
      });
    }

    // Adiciona dias do período
    for (const r of rows) {
      const cur = map.get(r.equipment_id);
      if (!cur) continue;
      cur.days.push({ day: formatDayShort(r.day), hours: Number(r.hours) });
      cur.monthTotal += Number(r.hours);
    }

    return Array.from(map.values()).map((p) => ({
      ...p,
      monthTotal: Math.round(p.monthTotal * 100) / 100,
      currentMonthTotal: Math.round(p.currentMonthTotal * 100) / 100,
      yearTotal: Math.round(p.yearTotal * 100) / 100,
    }));
  }, [equipments, periodTotals, rows]);

  // Série diária para gráfico (uma coluna por bomba)
  const chartData: Array<Record<string, string | number>> = useMemo(() => {
    const dayMap = new Map<string, Record<string, string | number>>();
    for (const r of rows) {
      const dayKey = formatDayShort(r.day);
      const entry = dayMap.get(dayKey) ?? { day: dayKey };
      entry[r.equipment_name] = Number(r.hours);
      dayMap.set(dayKey, entry);
    }
    const sorted = Array.from(dayMap.values()).sort((a, b) => String(a.day).localeCompare(String(b.day)));
    return sorted.length > 200 ? sorted.slice(-200) : sorted;
  }, [rows]);

  // Lista de bombas presentes no período (para legenda do gráfico)
  const pumpNames = useMemo(() => Array.from(new Set(rows.map((r) => r.equipment_name))), [rows]);

  return { byPump, chartData, pumpNames, loading, hasLoaded, error, reload: load, farmId };
}

/**
 * Total de horas no mês corrente para um único equipamento.
 * Usado no card "Horímetro Mês" do Dashboard.
 */
export function useHorimetroMonthTotal(equipmentId: string | null | undefined) {
  const farmId = useDefaultFarmId();
  const [hours, setHours] = useState<number | null>(null);

  useEffect(() => {
    if (!farmId || !equipmentId) {
      setHours(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc("get_horimetro_month_total", {
        _farm_id: farmId,
        _equipment_id: equipmentId,
      });
      if (cancelled) return;
      if (error) {
        setHours(null);
      } else {
        setHours(Number(data ?? 0));
      }
    })();
    return () => { cancelled = true; };
  }, [farmId, equipmentId]);

  return hours;
}
