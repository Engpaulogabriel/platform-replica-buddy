import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Download, FileText, Loader2 } from "lucide-react";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";
import { supabase } from "@/integrations/supabase/client";
import { useHorimetro } from "@/hooks/useHorimetro";
import { exportDemandaCSV, exportDemandaPDF, type DemandReportRow } from "@/lib/reportExport";
import { notifyReport } from "@/lib/notify";

interface ConsumoReportTabProps {
  farmId: string | null;
  fromDate: string;
  toDate: string;
  selectedPump: string;
}

type PumpPowerRow = { id: string; name: string; demanda_kw: number | null; power_kw: number | null };

function formatHM(hoursDecimal: number): string {
  const totalMinutes = Math.max(0, Math.round(hoursDecimal * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}min`;
}

export default function ConsumoReportTab({ farmId, fromDate, toDate, selectedPump }: ConsumoReportTabProps) {
  const [pumpPowers, setPumpPowers] = useState<Array<{ id: string; name: string; powerKw: number }>>([]);
  const [farmHeader, setFarmHeader] = useState<{ name: string; city: string | null; state: string | null }>({ name: "Fazenda", city: null, state: null });
  const [renderReady, setRenderReady] = useState(false);
  const range = useMemo(() => ({
    from: new Date(`${fromDate}T00:00:00`),
    to: new Date(`${toDate}T23:59:59.999`),
  }), [fromDate, toDate]);
  const horimetro = useHorimetro({ ...range, enabled: renderReady });

  useEffect(() => {
    setRenderReady(false);
    const id = window.setTimeout(() => setRenderReady(true), 0);
    return () => window.clearTimeout(id);
  }, [farmId, fromDate, toDate]);

  useEffect(() => {
    if (!renderReady || !farmId) { setPumpPowers([]); return; }
    let cancelled = false;
    (async () => {
      const [{ data: eqs }, { data: farm }] = await Promise.all([
        supabase
          .from("equipments")
          .select("id, name, demanda_kw, power_kw")
          .eq("farm_id", farmId)
          .in("type", ["poco", "bombeamento"]),
        supabase
          .from("farms")
          .select("name, city, state")
          .eq("id", farmId)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      setPumpPowers(((eqs ?? []) as PumpPowerRow[]).map((e) => {
        const d = Number(e.demanda_kw ?? 0);
        const powerKw = d > 0 ? d : Number(e.power_kw ?? 0);
        return { id: e.id, name: e.name, powerKw };
      }));
      if (farm) setFarmHeader({ name: farm.name ?? "Fazenda", city: farm.city ?? null, state: farm.state ?? null });
    })();
    return () => { cancelled = true; };
  }, [farmId, renderReady]);

  const filteredHorimetro = useMemo(() => {
    if (selectedPump === "all") return horimetro.byPump;
    return horimetro.byPump.filter((p) => p.pump === selectedPump);
  }, [horimetro.byPump, selectedPump]);

  const demandDailyData: DemandReportRow[] = useMemo(() => {
    const rows: DemandReportRow[] = [];
    for (const p of filteredHorimetro) {
      const power = pumpPowers.find((pp) => pp.id === p.equipmentId)?.powerKw ?? 0;
      for (const d of p.days) {
        if (d.hours <= 0) continue;
        rows.push({
          date: d.day,
          pump: p.pump,
          powerKw: power,
          hoursOn: Math.round(d.hours * 100) / 100,
          consumptionKwh: Math.round(power * d.hours * 100) / 100,
        });
      }
    }
    return rows;
  }, [filteredHorimetro, pumpPowers]);

  const demandChartData = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of demandDailyData) {
      m.set(r.date, (m.get(r.date) ?? 0) + r.consumptionKwh);
    }
    return Array.from(m.entries())
      .map(([day, total]) => ({ day, total: Math.round(total) }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }, [demandDailyData]);

  const totalKwh = useMemo(
    () => demandDailyData.reduce((s, r) => s + r.consumptionKwh, 0),
    [demandDailyData]
  );

  const installedPowerKw = useMemo(
    () => pumpPowers.reduce((s, p) => s + p.powerKw, 0),
    [pumpPowers]
  );

  const demandSummary = useMemo(() => ({
    contractedDemand: 0,
    unit: "kW",
    totalKwh,
    period: `${fromDate.split("-").reverse().join("/")} a ${toDate.split("-").reverse().join("/")}`,
  }), [totalKwh, fromDate, toDate]);

  if (!renderReady || horimetro.loading || !horimetro.hasLoaded) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-3">Carregando consumo...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-foreground">Consumo Diário (kWh)</CardTitle>
        </CardHeader>
        <CardContent>
          {horimetro.loading ? (
            <div className="h-[280px] rounded-lg bg-secondary/70 animate-pulse" />
          ) : (
            <PageErrorBoundary pageName="gráfico de consumo">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={demandChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} unit=" kWh" />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", color: "hsl(var(--foreground))" }}
                    formatter={(value: number) => [`${value} kWh`, "Consumo"]}
                  />
                  <Bar dataKey="total" name="Consumo Total" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </PageErrorBoundary>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">Consumo Total no Período</p>
            <p className="text-xl font-bold text-foreground">{totalKwh.toFixed(0)} kWh</p>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">Potência Total Instalada</p>
            <p className="text-xl font-bold text-foreground">
              {installedPowerKw.toFixed(0)} kW
            </p>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">Média Diária</p>
            <p className="text-xl font-bold text-foreground">
              {demandChartData.length > 0
                ? (totalKwh / demandChartData.length).toFixed(0)
                : "0"} kWh
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base text-foreground">Detalhamento por Bomba</CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="border-border text-muted-foreground gap-1" onClick={() => { exportDemandaCSV(demandDailyData, demandSummary); notifyReport.exported("CSV", "Consumo"); }}>
                <Download className="w-3.5 h-3.5" /> CSV
              </Button>
              <Button variant="outline" size="sm" className="border-border text-muted-foreground gap-1" onClick={() => { exportDemandaPDF(demandDailyData, demandSummary, farmHeader); notifyReport.exported("PDF", "Consumo"); }}>
                <FileText className="w-3.5 h-3.5" /> PDF
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-secondary/50">
                <TableHead className="text-muted-foreground">Data</TableHead>
                <TableHead className="text-muted-foreground">Equipamento</TableHead>
                <TableHead className="text-muted-foreground text-right">Potência (kW)</TableHead>
                <TableHead className="text-muted-foreground text-right">Horas Ligada</TableHead>
                <TableHead className="text-muted-foreground text-right">Consumo (kWh)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {demandDailyData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    Sem registros de operação no período. Cadastre a potência (kW) das bombas em Cadastros para que o consumo seja calculado automaticamente a partir das horas reais ligadas.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {demandDailyData.map((item, i) => (
                    <TableRow key={i} className="border-border hover:bg-secondary/50">
                      <TableCell className="text-foreground text-sm">{item.date}</TableCell>
                      <TableCell className="text-foreground font-medium">{item.pump}</TableCell>
                      <TableCell className="text-foreground text-sm text-right">{item.powerKw}</TableCell>
                      <TableCell className="text-foreground text-sm text-right">{formatHM(item.hoursOn)}</TableCell>
                      <TableCell className="text-primary font-bold text-sm text-right">{item.consumptionKwh.toFixed(0)} kWh</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="border-border bg-secondary/50">
                    <TableCell colSpan={4} className="text-foreground font-bold text-right">TOTAL</TableCell>
                    <TableCell className="text-primary font-bold text-right">{totalKwh.toFixed(0)} kWh</TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}