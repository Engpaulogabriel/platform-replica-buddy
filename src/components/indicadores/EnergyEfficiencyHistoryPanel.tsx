// Histórico detalhado de Eficiência Energética por dia.
// - Seletor de período: quick (7d/30d/60d/90d) OU intervalo custom por datas
// - Tabela com resumo diário (leitura direta de energy_efficiency_daily)
// - Ao clicar em um dia, expande o detalhamento por bomba (via get_energy_efficiency_pumps)
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, AlertTriangle, Clock, Zap, CircleCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type DayRow = {
  cycle_date: string;
  efficiency_percent: number | null;
  pumps_operated: number;
  post_peak_startup_time: string | null;
  pre_peak_shutdown_time: string | null;
  lost_minutes: number;
  pumps_on_during_peak: number;
  minutes_on_during_peak: number;
  pre_peak_ok_count: number;
  post_peak_ok_count: number;
  is_free_demand?: boolean;
};

type PumpRow = {
  equipment_id: string;
  equipment_name: string;
  first_on: string | null;
  late_min: number;
  last_off: string | null;
  early_off_min: number;
  mode: "remote" | "local";
  peak_minutes: number;
  post_status: "ok" | "late";
  pre_status: "ok" | "early";
  peak_violation: boolean;
};

export type HistRange = {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  quick: 7 | 30 | 60 | 90 | null; // null = custom
};

const MAX_DAYS = 365;

