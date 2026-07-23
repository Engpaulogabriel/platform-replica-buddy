import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Clock, Download, FileText, Loader2 } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";
import { exportHorimetroCSV, exportHorimetroPDF } from "@/lib/reportExport";
import { notifyReport } from "@/lib/notify";
import { useHorimetro } from "@/hooks/useHorimetro";
import { supabase } from "@/integrations/supabase/client";

interface HorimetroReportTabProps {
  farmId: string | null;
  fromDate: string;
  toDate: string;
  selectedPump: string;
}

const HORIMETRO_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--info))",
  "hsl(var(--warning))",
  "hsl(var(--destructive))",
  "hsl(var(--accent))",
];

function formatHM(hoursDecimal: number): string {
  const totalMinutes = Math.max(0, Math.round(hoursDecimal * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}min`;
}

export default function HorimetroReportTab({ farmId, fromDate, toDate, selectedPump }: HorimetroReportTabProps) {
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
    if (!farmId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("farms")
        .select("name, city, state")
        .eq("id", farmId)
        .maybeSingle();
      if (!cancelled && data) setFarmHeader({ name: data.name ?? "Fazenda", city: data.city ?? null, state: data.state ?? null });
    })();
    return () => { cancelled = true; };
  }, [farmId]);

  const filteredHorimetro = useMemo(() => {
    if (selectedPump === "all") return horimetro.byPump;
    return horimetro.byPump.filter((p) => p.pump === selectedPump);
  }, [horimetro.byPump, selectedPump]);

  const filteredPumpNames = useMemo(() => {
    if (selectedPump === "all") return horimetro.pumpNames;
    return horimetro.pumpNames.filter((n) => n === selectedPump);
  }, [horimetro.pumpNames, selectedPump]);

  const filteredChartData = useMemo(() => {
    if (selectedPump === "all") return horimetro.chartData;
    return horimetro.chartData.map((d) => ({
      day: d.day,
      [selectedPump]: d[selectedPump] ?? 0,
    }));
  }, [horimetro.chartData, selectedPump]);

  const totalHours = useMemo(
    () => filteredHorimetro.reduce((s, p) => s + p.monthTotal, 0),
    [filteredHorimetro]
  );
  const activeCount = useMemo(
    () => filteredHorimetro.filter((p) => p.monthTotal > 0).length,
    [filteredHorimetro]
  );

  if (!renderReady || horimetro.loading || !horimetro.hasLoaded) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-3">Carregando horímetro...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base text-foreground">Horas por dia (período selecionado)</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              {horimetro.loading
                ? "Carregando…"
                : `${filteredPumpNames.length} ${filteredPumpNames.length === 1 ? "bomba" : "bombas"} · ${filteredChartData.length} ${filteredChartData.length === 1 ? "dia" : "dias"}`}
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {horimetro.loading ? (
            <div className="h-80 rounded-lg bg-secondary/70 animate-pulse" />
          ) : horimetro.error ? (
            <div className="py-12 text-center text-sm text-destructive">
              Erro ao carregar horímetro: {horimetro.error}
            </div>
          ) : filteredChartData.length === 0 ? (
            <div className="py-12 text-center">
              <Clock className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
              <p className="text-sm font-medium text-foreground">Sem dados de horímetro no período</p>
              <p className="text-xs text-muted-foreground mt-1">
                O horímetro contabiliza automaticamente o tempo em que cada bomba ficou ligada.
              </p>
            </div>
          ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3 pb-3 border-b border-border">
                  <div>
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Total acumulado</p>
                    <p className="text-lg font-bold text-primary">{formatHM(totalHours)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Bombas ativas</p>
                    <p className="text-lg font-bold text-foreground">{activeCount}<span className="text-sm text-muted-foreground"> / {filteredHorimetro.length}</span></p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Média por bomba ativa</p>
                    <p className="text-lg font-bold text-foreground">{formatHM(activeCount > 0 ? totalHours / activeCount : 0)}</p>
                  </div>
                </div>

                <div className="w-full h-80">
                  <PageErrorBoundary pageName="gráfico de horímetro">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={filteredChartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                        <YAxis
                          stroke="hsl(var(--muted-foreground))"
                          fontSize={11}
                          label={{ value: "horas", angle: -90, position: "insideLeft", style: { fill: "hsl(var(--muted-foreground))", fontSize: 11 } }}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          formatter={(value: number) => [`${formatHM(value)}`, ""]}
                        />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        {filteredPumpNames.map((name, i) => (
                          <Line
                            key={name}
                            type="monotone"
                            dataKey={name}
                            stroke={HORIMETRO_COLORS[i % HORIMETRO_COLORS.length]}
                            strokeWidth={2}
                            dot={{ r: 3 }}
                            activeDot={{ r: 5 }}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </PageErrorBoundary>
                </div>
              </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-foreground">Detalhamento por Bomba (período selecionado)</h3>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="border-border text-muted-foreground gap-1"
            disabled={filteredHorimetro.length === 0}
            onClick={() => {
              exportHorimetroCSV(filteredHorimetro);
              notifyReport.exported("CSV", "Horímetro");
            }}
          >
            <Download className="w-3.5 h-3.5" /> CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-border text-muted-foreground gap-1"
            disabled={filteredHorimetro.length === 0}
            onClick={() => {
              exportHorimetroPDF(filteredHorimetro, farmHeader);
              notifyReport.exported("PDF", "Horímetro");
            }}
          >
            <FileText className="w-3.5 h-3.5" /> PDF
          </Button>
        </div>
      </div>

      {filteredHorimetro.length === 0 && !horimetro.loading ? (
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              Nenhuma bomba cadastrada na fazenda.
            </p>
          </CardContent>
        </Card>
      ) : (
        filteredHorimetro.map((pump) => {
          const getLastReadingStatus = () => {
            if (!pump.lastCommunication) return { text: "Sem comunicação", color: "text-muted-foreground" };
            if (pump.actuationOrigin === "local") return { text: "Local", color: "text-warning" };
            return { text: pump.isRunning ? "Ligado" : "Desligado", color: pump.isRunning ? "text-primary" : "text-destructive" };
          };
          const lastReadingStatus = getLastReadingStatus();

          return (
            <Card key={pump.equipmentId} className="bg-card border-border">
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-sm text-foreground">{pump.pump}</CardTitle>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">Período:</span>
                      <span className="font-bold text-primary">{formatHM(pump.monthTotal)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">Mês:</span>
                      <span className="font-bold text-foreground">{formatHM(pump.currentMonthTotal)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">Ano:</span>
                      <span className="font-bold text-foreground">{formatHM(pump.yearTotal)}</span>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {pump.days.length === 0 ? (
                  <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                    Sem registros no período selecionado.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border hover:bg-secondary/50">
                        <TableHead className="text-muted-foreground">Dia</TableHead>
                        <TableHead className="text-muted-foreground text-right">Tempo Ligada</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pump.days.map((d, i) => (
                        <TableRow key={i} className="border-border hover:bg-secondary/50">
                          <TableCell className="text-foreground text-sm">{d.day}</TableCell>
                          <TableCell className="text-foreground text-sm font-medium text-right">
                            {formatHM(d.hours)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <div className="px-4 py-2 border-t border-border bg-secondary/30">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Última leitura:</span>
                    <span className={`font-semibold ${lastReadingStatus.color}`}>
                      {lastReadingStatus.text}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}