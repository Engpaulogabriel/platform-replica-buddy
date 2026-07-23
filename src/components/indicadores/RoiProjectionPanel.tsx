// Painel de Projeção de ROI — usa o histórico diário acumulado (RoiHistory)
// e a produtividade (ProductivityHistory) para projetar o mês corrente,
// comparar com o mês anterior e simular cenários de aumento de produtividade.
import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { TrendingUp, Sparkles, Target, Zap } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from "recharts";
import type { RoiHistory } from "@/hooks/useRoiHistory";
import type { ProductivityHistory } from "@/hooks/useProductivityHistory";

const fmtBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const fmtBRL2 = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 });

const WATER_VALUE_PER_M3 = 0.02;
// Janela diária em que as bombas PODERIAM operar sem custo de ponta (reservada
// 21:30→06:00 = 8,5h + fora-ponta 06:00→17:00 = 11h ≈ 19,5h). Usamos 18h por
// bomba como meta realista (descontando manutenção/segurança).
const TARGET_HOURS_PER_DAY_PER_PUMP = 18;

const MONTH_NAMES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];

interface Props {
  roi: RoiHistory;
  productivity: ProductivityHistory;
}

export function RoiProjectionPanel({ roi, productivity }: Props) {
  const view = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const elapsedDays = now.getDate(); // dia atual inclusive
    const remainingDays = Math.max(0, daysInMonth - elapsedDays);

    const ymCur = `${year}-${String(month + 1).padStart(2, "0")}`;
    const prevDate = new Date(year, month - 1, 1);
    const ymPrev = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;

    const curRows = roi.daily.filter(r => r.day.startsWith(ymCur));
    const realizedMonth = curRows.reduce((a, r) => a + r.total, 0);
    const avgDay = elapsedDays > 0 ? realizedMonth / elapsedDays : 0;
    const projectionMonth = avgDay * daysInMonth;

    const prevMonthRow = roi.monthly.find(m => m.month === ymPrev);
    const realizedPrev = prevMonthRow?.total ?? 0;

    // Produtividade: horas/dia médias e vazão média por bomba
    const prodDays = productivity.rows.length || 1;
    const avgHoursDayFarm = productivity.totals.hoursOn / prodDays;
    const avgFlowPerPump =
      productivity.totals.hoursOn > 0
        ? productivity.totals.volumeM3 / productivity.totals.hoursOn
        : 0;
    const numPumps = productivity.pumps.length || 0;
    const targetHoursDay = numPumps * TARGET_HOURS_PER_DAY_PER_PUMP;
    const idleHoursDay = Math.max(0, targetHoursDay - avgHoursDayFarm);

    // Ganho extra por hora ociosa aproveitada: volume × R$/m³ + uma fração
    // proporcional das outras economias (energia/deslocamento/mão-de-obra) que
    // escalam com mais operação. Usamos o ratio captação/total atual como peso.
    const captRatio = roi.totals.total > 0 ? roi.totals.captacao / roi.totals.total : 0.5;
    const extraPerHour =
      avgFlowPerPump * WATER_VALUE_PER_M3 * (captRatio > 0 ? 1 / Math.max(0.25, captRatio) : 2);

    const scenario = (pct: number) => {
      const extraHoursDay = idleHoursDay * pct;
      const extraDay = extraHoursDay * extraPerHour;
      return {
        pct,
        extraHoursDay,
        monthTotal: projectionMonth + extraDay * daysInMonth,
        extraMonth: extraDay * daysInMonth,
      };
    };
    const s10 = scenario(0.10);
    const s25 = scenario(0.25);

    // Cenário máximo (toda a janela ociosa aproveitada) — potencial não explorado
    const sMax = scenario(1);
    const untappedMonth = sMax.extraMonth;

    const chart = [
      { label: "Mês passado", value: realizedPrev, color: "hsl(var(--muted-foreground))" },
      { label: "Mês atual (projetado)", value: projectionMonth, color: "hsl(142 71% 45%)" },
      { label: "+10% prod.", value: s10.monthTotal, color: "hsl(199 89% 48%)" },
      { label: "+25% prod.", value: s25.monthTotal, color: "hsl(38 92% 50%)" },
    ];

    return {
      year, month, daysInMonth, elapsedDays, remainingDays,
      realizedMonth, avgDay, projectionMonth,
      realizedPrev, ymPrev,
      avgHoursDayFarm, idleHoursDay, targetHoursDay, numPumps,
      s10, s25, untappedMonth,
      chart,
    };
  }, [roi, productivity]);

  const progressPct = view.daysInMonth > 0
    ? Math.min(100, (view.elapsedDays / view.daysInMonth) * 100)
    : 0;
  const realizedPct = view.projectionMonth > 0
    ? Math.min(100, (view.realizedMonth / view.projectionMonth) * 100)
    : 0;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-foreground">
          <Sparkles className="w-5 h-5 text-emerald-500" />
          Projeção de Retorno — {MONTH_NAMES[view.month]}/{view.year}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Projeção do mês corrente baseada na média diária acumulada e cenários
          de aumento de produtividade (mais horas aproveitando o horário reservado/fora-ponta).
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Realizado + projeção */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="text-[10px] uppercase text-muted-foreground tracking-wide flex items-center gap-1">
              <TrendingUp className="w-3 h-3" /> Economia realizada
            </div>
            <div className="text-2xl font-bold tabular-nums text-emerald-400 mt-1">
              {fmtBRL2(view.realizedMonth)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              01/{String(view.month + 1).padStart(2, "0")} a {String(view.elapsedDays).padStart(2, "0")}/{String(view.month + 1).padStart(2, "0")}
              {" — média "}
              <span className="text-foreground">{fmtBRL(view.avgDay)}/dia</span>
            </div>
          </div>

          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
            <div className="text-[10px] uppercase text-muted-foreground tracking-wide flex items-center gap-1">
              <Target className="w-3 h-3" /> Projeção mês completo
            </div>
            <div className="text-2xl font-bold tabular-nums text-primary mt-1">
              {fmtBRL2(view.projectionMonth)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {view.elapsedDays} de {view.daysInMonth} dias decorridos · faltam {view.remainingDays}
            </div>
          </div>
        </div>

        {/* Barras de progresso */}
        <div className="space-y-2">
          <div>
            <div className="flex justify-between text-[11px] text-muted-foreground mb-1">
              <span>Mês decorrido</span><span>{progressPct.toFixed(0)}%</span>
            </div>
            <Progress value={progressPct} className="h-2" />
          </div>
          <div>
            <div className="flex justify-between text-[11px] text-muted-foreground mb-1">
              <span>Realizado vs projetado</span><span>{realizedPct.toFixed(0)}%</span>
            </div>
            <Progress value={realizedPct} className="h-2" />
          </div>
        </div>

        {/* Cenários */}
        <div>
          <div className="text-[11px] uppercase text-muted-foreground font-semibold mb-2 flex items-center gap-1">
            <Zap className="w-3.5 h-3.5" /> Cenários de aumento de produtividade
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <ScenarioCard
              title="Mantendo a média atual"
              value={view.projectionMonth}
              delta={null}
              hint={`${view.avgHoursDayFarm.toFixed(1)} h/dia operadas`}
            />
            <ScenarioCard
              title="+10% horas de operação"
              value={view.s10.monthTotal}
              delta={view.s10.extraMonth}
              hint={`+${view.s10.extraHoursDay.toFixed(1)} h/dia aproveitadas`}
              accent="info"
            />
            <ScenarioCard
              title="+25% horas de operação"
              value={view.s25.monthTotal}
              delta={view.s25.extraMonth}
              hint={`+${view.s25.extraHoursDay.toFixed(1)} h/dia aproveitadas`}
              accent="warn"
            />
          </div>
        </div>

        {/* Gráfico comparativo */}
        <div>
          <div className="text-[11px] uppercase text-muted-foreground font-semibold mb-1">
            Comparativo
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={view.chart}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={fmtBRL} />
              <Tooltip
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                formatter={(v: number) => [fmtBRL2(v), "Economia"]}
              />
              <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                {view.chart.map((c, i) => <Cell key={i} fill={c.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Potencial não explorado */}
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="text-[10px] uppercase text-amber-400/80 tracking-wide font-semibold">
            Potencial não explorado
          </div>
          <div className="text-2xl font-bold tabular-nums text-amber-400 mt-1">
            {fmtBRL2(view.untappedMonth)}/mês
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            Se todas as {view.numPumps || 0} bombas operassem no horário reservado/fora-ponta
            sem interrupções ({view.targetHoursDay.toFixed(0)} h/dia no total), a economia
            adicional projetada seria de <span className="text-amber-300 font-semibold">{fmtBRL2(view.untappedMonth)}/mês</span>.
            Hoje há em média <span className="text-foreground">{view.idleHoursDay.toFixed(1)} h/dia</span> de
            janela ociosa.
          </p>
        </div>

        {/* Projeção vs realizado (mês anterior) */}
        {view.realizedPrev > 0 && (
          <div className="text-xs text-muted-foreground border-t border-border pt-2">
            Mês anterior ({view.ymPrev}): realizado <span className="text-foreground font-semibold">{fmtBRL2(view.realizedPrev)}</span>.
            {view.projectionMonth > view.realizedPrev
              ? <span className="text-emerald-400"> Tendência de alta ({(((view.projectionMonth / view.realizedPrev) - 1) * 100).toFixed(1)}%).</span>
              : <span className="text-amber-400"> Tendência de queda ({(((view.projectionMonth / view.realizedPrev) - 1) * 100).toFixed(1)}%).</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ScenarioCard({
  title, value, delta, hint, accent,
}: {
  title: string;
  value: number;
  delta: number | null;
  hint: string;
  accent?: "info" | "warn";
}) {
  const border =
    accent === "info" ? "border-sky-500/30 bg-sky-500/5"
    : accent === "warn" ? "border-amber-500/30 bg-amber-500/5"
    : "border-border bg-card/60";
  const valColor =
    accent === "info" ? "text-sky-300"
    : accent === "warn" ? "text-amber-300"
    : "text-foreground";
  return (
    <div className={`rounded-lg border p-3 ${border}`}>
      <div className="text-[10px] uppercase text-muted-foreground tracking-wide">{title}</div>
      <div className={`text-lg font-bold tabular-nums mt-1 ${valColor}`}>{fmtBRL(value)}</div>
      {delta != null && (
        <div className="text-[11px] text-emerald-400 tabular-nums">+{fmtBRL(delta)} vs base</div>
      )}
      <div className="text-[10px] text-muted-foreground mt-1">{hint}</div>
    </div>
  );
}