function safeToISOString(d: Date): string {
  try {
    if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function makeQuickRange(days: 7 | 30 | 60 | 90): HistRange {
  const today = new Date();
  const start = new Date(today.getTime() - (days - 1) * 86400_000);
  return { startDate: safeToISOString(start), endDate: safeToISOString(today), quick: days };
}

export const defaultHistRange: HistRange = makeQuickRange(30);

const fmtDate = (iso: string) => {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", weekday: "short" });
};
const fmtTime = (iso: string | null) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
};
const fmtMin = (m: number) => {
  if (!m) return "0 min";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}min`;
};

function effTone(eff: number | null) {
  if (eff == null) return "text-muted-foreground";
  if (eff >= 95) return "text-emerald-500";
  if (eff >= 80) return "text-amber-500";
  return "text-destructive";
}

interface Props {
  farmId: string | null;
  range?: HistRange;
  onRangeChange?: (r: HistRange) => void;
}

export function EnergyEfficiencyHistoryPanel({ farmId, range: rangeProp, onRangeChange }: Props) {
  const [internalRange, setInternalRange] = useState<HistRange>(defaultHistRange);
  const range = rangeProp ?? internalRange;
  const setRange = (r: HistRange) => {
    if (onRangeChange) onRangeChange(r);
    else setInternalRange(r);
  };

  const [days, setDays] = useState<DayRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pumpDetails, setPumpDetails] = useState<Record<string, PumpRow[]>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [activePumps, setActivePumps] = useState<number>(0);

  // Total dinâmico de bombas ATIVAS da fazenda (denominador da coluna "Atrasadas")
  useEffect(() => {
    if (!farmId) { setActivePumps(0); return; }
    let cancel = false;
    (async () => {
      const { count } = await supabase
        .from("equipments")
        .select("id", { count: "exact", head: true })
        .eq("farm_id", farmId)
        .eq("active", true)
        .in("type", ["poco", "bombeamento", "conjunto", "rio"] as any);
      if (!cancel) setActivePumps(count ?? 0);
    })();
    return () => { cancel = true; };
  }, [farmId]);

  // Valida datas + limita a 365 dias
  const { startDate, endDate, invalid } = useMemo(() => {
    let s = range.startDate;
    let e = range.endDate;
    if (!s || !e) return { startDate: s, endDate: e, invalid: true };
    if (s > e) return { startDate: s, endDate: e, invalid: true };
    // Cap 365 dias
    const sD = new Date(s + "T00:00:00");
    const eD = new Date(e + "T00:00:00");
    const diff = Math.floor((eD.getTime() - sD.getTime()) / 86400_000);
    if (diff > MAX_DAYS - 1) {
      const clamped = new Date(eD.getTime() - (MAX_DAYS - 1) * 86400_000);
      s = safeToISOString(clamped);
    }
    return { startDate: s, endDate: e, invalid: false };
  }, [range.startDate, range.endDate]);

  useEffect(() => {
    if (!farmId || invalid) { setDays([]); return; }
    let cancel = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("energy_efficiency_daily")
        .select("date, cycle_date, efficiency_percent, pumps_operated, post_peak_startup_time, pre_peak_shutdown_time, lost_minutes, pumps_on_during_peak, minutes_on_during_peak, pre_peak_ok_count, post_peak_ok_count, is_free_demand")
        .eq("farm_id", farmId)
        .gte("date", startDate)
        .lte("date", endDate)
        .order("date", { ascending: false });
      if (cancel) return;
      if (error) {
        console.error("history error", error);
        setDays([]);
      } else {
        const rows = (data ?? []) as Array<Record<string, any>>;
        setDays(rows.map(r => ({
          cycle_date: r.cycle_date ?? r.date,
          efficiency_percent: r.efficiency_percent,
          pumps_operated: r.pumps_operated ?? 0,
          post_peak_startup_time: r.post_peak_startup_time,
          pre_peak_shutdown_time: r.pre_peak_shutdown_time,
          lost_minutes: r.lost_minutes ?? 0,
          pumps_on_during_peak: r.pumps_on_during_peak ?? 0,
          minutes_on_during_peak: r.minutes_on_during_peak ?? 0,
          pre_peak_ok_count: r.pre_peak_ok_count ?? 0,
          post_peak_ok_count: r.post_peak_ok_count ?? 0,
          is_free_demand: r.is_free_demand ?? false,
        })));
      }
      setLoading(false);
    })();
    return () => { cancel = true; };
  }, [farmId, startDate, endDate, invalid]);

  const toggle = async (date: string) => {
    if (expanded === date) {
      setExpanded(null);
      return;
    }
    setExpanded(date);
    if (!pumpDetails[date] && farmId) {
      setDetailLoading(date);
      const { data, error } = await supabase.rpc("get_energy_efficiency_pumps", {
        _farm_id: farmId,
        _date: date,
      });
      if (error) console.error("pump detail error", error);
      setPumpDetails((prev) => ({ ...prev, [date]: (data as PumpRow[] | null) ?? [] }));
      setDetailLoading(null);
    }
  };

  const hasData = days.length > 0;

  const setQuick = (d: 7 | 30 | 60 | 90) => setRange(makeQuickRange(d));
  const setCustomStart = (v: string) => setRange({ startDate: v, endDate: range.endDate, quick: null });
  const setCustomEnd = (v: string) => setRange({ startDate: range.startDate, endDate: v, quick: null });

  const quickBtn = (d: 7 | 30 | 60 | 90, label: string) => {
    const active = range.quick === d;
    return (
      <button
        type="button"
        onClick={() => setQuick(d)}
        className={`px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors ${
          active
            ? "bg-primary text-primary-foreground border-primary"
            : "bg-background border-border text-foreground hover:bg-muted"
        }`}
      >
        {label}
      </button>
    );
  };

  const todayIso = safeToISOString(new Date());
  const totalDaysSelected = (() => {
    if (invalid) return 0;
    const sD = new Date(startDate + "T00:00:00");
    const eD = new Date(endDate + "T00:00:00");
    return Math.floor((eD.getTime() - sD.getTime()) / 86400_000) + 1;
  })();

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-2">
        <Clock className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Histórico detalhado</h2>
        <span className="text-xs text-muted-foreground ml-auto">Clique em um dia para ver as bombas</span>
      </header>

      {/* Seletor de período */}
      <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-x-4 gap-y-2 bg-muted/20">
        <div className="flex items-center gap-1.5">
          {quickBtn(7, "7d")}
          {quickBtn(30, "30d")}
          {quickBtn(60, "60d")}
          {quickBtn(90, "90d")}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-muted-foreground">Início:</label>
          <input
            type="date"
            value={range.startDate}
            max={range.endDate || todayIso}
            onChange={(e) => setCustomStart(e.target.value)}
            className="bg-background border border-border rounded-md px-2 py-1 text-foreground text-xs"
          />
          <label className="text-muted-foreground">Fim:</label>
          <input
            type="date"
            value={range.endDate}
            min={range.startDate}
            max={todayIso}
            onChange={(e) => setCustomEnd(e.target.value)}
            className="bg-background border border-border rounded-md px-2 py-1 text-foreground text-xs"
          />
        </div>
        <span className="text-[11px] text-muted-foreground ml-auto">
          {invalid ? (
            <span className="text-destructive">Intervalo inválido</span>
          ) : (
            <>
              {totalDaysSelected} dia(s) selecionados
              {totalDaysSelected >= MAX_DAYS && <span className="ml-1 text-amber-500">(máx. {MAX_DAYS})</span>}
            </>
          )}
        </span>
      </div>

      {loading && <div className="p-6 text-sm text-muted-foreground">Carregando histórico…</div>}
      {!loading && !hasData && (
        <div className="p-6 text-sm text-muted-foreground">Sem dados de eficiência no período selecionado.</div>
      )}

      {hasData && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 w-8"></th>
                <th className="text-left px-3 py-2">Data</th>
                <th className="text-right px-3 py-2">Eficiência</th>
                <th className="text-left  px-3 py-2">1ª bomba ligou</th>
                <th className="text-left  px-3 py-2">Últ. desligada</th>
                <th className="text-right px-3 py-2">Atrasadas</th>
                <th className="text-right px-3 py-2">Tempo perdido</th>
                <th className="text-right px-3 py-2">Ponta (18–21h)</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => {
                const isOpen = expanded === d.cycle_date;
                const lateCount = Math.max(0, d.pumps_operated - d.post_peak_ok_count);
                const isFree = !!d.is_free_demand;
                // Denominador dinâmico = bombas ATIVAS da fazenda (fallback: operadas no dia)
                const denom = activePumps > 0 ? activePumps : d.pumps_operated;
                // Cores: 0=verde, ≤N/3=laranja, >N/3=vermelho
                const displayLate = isFree ? 0 : lateCount;
                const lateColor = isFree
                  ? "text-emerald-500"
                  : displayLate === 0
                    ? "text-emerald-500"
                    : denom > 0 && displayLate <= denom / 3
                      ? "text-orange-500"
                      : "text-destructive";
                return (
                  <>
                    <tr
                      key={d.cycle_date}
                      className={`border-t border-border cursor-pointer hover:bg-muted/30 ${isFree ? "bg-muted/20" : ""}`}
                      onClick={() => toggle(d.cycle_date)}
                    >
                      <td className="px-3 py-2">
                        {isOpen ? (
                          <ChevronDown className="w-4 h-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        )}
                      </td>
                      <td className="px-3 py-2 font-medium text-foreground">
                        <div className="flex items-center gap-2">
                          <span>{fmtDate(d.cycle_date)}</span>
                          {isFree && (
                            <span
                              title="Sábado, domingo ou feriado nacional — sem horário de ponta"
                              className="inline-flex items-center rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400"
                            >
                              Livre
                            </span>
                          )}
                        </div>
                      </td>
                      <td className={`px-3 py-2 text-right font-semibold ${effTone(d.efficiency_percent)}`}>
                        {d.efficiency_percent != null ? `${Number(d.efficiency_percent).toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-3 py-2 text-foreground">{fmtTime(d.post_peak_startup_time)}</td>
                      <td className="px-3 py-2 text-foreground">
                        {isFree ? <span className="text-muted-foreground">—</span> : fmtTime(d.pre_peak_shutdown_time)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className={`font-medium ${lateColor}`}>
                          {displayLate}/{denom}
                        </span>
                      </td>

                      <td className="px-3 py-2 text-right text-foreground">{fmtMin(d.lost_minutes)}</td>
                      <td className="px-3 py-2 text-right">
                        {isFree ? (
                          <span className="text-muted-foreground text-xs" title="Demanda livre — sem horário de ponta">N/A</span>
                        ) : d.pumps_on_during_peak > 0 ? (
                          <span className="text-destructive font-medium">
                            {d.pumps_on_during_peak} · {fmtMin(d.minutes_on_during_peak)}
                          </span>
                        ) : (
                          <span className="text-emerald-500">OK</span>
                        )}
                      </td>
                    </tr>

                    {isOpen && (
                      <tr>
                        <td colSpan={8} className="bg-muted/10 px-4 py-4 border-t border-border">
                          {isFree ? (
                            <div className="text-sm text-muted-foreground py-2 flex items-center gap-2">
                              <CircleCheck className="w-4 h-4 text-emerald-500" />
                              Dia livre — sem obrigação de operação.
                              {d.pumps_operated > 0 && (
                                <span className="text-xs">
                                  {d.pumps_operated} bomba(s) operaram por escolha (informativo, sem penalidade).
                                </span>
                              )}
                            </div>
                          ) : (
                            <DayDetail
                              farmId={farmId}
                              date={d.cycle_date}
                              loading={detailLoading === d.cycle_date}
                              rows={pumpDetails[d.cycle_date] ?? []}
                            />
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DayDetail({ farmId, date, loading, rows }: { farmId: string; date: string; loading: boolean; rows: PumpRow[] }) {
  const late = useMemo(() => rows.filter((r) => r.post_status === "late"), [rows]);
  const preWindow = useMemo(
    () =>
      rows
        .filter((r) => r.last_off != null)
        .slice()
        .sort((a, b) => (a.last_off ?? "").localeCompare(b.last_off ?? "")),
    [rows],
  );
  const early = useMemo(() => preWindow.filter((r) => r.pre_status === "early"), [preWindow]);
  const peak = useMemo(() => rows.filter((r) => r.peak_violation), [rows]);

  const [peakMeta, setPeakMeta] = useState<Record<string, { entry: string; exit: string }>>({});

  useEffect(() => {
    if (!farmId || !date || peak.length === 0) return;
    const equipmentIds = peak.map((r) => r.equipment_id);
    const peakStart = new Date(`${date}T18:00:00`).toISOString();
    const peakEnd = new Date(`${date}T21:00:00`).toISOString();
    let cancel = false;
    (async () => {
      const { data, error } = await supabase
        .from("pump_runtime")
        .select("equipment_id, started_at, ended_at")
        .eq("farm_id", farmId)
        .in("equipment_id", equipmentIds)
        .lt("started_at", peakEnd)
        .or(`ended_at.gt.${peakStart},ended_at.is.null`);
      if (error) {
        console.error("peak meta error", error);
        return;
      }
      const nowIso = new Date().toISOString();
      const bounds: Record<string, { entry: string; exit: string }> = {};
      (data ?? []).forEach((s) => {
        const entry = s.started_at > peakStart ? s.started_at : peakStart;
        const exitRaw = s.ended_at ?? nowIso;
        const exit = exitRaw < peakEnd ? exitRaw : peakEnd;
        const b = bounds[s.equipment_id];
        if (!b) {
          bounds[s.equipment_id] = { entry, exit };
        } else {
          if (entry < b.entry) b.entry = entry;
          if (exit > b.exit) b.exit = exit;
        }
      });
      if (!cancel) setPeakMeta(bounds);
    })();
    return () => {
      cancel = true;
    };
  }, [farmId, date, peak.map((r) => r.equipment_id).sort().join(",")]);

  if (loading) return <div className="text-sm text-muted-foreground py-2">Carregando bombas…</div>;
  if (rows.length === 0) return <div className="text-sm text-muted-foreground py-2">Sem detalhes por bomba para este dia.</div>;


  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Religamento tardio */}
      <div className="rounded-lg border border-border bg-background/50 overflow-hidden">
        <div className="px-3 py-2 border-b border-border flex items-center gap-2 bg-amber-500/5">
          <Clock className="w-4 h-4 text-amber-500" />
          <h3 className="text-xs font-semibold uppercase text-amber-600 dark:text-amber-400">
            Religamento tardio · pós-ponta
          </h3>
          <span className="ml-auto text-xs text-muted-foreground">{late.length}</span>
        </div>
        {late.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground flex items-center gap-1">
            <CircleCheck className="w-3.5 h-3.5 text-emerald-500" /> Todas ligaram no horário
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-2 py-1">Bomba</th>
                <th className="text-left px-2 py-1">Ligou</th>
                <th className="text-right px-2 py-1">Atraso</th>
                <th className="text-left px-2 py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {late.map((r) => (
                <tr key={r.equipment_id} className="border-t border-border">
                  <td className="px-2 py-1.5 font-medium text-foreground">{r.equipment_name}</td>
                  <td className="px-2 py-1.5">{fmtTime(r.first_on)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <span className={r.late_min > 30 ? "text-destructive" : "text-amber-500"}>
                      {fmtMin(r.late_min)}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="text-amber-500">Atrasada</span>
                  </td>

                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pré-ponta — janela 16:00–18:00, referência 17:45 */}
      <div className="rounded-lg border border-border bg-background/50 overflow-hidden">
        <div className="px-3 py-2 border-b border-border flex items-center gap-2 bg-orange-500/5">
          <AlertTriangle className="w-4 h-4 text-orange-500" />
          <h3 className="text-xs font-semibold uppercase text-orange-600 dark:text-orange-400">
            Pré-ponta · desligamento 16:00–18:00
          </h3>
          <span className="ml-auto text-xs text-muted-foreground" title="Bombas com desligamento antecipado (antes de 17:45)">
            {early.length}
          </span>
        </div>
        {preWindow.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground flex items-center gap-1">
            <CircleCheck className="w-3.5 h-3.5 text-emerald-500" /> Nenhuma bomba desligou entre 16:00 e 18:00
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-2 py-1">Bomba</th>
                <th className="text-left px-2 py-1">Desligou</th>
                <th className="text-right px-2 py-1">Antecipação</th>
                <th className="text-left px-2 py-1">Status</th>
                <th className="text-left px-2 py-1">Modo</th>
              </tr>
            </thead>
            <tbody>
              {preWindow.map((r) => {
                const isEarly = r.pre_status === "early";
                return (
                  <tr key={r.equipment_id} className="border-t border-border">
                    <td className="px-2 py-1.5 font-medium text-foreground">{r.equipment_name}</td>
                    <td className="px-2 py-1.5 tabular-nums">{fmtTime(r.last_off)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${isEarly ? "text-orange-500" : "text-muted-foreground"}`}>
                      {isEarly ? fmtMin(r.early_off_min) : "—"}
                    </td>
                    <td className="px-2 py-1.5">
                      {isEarly ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-500/15 text-orange-500 border border-orange-500/30 uppercase">
                          Antecipado
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-500 border border-emerald-500/30 uppercase">
                          OK
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.mode === "local" ? (
                        <span className="text-destructive font-medium" title="Comandado localmente — verificar rádio">LOCAL</span>
                      ) : (
                        <span className="text-muted-foreground">Remoto</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>



      {/* Infrações na ponta */}
      <div className="rounded-lg border border-border bg-background/50 overflow-hidden">
        <div className="px-3 py-2 border-b border-border flex items-center gap-2 bg-destructive/5">
          <Zap className="w-4 h-4 text-destructive" />
          <h3 className="text-xs font-semibold uppercase text-destructive">
            Infrações na ponta · 18h–21h
          </h3>
          <span className="ml-auto text-xs text-muted-foreground">{peak.length}</span>
        </div>
        {peak.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground flex items-center gap-1">
            <CircleCheck className="w-3.5 h-3.5 text-emerald-500" /> Nenhuma bomba na ponta
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-2 py-1">Bomba</th>
                <th className="text-left px-2 py-1">Entrou na ponta</th>
                <th className="text-left px-2 py-1">Saiu da ponta</th>
                <th className="text-right px-2 py-1">Tempo na ponta</th>
                <th className="text-left px-2 py-1">Risco</th>
              </tr>
            </thead>
            <tbody>
              {peak.map((r) => {
                const meta = peakMeta[r.equipment_id];
                const risk = r.peak_minutes >= 31 ? "Alto" : r.peak_minutes >= 6 ? "Médio" : "Baixo";
                const tone =
                  r.peak_minutes >= 31 ? "text-destructive" : r.peak_minutes >= 6 ? "text-orange-500" : "text-amber-500";
                return (
                  <tr key={r.equipment_id} className="border-t border-border">
                    <td className="px-2 py-1.5 font-medium text-foreground">{r.equipment_name}</td>
                    <td className="px-2 py-1.5 tabular-nums">{meta ? fmtTime(meta.entry) : "—"}</td>
                    <td className="px-2 py-1.5 tabular-nums">{meta ? fmtTime(meta.exit) : "—"}</td>
                    <td className="px-2 py-1.5 text-right text-destructive font-medium">{fmtMin(r.peak_minutes)}</td>
                    <td className={`px-2 py-1.5 font-medium ${tone}`}>{risk}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
