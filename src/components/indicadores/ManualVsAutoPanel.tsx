// Captação adicional com automação — modelo honesto baseado em TEMPO DE
// ACIONAMENTO, não em premissas de operação manual ideal.
//
// Lógica:
//   • Sem sistema: operador leva ~tempo_manual min para percorrer e ligar/desligar
//     todas as bombas (default 60).
//   • Com sistema: liga/desliga em ~tempo_sistema min (default 3).
//   • Ganho por ciclo = tempo_manual − tempo_sistema (minutos extras de operação
//     das bombas, porque elas começaram a trabalhar antes).
//   • Multiplica pelo nº REAL de acionamentos (turn_on) do período e pela vazão
//     média das bombas para chegar em m³ extras.
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, Sparkles, Timer, Zap, Droplets } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";
import { supabase } from "@/integrations/supabase/client";
import type { ProductivityHistory } from "@/hooks/useProductivityHistory";

const fmtInt = (v: number) => Math.round(v).toLocaleString("pt-BR");
const fmtM3 = (v: number) => `${fmtInt(v)} m³`;
const fmtHours = (v: number) => `${v.toFixed(1)} h`;

interface Props {
  farmId: string | null;
  history: ProductivityHistory;
}

interface ManualCfg {
  manual_operation_time_minutes: number;
  remote_operation_time_minutes: number;
}

