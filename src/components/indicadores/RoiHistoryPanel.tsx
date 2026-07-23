// Painel histórico de ROI — economia acumulada, barras mensais por categoria
// e tabela mensal. Usa os mesmos parâmetros de farm_productivity_config do
// RoiTravelCard (resumo dos últimos 30 dias), apenas distribuído por dia/mês.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TrendingUp, BarChart3 } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";
import type { RoiHistory } from "@/hooks/useRoiHistory";

const fmtBRL = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const fmtBRL2 = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 });
const fmtDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const fmtMonth = (m: string) => {
  const [y, mm] = m.split("-");
  const names = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${names[Number(mm) - 1]}/${y.slice(2)}`;
};

interface Props {
  history: RoiHistory;
}

const CAT_COLORS = {
  captacao: "hsl(199 89% 48%)",
  energia: "hsl(142 71% 45%)",
  deslocamento: "hsl(38 92% 50%)",
  maoObra: "hsl(280 65% 60%)",
  multas: "hsl(0 84% 60%)",
};

export function RoiHistoryPanel({ history }: Props) {
  const { daily, monthly, totals, loading } = history;
  const hasData = daily.some(d => d.total > 0);

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-foreground">
          <TrendingUp className="w-5 h-5 text-emerald-500" />
          Retorno sobre Investimento — Histórico
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Economia acumulada desde o início da operação, por categoria. Cálculo baseado em pump_runtime, automation_log e farm_productivity_config.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Totais */}
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-2 text-xs">
          <TotalCell label="Total" value={fmtBRL(totals.total)} highlight />
          <TotalCell label="Captação extra" value={fmtBRL(totals.captacao)} />
          <TotalCell label="Energia" value={fmtBRL(totals.energia)} />
          <TotalCell label="Deslocamento" value={fmtBRL(totals.deslocamento)} />
          <TotalCell label="Mão de obra" value={fmtBRL(totals.maoObra)} />
          <TotalCell label="Multas evitadas" value={fmtBRL(totals.multas)} />
        </div>

        {/* Linha: acumulado */}
        <div>
          <div className="text-[11px] uppercase text-muted-foreground font-semibold mb-1">Economia acumulada</div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="day" tickFormatter={fmtDay} stroke="hsl(var(--muted-foreground))" fontSize={11} minTickGap={24} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={fmtBRL} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={fmtDay} formatter={(v: number) => [fmtBRL2(v), "Acumulado"]} />
              <Line type="monotone" dataKey="cumulative" stroke="hsl(142 71% 45%)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Barras diárias empilhadas */}
        <div>
          <div className="text-[11px] uppercase text-muted-foreground font-semibold mb-1 flex items-center gap-1">
            <BarChart3 className="w-3.5 h-3.5" /> Economia diária
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="day" tickFormatter={fmtDay} stroke="hsl(var(--muted-foreground))" fontSize={11} minTickGap={24} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={fmtBRL} />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={fmtDay}
                formatter={(v: number, n: string) => [fmtBRL2(v), labelFor(n)]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} formatter={labelFor} />
              <Bar dataKey="captacao" stackId="d" fill={CAT_COLORS.captacao} />
              <Bar dataKey="energia" stackId="d" fill={CAT_COLORS.energia} />
              <Bar dataKey="deslocamento" stackId="d" fill={CAT_COLORS.deslocamento} />
              <Bar dataKey="maoObra" stackId="d" fill={CAT_COLORS.maoObra} />
              <Bar dataKey="multas" stackId="d" fill={CAT_COLORS.multas} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Barras mensais empilhadas */}
        <div>
          <div className="text-[11px] uppercase text-muted-foreground font-semibold mb-1 flex items-center gap-1">
            <BarChart3 className="w-3.5 h-3.5" /> Economia mensal por categoria
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={monthly}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="month" tickFormatter={fmtMonth} stroke="hsl(var(--muted-foreground))" fontSize={11} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={fmtBRL} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={fmtMonth} formatter={(v: number, n: string) => [fmtBRL2(v), labelFor(n)]} />
              <Legend wrapperStyle={{ fontSize: 11 }} formatter={labelFor} />
              <Bar dataKey="captacao" stackId="a" fill={CAT_COLORS.captacao} />
              <Bar dataKey="energia" stackId="a" fill={CAT_COLORS.energia} />
              <Bar dataKey="deslocamento" stackId="a" fill={CAT_COLORS.deslocamento} />
              <Bar dataKey="maoObra" stackId="a" fill={CAT_COLORS.maoObra} />
              <Bar dataKey="multas" stackId="a" fill={CAT_COLORS.multas} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Tabela mensal */}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead>Mês</TableHead>
                <TableHead className="text-right">Captação</TableHead>
                <TableHead className="text-right">Energia</TableHead>
                <TableHead className="text-right">Deslocamento</TableHead>
                <TableHead className="text-right">Mão de obra</TableHead>
                <TableHead className="text-right">Multas</TableHead>
                <TableHead className="text-right font-bold">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {monthly.map((m) => (
                <TableRow key={m.month} className="border-border">
                  <TableCell className="font-medium text-foreground">{fmtMonth(m.month)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtBRL(m.captacao)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtBRL(m.energia)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtBRL(m.deslocamento)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtBRL(m.maoObra)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtBRL(m.multas)}</TableCell>
                  <TableCell className="text-right tabular-nums font-bold text-emerald-500">{fmtBRL(m.total)}</TableCell>
                </TableRow>
              ))}
              {monthly.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground text-xs py-6">
                  {loading ? "Carregando…" : "Sem economia computada no período."}
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {!loading && !hasData && (
          <div className="text-xs text-muted-foreground text-center py-3">
            Sem dados de operação no período — ajuste o intervalo ou aguarde os primeiros ciclos.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function labelFor(k: string): string {
  switch (k) {
    case "captacao": return "Captação extra";
    case "energia": return "Energia (ponta evitada)";
    case "deslocamento": return "Deslocamento";
    case "maoObra": return "Mão de obra";
    case "multas": return "Multas evitadas";
    default: return k;
  }
}

const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
};

function TotalCell({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${highlight ? "border-emerald-500/40 bg-emerald-500/10" : "border-border bg-card/60"}`}>
      <div className="text-[10px] uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={`tabular-nums font-bold mt-1 ${highlight ? "text-emerald-400 text-lg" : "text-foreground text-sm"}`}>{value}</div>
    </div>
  );
}
