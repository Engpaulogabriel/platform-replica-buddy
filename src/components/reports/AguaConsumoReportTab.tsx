import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, Download, Droplets, Loader2 } from "lucide-react";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";
import { supabase } from "@/integrations/supabase/client";
import { useHorimetro } from "@/hooks/useHorimetro";

interface AguaConsumoReportTabProps {
  farmId: string | null;
  fromDate: string;
  toDate: string;
  selectedPump: string;
}

type EqRow = { id: string; name: string; estimated_flow_m3h: number | null };

const PALETTE = ["#429350", "#3b82f6", "#f59e0b", "#a855f7", "#ef4444", "#06b6d4", "#84cc16", "#ec4899", "#0ea5e9", "#f97316"];

function formatHM(hoursDecimal: number): string {
  const total = Math.max(0, Math.round(hoursDecimal * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}min`;
}

function fmtM3(v: number): string {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function ymdToBR(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function AguaConsumoReportTab({ farmId, fromDate, toDate, selectedPump }: AguaConsumoReportTabProps) {
  const [equipments, setEquipments] = useState<EqRow[]>([]);
  const [renderReady, setRenderReady] = useState(false);

  const range = useMemo(() => ({
    from: new Date(`${fromDate}T00:00:00`),
    to: new Date(`${toDate}T23:59:59.999`),
  }), [fromDate, toDate]);

  const today = useMemo(() => ({
    from: new Date(`${todayIso()}T00:00:00`),
    to: new Date(`${todayIso()}T23:59:59.999`),
  }), []);

  const last7 = useMemo(() => {
    const t = new Date(); t.setHours(23, 59, 59, 999);
    const f = new Date(t); f.setDate(f.getDate() - 6); f.setHours(0, 0, 0, 0);
    return { from: f, to: t };
  }, []);

  const last30 = useMemo(() => {
    const t = new Date(); t.setHours(23, 59, 59, 999);
    const f = new Date(t); f.setDate(f.getDate() - 29); f.setHours(0, 0, 0, 0);
    return { from: f, to: t };
  }, []);

  const horimetroRange = useHorimetro({ ...range, enabled: renderReady });
  const horimetroToday = useHorimetro({ ...today, enabled: renderReady });
  const horimetro7 = useHorimetro({ ...last7, enabled: renderReady });
  const horimetro30 = useHorimetro({ ...last30, enabled: renderReady });

  useEffect(() => {
    setRenderReady(false);
    const id = window.setTimeout(() => setRenderReady(true), 0);
    return () => window.clearTimeout(id);
  }, [farmId, fromDate, toDate]);

  useEffect(() => {
    if (!renderReady || !farmId) { setEquipments([]); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("equipments")
        .select("id, name, estimated_flow_m3h")
        .eq("farm_id", farmId)
        .in("type", ["poco", "bombeamento"]);
      if (cancelled) return;
      setEquipments(((data ?? []) as EqRow[]).sort((a, b) => a.name.localeCompare(b.name)));
    })();
    return () => { cancelled = true; };
  }, [farmId, renderReady]);

  const flowById = useMemo(() => {
    const m = new Map<string, number | null>();
    equipments.forEach((e) => m.set(e.id, e.estimated_flow_m3h == null ? null : Number(e.estimated_flow_m3h)));
    return m;
  }, [equipments]);

  const visibleEquipments = useMemo(() => {
    if (selectedPump === "all") return equipments;
    return equipments.filter((e) => e.name === selectedPump);
  }, [equipments, selectedPump]);

  // SECTION 1: hoje
  const todayRows = useMemo(() => {
    return visibleEquipments.map((eq) => {
      const p = horimetroToday.byPump.find((x) => x.equipmentId === eq.id);
      const hours = p?.monthTotal ?? 0;
      const flow = flowById.get(eq.id) ?? null;
      const m3 = flow == null ? null : hours * flow;
      return { id: eq.id, name: eq.name, hours, flow, m3 };
    });
  }, [visibleEquipments, horimetroToday.byPump, flowById]);

  const todayTotalM3 = todayRows.reduce((s, r) => s + (r.m3 ?? 0), 0);
  const todayTotalHours = todayRows.reduce((s, r) => s + r.hours, 0);

  // SECTION 2: gráfico 7 dias empilhado por bomba
  const chart7 = useMemo(() => {
    const dayMap = new Map<string, Record<string, number | string>>();
    for (const eq of visibleEquipments) {
      const flow = flowById.get(eq.id);
      if (!flow) continue;
      const series = horimetro7.byPump.find((x) => x.equipmentId === eq.id);
      if (!series) continue;
      for (const d of series.days) {
        const entry = dayMap.get(d.day) ?? { day: d.day };
        entry[eq.name] = Number(((d.hours * flow)).toFixed(2));
        dayMap.set(d.day, entry);
      }
    }
    return Array.from(dayMap.values()).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }, [horimetro7.byPump, visibleEquipments, flowById]);

  const chart7Names = useMemo(() => {
    const s = new Set<string>();
    chart7.forEach((row) => Object.keys(row).forEach((k) => k !== "day" && s.add(k)));
    return Array.from(s);
  }, [chart7]);

  // SECTION 3: gráfico 30 dias - total fazenda
  const chart30 = useMemo(() => {
    const dayMap = new Map<string, number>();
    for (const eq of visibleEquipments) {
      const flow = flowById.get(eq.id);
      if (!flow) continue;
      const series = horimetro30.byPump.find((x) => x.equipmentId === eq.id);
      if (!series) continue;
      for (const d of series.days) {
        dayMap.set(d.day, (dayMap.get(d.day) ?? 0) + d.hours * flow);
      }
    }
    const arr = Array.from(dayMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, m3]) => ({ day, m3: Number(m3.toFixed(2)) }));
    const avg = arr.length ? arr.reduce((s, r) => s + r.m3, 0) / arr.length : 0;
    return arr.map((r) => ({ ...r, media: Number(avg.toFixed(2)) }));
  }, [horimetro30.byPump, visibleEquipments, flowById]);

  // SECTION 4: histórico (intervalo selecionado)
  const historyRows = useMemo(() => {
    const rows: Array<{ day: string; eqName: string; hours: number; flow: number | null; m3: number | null }> = [];
    for (const eq of visibleEquipments) {
      const flow = flowById.get(eq.id) ?? null;
      const series = horimetroRange.byPump.find((x) => x.equipmentId === eq.id);
      if (!series) continue;
      for (const d of series.days) {
        rows.push({
          day: d.day,
          eqName: eq.name,
          hours: d.hours,
          flow,
          m3: flow == null ? null : d.hours * flow,
        });
      }
    }
    return rows.sort((a, b) => b.day.localeCompare(a.day) || a.eqName.localeCompare(b.eqName));
  }, [horimetroRange.byPump, visibleEquipments, flowById]);

  const historyTotalM3 = historyRows.reduce((s, r) => s + (r.m3 ?? 0), 0);

  const loading = horimetroRange.loading || horimetroToday.loading || horimetro7.loading || horimetro30.loading;

  const exportCSV = () => {
    const header = ["Data", "Equipamento", "Tempo Ligado (h)", "Vazão Estimada (m³/h)", "Consumo Estimado (m³)"];
    const rows = historyRows.map((r) => [
      r.day,
      r.eqName,
      r.hours.toFixed(2),
      r.flow == null ? "—" : r.flow.toString(),
      r.m3 == null ? "—" : r.m3.toFixed(2),
    ]);
    const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vazao-consumo_${fromDate}_${toDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!renderReady || loading) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-3">Calculando consumo de água…</span>
      </div>
    );
  }

  const missingFlow = equipments.some((e) => e.estimated_flow_m3h == null);

  return (
    <PageErrorBoundary>
      <div className="space-y-6">
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Valores estimados a partir da vazão configurada por equipamento e do tempo de operação real.
            Para medição precisa, instale sensores de vazão. {missingFlow && (
              <strong>Há equipamentos sem vazão estimada cadastrada — configure em Cadastros.</strong>
            )}
          </span>
        </div>

        {/* SECTION 1 - Resumo do Dia */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Droplets className="w-5 h-5 text-primary" />
              Consumo Estimado — Hoje ({ymdToBR(todayIso())})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-md border border-border bg-secondary p-3">
                <div className="text-xs text-muted-foreground">Total estimado hoje</div>
                <div className="text-2xl font-bold text-primary">{fmtM3(todayTotalM3)} m³</div>
              </div>
              <div className="rounded-md border border-border bg-secondary p-3">
                <div className="text-xs text-muted-foreground">Tempo total de operação</div>
                <div className="text-2xl font-bold text-foreground">{formatHM(todayTotalHours)}</div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Equipamento</TableHead>
                    <TableHead className="text-right">Vazão Est.</TableHead>
                    <TableHead className="text-right">Tempo Ligado</TableHead>
                    <TableHead className="text-right">Consumo Est.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {todayRows.length === 0 && (
                    <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Nenhum equipamento</TableCell></TableRow>
                  )}
                  {todayRows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="text-right">
                        {r.flow == null
                          ? <span className="text-muted-foreground">— configurar</span>
                          : `${r.flow.toLocaleString("pt-BR")} m³/h`}
                      </TableCell>
                      <TableCell className="text-right">{formatHM(r.hours)}</TableCell>
                      <TableCell className="text-right font-semibold">
                        {r.m3 == null ? "—" : `${fmtM3(r.m3)} m³`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* SECTION 2 - Gráfico Semanal */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base">Consumo Diário — Últimos 7 dias (m³)</CardTitle>
          </CardHeader>
          <CardContent>
            {chart7.length === 0 ? (
              <div className="text-center text-sm text-muted-foreground py-10">Sem dados no período.</div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={chart7}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} unit=" m³" />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                  <Legend />
                  {chart7Names.map((name, i) => (
                    <Bar key={name} dataKey={name} stackId="a" fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* SECTION 3 - Gráfico Mensal */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base">Consumo Total da Fazenda — Últimos 30 dias (m³)</CardTitle>
          </CardHeader>
          <CardContent>
            {chart30.length === 0 ? (
              <div className="text-center text-sm text-muted-foreground py-10">Sem dados no período.</div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chart30}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} unit=" m³" />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                  <Legend />
                  <Line type="monotone" dataKey="m3" name="Consumo (m³)" stroke="#429350" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="media" name="Média" stroke="#f59e0b" strokeDasharray="5 5" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* SECTION 4 - Histórico */}
        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">Histórico Detalhado ({ymdToBR(fromDate)} → {ymdToBR(toDate)})</CardTitle>
            <Button variant="outline" size="sm" onClick={exportCSV} className="gap-2">
              <Download className="w-4 h-4" /> CSV
            </Button>
          </CardHeader>
          <CardContent>
            <div className="mb-3 text-sm text-muted-foreground">
              Total no período: <strong className="text-foreground">{fmtM3(historyTotalM3)} m³</strong>
              {" · "}{historyRows.length} registros
            </div>
            <div className="overflow-x-auto max-h-[500px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Equipamento</TableHead>
                    <TableHead className="text-right">Tempo Ligado</TableHead>
                    <TableHead className="text-right">Vazão Est.</TableHead>
                    <TableHead className="text-right">Consumo Est.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {historyRows.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Sem registros no período.</TableCell></TableRow>
                  )}
                  {historyRows.slice(0, 500).map((r, idx) => (
                    <TableRow key={`${r.day}-${r.eqName}-${idx}`}>
                      <TableCell>{r.day}</TableCell>
                      <TableCell>{r.eqName}</TableCell>
                      <TableCell className="text-right">{formatHM(r.hours)}</TableCell>
                      <TableCell className="text-right">
                        {r.flow == null ? <span className="text-muted-foreground">—</span> : `${r.flow.toLocaleString("pt-BR")} m³/h`}
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {r.m3 == null ? "—" : `${fmtM3(r.m3)} m³`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {historyRows.length > 500 && (
                <div className="text-xs text-muted-foreground mt-2 text-center">
                  Exibindo 500 de {historyRows.length}. Exporte CSV para o histórico completo.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </PageErrorBoundary>
  );
}