export function ManualVsAutoPanel({ farmId, history }: Props) {
  const [cfg, setCfg] = useState<ManualCfg>({
    manual_operation_time_minutes: 60,
    remote_operation_time_minutes: 3,
  });

  useEffect(() => {
    if (!farmId) return;
    (async () => {
      const { data } = await supabase
        .from("farm_productivity_config")
        .select("manual_operation_time_minutes, remote_operation_time_minutes")
        .eq("farm_id", farmId)
        .maybeSingle();
      if (data) {
        setCfg({
          manual_operation_time_minutes: Number((data as any).manual_operation_time_minutes ?? 60),
          remote_operation_time_minutes: Number((data as any).remote_operation_time_minutes ?? 3),
        });
      }
    })();
  }, [farmId]);

  const gainPerCycleMin = Math.max(0, cfg.manual_operation_time_minutes - cfg.remote_operation_time_minutes);
  const avgFlow = history.avgFlowM3h;

  const { monthly, totals } = useMemo(() => {
    const byMonth = new Map<string, { month: string; manual: number; sistema: number; ciclos: number }>();
    let cycles = 0;
    for (const r of history.rows) {
      cycles += r.turnOns;
      const ym = r.day.slice(0, 7);
      const bucket = byMonth.get(ym) ?? { month: ym, manual: 0, sistema: 0, ciclos: 0 };
      // tempo TOTAL gasto em acionamentos (minutos) por mês
      bucket.manual += r.turnOns * cfg.manual_operation_time_minutes;
      bucket.sistema += r.turnOns * cfg.remote_operation_time_minutes;
      bucket.ciclos += r.turnOns;
      byMonth.set(ym, bucket);
    }
    const extraHours = (cycles * gainPerCycleMin) / 60;
    const extraVolume = extraHours * avgFlow;
    return {
      monthly: Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month)),
      totals: { cycles, extraHours, extraVolume },
    };
  }, [history.rows, cfg, gainPerCycleMin, avgFlow]);

  const fmtMonth = (ym: string) => {
    const [y, m] = ym.split("-");
    return `${m}/${y.slice(2)}`;
  };

  return (
    <Card className="bg-gradient-to-br from-primary/5 to-emerald-500/5 border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 text-foreground">
          <Sparkles className="w-5 h-5 text-primary" />
          Captação adicional pela agilidade de acionamento
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {(() => {
          const volumeComSistema = history.totals.volumeM3;
          const volumeSemSistema = Math.max(0, volumeComSistema - totals.extraVolume);
          const pctGain = volumeSemSistema > 0 ? (totals.extraVolume / volumeSemSistema) * 100 : 0;
          return (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-3">
                  <div className="text-[10px] uppercase text-muted-foreground tracking-wide">Volume extra captado</div>
                  <div className="text-2xl font-bold text-emerald-500 tabular-nums mt-1 flex items-center gap-1.5">
                    <TrendingUp className="w-5 h-5" /> +{fmtM3(totals.extraVolume)}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    graças ao acionamento remoto
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-card/60 px-3 py-3">
                  <div className="text-[10px] uppercase text-muted-foreground tracking-wide">Tempo de operação extra</div>
                  <div className="text-2xl font-bold text-primary tabular-nums mt-1 flex items-center gap-1.5">
                    <Timer className="w-5 h-5" /> {fmtHours(totals.extraHours)}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    que as bombas trabalharam a mais
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-card/60 px-3 py-3">
                  <div className="text-[10px] uppercase text-muted-foreground tracking-wide">Acionamentos no período</div>
                  <div className="text-2xl font-bold text-foreground tabular-nums mt-1 flex items-center gap-1.5">
                    <Zap className="w-5 h-5 text-amber-500" /> {fmtInt(totals.cycles)}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    ciclos reais (turn_on)
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-card/60 px-3 py-3">
                  <div className="text-[10px] uppercase text-muted-foreground tracking-wide">Sem acionamento remoto (estimado)</div>
                  <div className="text-2xl font-bold text-muted-foreground tabular-nums mt-1 flex items-center gap-1.5">
                    <Droplets className="w-5 h-5" /> {fmtM3(volumeSemSistema)}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    volume estimado com operação manual
                  </div>
                </div>
              </div>

              {totals.extraVolume > 0 && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-center">
                  <span className="text-lg font-bold text-emerald-500 tabular-nums">
                    +{pctGain.toFixed(1)}%
                  </span>{" "}
                  <span className="text-sm text-foreground">de captação extra com acionamento remoto</span>
                </div>
              )}

              <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
                <span className="text-foreground">
                  Cada acionamento remoto economiza <span className="font-semibold text-primary">{gainPerCycleMin} min</span>{" "}
                  comparado ao deslocamento manual ({cfg.manual_operation_time_minutes} min → {cfg.remote_operation_time_minutes} min).
                </span>{" "}
                <span className="text-muted-foreground text-xs">
                  {fmtInt(totals.cycles)} acionamentos × {gainPerCycleMin} min = {fmtHours(totals.extraHours)}{" "}
                  de operação extra × {fmtInt(avgFlow)} m³/h (vazão média) = +{fmtM3(totals.extraVolume)}.
                  Ganho de <span className="font-semibold text-emerald-500">+{pctGain.toFixed(1)}%</span> em captação
                  comparado à operação sem acionamento remoto.
                </span>
              </div>
            </>
          );
        })()}


        {monthly.length > 0 && (
          <div>
            <div className="text-xs text-muted-foreground mb-2">
              Tempo gasto em acionamentos por mês (minutos)
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={monthly}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="month" tickFormatter={fmtMonth} stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={fmtInt} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                  labelFormatter={fmtMonth}
                  formatter={(v: number, name: string) => [`${fmtInt(v)} min`, name]}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="manual" name="Tempo manual (estimado)" fill="hsl(var(--muted-foreground))" radius={[4, 4, 0, 0]} />
                <Bar dataKey="sistema" name="Tempo com sistema (real)" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="text-[10px] text-muted-foreground border-t border-border pt-2">
          Parâmetros (editáveis em <span className="font-mono">farm_productivity_config</span>):
          tempo manual = <span className="text-foreground">{cfg.manual_operation_time_minutes} min/ciclo</span>,
          tempo sistema = <span className="text-foreground">{cfg.remote_operation_time_minutes} min/ciclo</span>,
          vazão média das bombas no escopo = <span className="text-foreground">{fmtInt(avgFlow)} m³/h</span>.
          Acionamentos contados em <span className="font-mono">automation_log</span> (action = turn_on).
        </div>
      </CardContent>
    </Card>
  );
}
