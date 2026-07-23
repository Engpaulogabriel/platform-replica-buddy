// Relatório de Demanda (kW) — pico de potência simultânea por dia.
// Fonte: pump_runtime (intervalos liga/desliga) × equipments.power_kw.
// Filtra estritamente por farm_id ativo.
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LineChart, Line, ReferenceLine, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Zap, Download, FileSpreadsheet, AlertTriangle, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { notifyReport } from "@/lib/notify";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

interface Props {
  farmId: string | null;
  fromDate: string; // YYYY-MM-DD
  toDate: string;   // YYYY-MM-DD
}

interface DayPeak {
  day: string;            // YYYY-MM-DD
  peakKw: number;
  pumpsAtPeak: number;
  totalPumps: number;
}

type DemandEquipment = { id: string; name: string; power_kw: number | null; demanda_kw: number | null; active: boolean };
type RuntimeRow = { equipment_id: string; started_at: string; ended_at: string | null };

function powerOf(e: { demanda_kw: number | null; power_kw: number | null }): number {
  const d = Number(e.demanda_kw ?? 0);
  return d > 0 ? d : Number(e.power_kw ?? 0);
}

function fmtBR(d: string) {
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}

export default function DemandReportTab({ farmId, fromDate, toDate }: Props) {
  const [equipments, setEquipments] = useState<DemandEquipment[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeRow[]>([]);
  const [contractedKw, setContractedKw] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [renderReady, setRenderReady] = useState(false);

  useEffect(() => {
    setRenderReady(false);
    setHasLoaded(false);
    const id = window.setTimeout(() => setRenderReady(true), 0);
    return () => window.clearTimeout(id);
  }, [farmId, fromDate, toDate]);

  // 1) Carrega equipamentos (potência) e demanda contratada.
  useEffect(() => {
    if (!renderReady || !farmId) {
      setEquipments([]);
      setContractedKw(0);
      return;
    }
    let cancelled = false;
    (async () => {
      const [eqRes, cfgRes] = await Promise.all([
        supabase
          .from("equipments")
          .select("id, name, power_kw, demanda_kw, active, type")
          .eq("farm_id", farmId)
          .in("type", ["poco", "bombeamento"]),
        supabase
          .from("farm_productivity_config")
          .select("contracted_demand_kw")
          .eq("farm_id", farmId)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      setEquipments((eqRes.data ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        power_kw: e.power_kw,
        demanda_kw: e.demanda_kw,
        active: Boolean(e.active),
      })));
      setContractedKw(Number(cfgRes.data?.contracted_demand_kw ?? 0));
    })();
    return () => { cancelled = true; };
  }, [farmId, renderReady]);

  // 2) Carrega runtimes que sobrepõem o período.
  useEffect(() => {
    if (!renderReady || !farmId) {
      setRuntimes([]);
      setLoading(false);
      setHasLoaded(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setHasLoaded(false);
    (async () => {
      const fromIso = new Date(`${fromDate}T00:00:00`).toISOString();
      const toIso = new Date(`${toDate}T23:59:59.999`).toISOString();
      // Sobreposição: started_at <= toIso AND (ended_at IS NULL OR ended_at >= fromIso)
      const { data, error } = await supabase
        .from("pump_runtime")
        .select("equipment_id, started_at, ended_at")
        .eq("farm_id", farmId)
        .lte("started_at", toIso)
        .or(`ended_at.is.null,ended_at.gte.${fromIso}`)
        .order("started_at", { ascending: false })
        .limit(200);
      if (!cancelled) {
        setRuntimes(error ? [] : (data ?? []));
        setHasLoaded(true);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [farmId, fromDate, toDate, renderReady]);

  const powerById = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of equipments) m.set(e.id, powerOf(e));
    return m;
  }, [equipments]);

  const installedKw = useMemo(
    () => equipments.filter((e) => e.active).reduce((s, e) => s + powerOf(e), 0),
    [equipments]
  );

  // 3) Calcula pico de demanda por dia via sweep-line (eventos +/- por bomba).
  const dailyPeaks: DayPeak[] = useMemo(() => {
    if (!runtimes.length) return [];
    const from = new Date(`${fromDate}T00:00:00`);
    const to = new Date(`${toDate}T23:59:59.999`);

    // Agrupa eventos por dia (recorta cada intervalo nos limites do dia).
    const eventsByDay = new Map<string, Array<{ t: number; delta: number; eqId: string }>>();
    const dayStart = new Date(from);
    dayStart.setHours(0, 0, 0, 0);

    for (let d = new Date(dayStart); d <= to; d.setDate(d.getDate() + 1)) {
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      eventsByDay.set(dayKey, []);
    }

    for (const r of runtimes) {
      const power = powerById.get(r.equipment_id) ?? 0;
      if (power <= 0) continue;
      const start = new Date(r.started_at);
      const end = r.ended_at ? new Date(r.ended_at) : new Date();

      // Itera por cada dia coberto pelo intervalo.
      const segStart = start < from ? from : start;
      const segEnd = end > to ? to : end;
      if (segEnd <= segStart) continue;

      const cursor = new Date(segStart);
      cursor.setHours(0, 0, 0, 0);
      while (cursor <= segEnd) {
        const dayKey = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
        const dayEnd = new Date(cursor); dayEnd.setHours(23, 59, 59, 999);
        const sliceStart = segStart > cursor ? segStart : cursor;
        const sliceEnd = segEnd < dayEnd ? segEnd : dayEnd;
        if (sliceEnd > sliceStart) {
          const arr = eventsByDay.get(dayKey);
          if (arr) {
            arr.push({ t: sliceStart.getTime(), delta: +power, eqId: r.equipment_id });
            arr.push({ t: sliceEnd.getTime(), delta: -power, eqId: r.equipment_id });
          }
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    const totalActive = equipments.filter((e) => e.active && powerOf(e) > 0).length;
    const result: DayPeak[] = [];
    for (const [day, evts] of eventsByDay) {
      if (!evts.length) {
        result.push({ day, peakKw: 0, pumpsAtPeak: 0, totalPumps: totalActive });
        continue;
      }
      // Ordena: starts antes de ends no mesmo timestamp para pegar pico real.
      evts.sort((a, b) => a.t - b.t || b.delta - a.delta);
      let running = 0;
      let peak = 0;
      let pumpsAtPeak = 0;
      const active = new Set<string>();
      for (const ev of evts) {
        if (ev.delta > 0) active.add(ev.eqId);
        else active.delete(ev.eqId);
        running += ev.delta;
        if (running > peak) {
          peak = running;
          pumpsAtPeak = active.size;
        }
      }
      result.push({ day, peakKw: Math.round(peak * 10) / 10, pumpsAtPeak, totalPumps: totalActive });
    }
    return result.sort((a, b) => a.day.localeCompare(b.day));
  }, [runtimes, powerById, equipments, fromDate, toDate]);

  const periodPeak = useMemo(
    () => dailyPeaks.reduce((m, d) => Math.max(m, d.peakKw), 0),
    [dailyPeaks]
  );
  const dailyPeaksDescending = useMemo(() => [...dailyPeaks].reverse(), [dailyPeaks]);
  const margin = contractedKw > 0 ? contractedKw - periodPeak : 0;

  function statusOf(peak: number): { label: string; cls: string } {
    if (contractedKw <= 0) return { label: "—", cls: "bg-secondary text-muted-foreground" };
    const pct = peak / contractedKw;
    if (pct >= 1) return { label: "ULTRAPASSAGEM", cls: "bg-destructive/15 text-destructive border border-destructive/40" };
    if (pct >= 0.8) return { label: "Atenção", cls: "bg-warning/15 text-warning border border-warning/40" };
    return { label: "OK", cls: "bg-success/15 text-success border border-success/40" };
  }

  if (!renderReady || loading || !hasLoaded) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-3">Carregando demanda...</span>
      </div>
    );
  }

  function exportCsv() {
    const head = ["Data", "Demanda Pico (kW)", "Bombas no Pico", "% da Contratada", "Status"];
    const lines = dailyPeaks.map((d) => {
      const pct = contractedKw > 0 ? `${((d.peakKw / contractedKw) * 100).toFixed(1)}%` : "—";
      return [fmtBR(d.day), d.peakKw.toFixed(1), `${d.pumpsAtPeak}/${d.totalPumps}`, pct, statusOf(d.peakKw).label];
    });
    const csv = [head, ...lines].map((r) => r.join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `relatorio-demanda-${fromDate}_${toDate}.csv`; a.click();
    URL.revokeObjectURL(url);
    notifyReport.exported("CSV", "Demanda");
  }

  function exportPdf() {
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const w = doc.internal.pageSize.getWidth();
    doc.setFillColor(66, 147, 80);
    doc.rect(0, 0, w, 50, "F");
    doc.setTextColor(255); doc.setFontSize(16); doc.setFont("helvetica", "bold");
    doc.text("Relatório de Demanda de Energia (kW)", 30, 22);
    doc.setFontSize(10); doc.setFont("helvetica", "normal");
    doc.text(`Período: ${fmtBR(fromDate)} a ${fmtBR(toDate)}`, 30, 38);
    doc.setTextColor(0);
    doc.setFontSize(10);
    doc.text(
      `Demanda máx no período: ${periodPeak.toFixed(1)} kW  |  Contratada: ${contractedKw > 0 ? contractedKw.toFixed(1) + " kW" : "não configurada"}  |  Margem mín: ${contractedKw > 0 ? margin.toFixed(1) + " kW" : "—"}  |  Instalada: ${installedKw.toFixed(1)} kW`,
      30, 70
    );
    autoTable(doc, {
      startY: 85,
      head: [["Data", "Pico (kW)", "Bombas no Pico", "% Contratada", "Status"]],
      body: dailyPeaks.map((d) => [
        fmtBR(d.day),
        d.peakKw.toFixed(1),
        `${d.pumpsAtPeak}/${d.totalPumps}`,
        contractedKw > 0 ? `${((d.peakKw / contractedKw) * 100).toFixed(1)}%` : "—",
        statusOf(d.peakKw).label,
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [66, 147, 80], textColor: 255 },
      alternateRowStyles: { fillColor: [245, 245, 245] },
    });
    doc.save(`relatorio-demanda-${fromDate}_${toDate}.pdf`);
    notifyReport.exported("PDF", "Demanda");
  }

  return (
    <div className="space-y-4">
      {/* Cards resumo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Demanda Máxima no Período" value={`${periodPeak.toFixed(1)} kW`} tone="primary" />
        <SummaryCard
          label="Demanda Contratada"
          value={contractedKw > 0 ? `${contractedKw.toFixed(1)} kW` : "Não configurada"}
          tone={contractedKw > 0 ? "default" : "muted"}
        />
        <SummaryCard
          label="Margem Mínima"
          value={contractedKw > 0 ? `${margin.toFixed(1)} kW` : "—"}
          tone={margin < 0 ? "danger" : "success"}
          hint={margin < 0 ? "Ultrapassou a contratada" : undefined}
        />
        <SummaryCard label="Potência Instalada" value={`${installedKw.toFixed(1)} kW`} tone="default" />
      </div>

      {/* Gráfico */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2 flex-row items-center justify-between">
          <CardTitle className="text-base text-foreground flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" /> Demanda Máxima por Dia (kW)
          </CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={!dailyPeaks.length}>
              <FileSpreadsheet className="w-4 h-4 mr-1" /> CSV
            </Button>
            <Button size="sm" onClick={exportPdf} disabled={!dailyPeaks.length}>
              <Download className="w-4 h-4 mr-1" /> PDF
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {contractedKw <= 0 && (
            <div className="mb-3 text-xs text-muted-foreground flex items-center gap-2 p-2 rounded-md bg-warning/5 border border-warning/20">
              <AlertTriangle className="w-4 h-4 text-warning" />
              Configure a <strong>demanda contratada</strong> em Demanda de Energia para habilitar o limite no gráfico e o cálculo de margem.
            </div>
          )}
          {loading ? (
            <div className="py-6 text-center text-xs text-muted-foreground">Carregando…</div>

          ) : (
            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={dailyPeaks}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} tickFormatter={(d) => fmtBR(d).slice(0, 5)} />
                  <YAxis tick={{ fontSize: 10 }} unit=" kW" />
                  <Tooltip
                    contentStyle={{ fontSize: 12 }}
                    labelFormatter={(d) => fmtBR(String(d))}
                    formatter={(v: number) => [`${v.toFixed(1)} kW`, "Pico"]}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {contractedKw > 0 && (
                    <ReferenceLine
                      y={contractedKw}
                      stroke="hsl(var(--destructive))"
                      strokeDasharray="4 4"
                      label={{ value: `Contratada ${contractedKw} kW`, position: "insideTopRight", fill: "hsl(var(--destructive))", fontSize: 11 }}
                    />
                  )}
                  <Line type="monotone" dataKey="peakKw" name="Demanda Pico (kW)" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tabela */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-foreground">Detalhamento Diário</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead className="text-right">Demanda Pico (kW)</TableHead>
                <TableHead className="text-center">Bombas no Pico</TableHead>
                <TableHead className="text-right">% da Contratada</TableHead>
                <TableHead className="text-center">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dailyPeaks.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                    {loading ? "Calculando demanda..." : "Sem registros de operação no período."}
                  </TableCell>
                </TableRow>
              )}
              {dailyPeaksDescending.map((d) => {
                const st = statusOf(d.peakKw);
                const pct = contractedKw > 0 ? (d.peakKw / contractedKw) * 100 : 0;
                return (
                  <TableRow key={d.day}>
                    <TableCell className="font-medium">{fmtBR(d.day)}</TableCell>
                    <TableCell className="text-right tabular-nums">{d.peakKw.toFixed(1)} kW</TableCell>
                    <TableCell className="text-center tabular-nums">{d.pumpsAtPeak}/{d.totalPumps}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {contractedKw > 0 ? `${pct.toFixed(1)}%` : "—"}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge className={`${st.cls} text-[11px]`} variant="outline">{st.label}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ label, value, tone = "default", hint }: { label: string; value: string; tone?: "default" | "primary" | "muted" | "danger" | "success"; hint?: string }) {
  const tones: Record<string, string> = {
    default: "text-foreground",
    primary: "text-primary",
    muted: "text-muted-foreground",
    danger: "text-destructive",
    success: "text-success",
  };
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">{label}</p>
        <p className={`text-2xl font-bold leading-tight ${tones[tone]}`}>{value}</p>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  );
}
