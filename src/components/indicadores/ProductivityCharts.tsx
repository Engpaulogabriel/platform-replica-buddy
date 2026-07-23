// Painel de gráficos históricos da aba Indicadores Gerenciais.
// 4 gráficos: Volume captado, Horas de operação, Acionamentos, Eficiência.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Droplets, Clock, Activity, Zap } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import type { ProductivityHistory } from "@/hooks/useProductivityHistory";

const fmtInt = (v: number) => Math.round(v).toLocaleString("pt-BR");
const fmtFix1 = (v: number) => v.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const fmtDayLabel = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};

interface Props {
  history: ProductivityHistory;
}

export function ProductivityCharts({ history }: Props) {
  const { rows, totals, loading } = history;
  const hasData = rows.some((r) => r.volumeM3 > 0 || r.hoursOn > 0 || r.triggers > 0 || r.efficiency != null);

  return (
    <div className="space-y-4">
      {/* KPIs do período */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={<Droplets className="w-4 h-4 text-sky-500" />} label="Volume captado" value={`${fmtInt(totals.volumeM3)} m³`} />
        <Kpi icon={<Clock className="w-4 h-4 text-primary" />} label="Horas de operação" value={`${fmtFix1(totals.hoursOn)} h`} />
        <Kpi icon={<Activity className="w-4 h-4 text-amber-500" />} label="Acionamentos" value={fmtInt(totals.triggers)} />
        <Kpi icon={<Zap className="w-4 h-4 text-emerald-500" />} label="Eficiência média" value={totals.avgEfficiency == null ? "—" : `${totals.avgEfficiency.toFixed(1)}%`} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ChartCard title="Volume captado por dia (m³)" icon={<Droplets className="w-4 h-4 text-sky-500" />}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="day" tickFormatter={fmtDayLabel} stroke="hsl(var(--muted-foreground))" fontSize={11} minTickGap={20} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={fmtInt} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={fmtDayLabel} formatter={(v: number) => [`${fmtInt(v)} m³`, "Volume"]} />
              <Line type="monotone" dataKey="volumeM3" stroke="hsl(199 89% 48%)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Horas de operação por dia" icon={<Clock className="w-4 h-4 text-primary" />}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="day" tickFormatter={fmtDayLabel} stroke="hsl(var(--muted-foreground))" fontSize={11} minTickGap={20} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={fmtFix1} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={fmtDayLabel} formatter={(v: number) => [`${fmtFix1(v)} h`, "Horas"]} />
              <Line type="monotone" dataKey="hoursOn" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Acionamentos por dia" icon={<Activity className="w-4 h-4 text-amber-500" />}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="day" tickFormatter={fmtDayLabel} stroke="hsl(var(--muted-foreground))" fontSize={11} minTickGap={20} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={fmtInt} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={fmtDayLabel} formatter={(v: number) => [fmtInt(v), "Acionamentos"]} />
              <Bar dataKey="triggers" fill="hsl(38 92% 50%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Eficiência energética diária (%)" icon={<Zap className="w-4 h-4 text-emerald-500" />}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="day" tickFormatter={fmtDayLabel} stroke="hsl(var(--muted-foreground))" fontSize={11} minTickGap={20} />
              <YAxis domain={[0, 100]} stroke="hsl(var(--muted-foreground))" fontSize={11} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={fmtDayLabel} formatter={(v: number | null) => [v == null ? "—" : `${Number(v).toFixed(1)}%`, "Eficiência"]} />
              <Line type="monotone" dataKey="efficiency" stroke="hsl(142 71% 45%)" strokeWidth={2} dot={{ r: 2 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {!loading && !hasData && (
        <div className="text-xs text-muted-foreground text-center py-6">
          Sem dados de produtividade no período selecionado.
        </div>
      )}
    </div>
  );
}

const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
};

function ChartCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2 text-foreground">{icon}{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/60 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground tracking-wide">{icon}{label}</div>
      <div className="text-lg font-bold text-foreground tabular-nums mt-1">{value}</div>
    </div>
  );
}
