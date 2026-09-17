// Card "Score da Fazenda" — nova fórmula 0-10 (5 sub-indicadores).
//   1. Pós-ponta — atraso médio para religar após 21h
//   2. Pré-ponta — antecipação média de desligamento
//   3. Infração na ponta — bombas ligadas entre 18h-21h
//   4. Modo de acionamento — % remoto/auto vs local
//   5. Uptime de comunicação — equipamentos online
//
// Score final = média dos 5 sub-indicadores (0.0-10.0).
// Base: últimos 7 DIAS ÚTEIS (is_free_demand = false).
import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface SubScore {
  label: string;
  value: number;         // 0-10
  displayValue: string;  // valor bruto formatado (ex: "37 min", "92%")
  hint: string;
  weight: number;        // 0-1
}


interface ScoreData {
  sub: {
    post: SubScore;
    pre: SubScore;
    peak: SubScore;
    mode: SubScore;
    uptime: SubScore;
  };
  total: number; // 0-10
  workingDays: number;
}

function tone(score: number) {
  if (score >= 9.0) return { text: "text-emerald-500", bg: "bg-emerald-500/10", border: "border-emerald-500/40", glow: "shadow-emerald-500/20", label: "Excelente" };
  if (score >= 8.0) return { text: "text-orange-500",  bg: "bg-orange-500/10",  border: "border-orange-500/40",  glow: "shadow-orange-500/20",  label: "Ruim" };
  return { text: "text-destructive", bg: "bg-destructive/10", border: "border-destructive/40", glow: "shadow-destructive/20", label: "Crítico" };
}


function subTone(v: number) {
  if (v >= 8) return "text-emerald-500";
  if (v >= 6) return "text-orange-500";
  return "text-destructive";
}

function barColor(v: number) {
  if (v >= 8) return "bg-emerald-500";
  if (v >= 6) return "bg-orange-500";
  return "bg-destructive";
}

// Fórmulas
function scorePost(avgMin: number): number {
  if (avgMin <= 8) return 10;
  if (avgMin <= 12) return +(9 - ((avgMin - 8) / 4) * 4).toFixed(1);
  if (avgMin <= 30) return +(5 - ((avgMin - 12) / 18) * 5).toFixed(1);
  return 0;
}
function scorePre(avgAnticMin: number): number {
  if (avgAnticMin <= 5) return 10;
  if (avgAnticMin >= 105) return 0;
  return +(10 - ((avgAnticMin - 5) / 100) * 10).toFixed(1);
}
function scorePeak(totalPeakMin: number, pumpsWithPeak: number, maxPeak: number): number {
  if (totalPeakMin === 0) return 10;
  if (maxPeak > 30) return 0;
  if (pumpsWithPeak >= 2) return 3;
  if (pumpsWithPeak === 1 && totalPeakMin <= 5) return 7;
  if (pumpsWithPeak === 1) return 5;
  return 10;
}
function scoreRemote(pct: number): number {
  return Math.max(0, Math.min(10, +(pct / 10).toFixed(1)));
}
function scoreUptime(pct: number): number {
  return Math.max(0, Math.min(10, +(pct / 10).toFixed(1)));
}

export function FarmScoreCard({ farmId }: { farmId: string | null }) {
  const [data, setData] = useState<ScoreData | null>(null);

  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    const load = async () => {
      const now = new Date();
      const sinceDate = new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
      const sinceTs = new Date(now.getTime() - 30 * 86400_000).toISOString();
      const fiveMinAgo = new Date(now.getTime() - 5 * 60_000).toISOString();

      const [dailyRes, pumpsRes, logRes, eqRes] = await Promise.all([
        supabase.from("energy_efficiency_daily" as any)
          .select("date, is_free_demand, minutes_on_during_peak, pumps_on_during_peak")
          .eq("farm_id", farmId)
          .gte("date", sinceDate),
        supabase.from("energy_efficiency_daily_pumps" as any)
          .select("date, late_min, early_off_min, peak_minutes, post_status, pre_status, peak_violation")
          .eq("farm_id", farmId)
          .gte("date", sinceDate),
        supabase.from("automation_log")
          .select("origin")
          .eq("farm_id", farmId)
          .gte("occurred_at", sinceTs)
          .in("origin", ["local", "remote", "auto", "system"] as any),
        supabase.from("equipments")
          .select("id, last_communication")
          .eq("farm_id", farmId)
          .in("type", ["poco", "bombeamento", "conjunto", "rio"] as any)
          .eq("active", true),
      ]);

      const daily = (dailyRes.data as any[]) ?? [];
      const pumps = (pumpsRes.data as any[]) ?? [];
      const logs = (logRes.data as any[]) ?? [];
      const eqs = (eqRes.data as any[]) ?? [];

      // Dias úteis (excluir livres)
      const workingDates = new Set(
        daily.filter(d => !d.is_free_demand).map(d => d.date)
      );
      const workingCount = workingDates.size;
      const workingPumps = pumps.filter(p => workingDates.has(p.date));

      // 1. Pós-ponta: média de late_min entre bombas que ligaram na janela (post_status not null)
      const postRows = workingPumps.filter(p => p.post_status && p.late_min != null);
      const avgLate = postRows.length > 0
        ? postRows.reduce((s, r) => s + Math.max(0, Number(r.late_min)), 0) / postRows.length
        : 0;
      const post: SubScore = {
        label: "Pós-ponta (atraso)",
        value: scorePost(avgLate),
        displayValue: postRows.length > 0 ? `${Math.round(avgLate)} min` : "—",
        hint: "Reduzir atraso no religamento após 21h",
        weight: 0.50,
      };

      // 2. Pré-ponta: antecipação = early_off_min (min antes das 18h)
      const preRows = workingPumps.filter(p => p.pre_status && p.early_off_min != null);
      const avgAntic = preRows.length > 0
        ? preRows.reduce((s, r) => s + Math.max(0, Number(r.early_off_min)), 0) / preRows.length
        : 0;
      const pre: SubScore = {
        label: "Pré-ponta (deslig.)",
        value: scorePre(avgAntic),
        displayValue: preRows.length > 0 ? `${Math.round(avgAntic)} min` : "—",
        hint: "Desligar bombas próximo às 17:45",
        weight: 0.25,
      };

      // 3. Infração na ponta: bombas com peak_minutes > 0 na semana
      const peakRows = workingPumps.filter(p => Number(p.peak_minutes ?? 0) > 0);
      const totalPeak = peakRows.reduce((s, r) => s + Number(r.peak_minutes), 0);
      const maxPeak = peakRows.reduce((m, r) => Math.max(m, Number(r.peak_minutes)), 0);
      const peak: SubScore = {
        label: "Infração na ponta",
        value: scorePeak(totalPeak, peakRows.length, maxPeak),
        displayValue: peakRows.length === 0 ? "0" : `${peakRows.length} · ${totalPeak}min`,
        hint: "Evitar bombas ligadas entre 18h-21h",
        weight: 0.15,
      };

      // 4. Modo de acionamento
      const remoteN = logs.filter(l => ["remote", "auto", "system"].includes(l.origin)).length;
      const localN = logs.filter(l => l.origin === "local").length;
      const total = remoteN + localN;
      const pctRemote = total > 0 ? (remoteN / total) * 100 : 100;
      const mode: SubScore = {
        label: "Modo de acionamento",
        value: scoreRemote(pctRemote),
        displayValue: total > 0 ? `${Math.round(pctRemote)}%` : "—",
        hint: "Preferir acionamentos remotos/automáticos",
        weight: 0.09,
      };

      // 5. Uptime
      let uptimePct = 100;
      if (eqs.length > 0) {
        const online = eqs.filter(e => e.last_communication && new Date(e.last_communication).toISOString() >= fiveMinAgo).length;
        uptimePct = (online / eqs.length) * 100;
      }
      const uptime: SubScore = {
        label: "Uptime comunicação",
        value: scoreUptime(uptimePct),
        displayValue: `${Math.round(uptimePct)}%`,
        hint: "Verificar comunicação dos equipamentos",
        weight: 0.01,
      };

      const totalScore = +(
        post.value * post.weight +
        pre.value * pre.weight +
        peak.value * peak.weight +
        mode.value * mode.weight +
        uptime.value * uptime.weight
      ).toFixed(1);


      if (!cancelled) {
        setData({
          sub: { post, pre, peak, mode, uptime },
          total: totalScore,
          workingDays: workingCount,
        });
      }
    };
    void load();
    const t = setInterval(load, 300_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [farmId]);

  if (!farmId || !data) return null;
  const t = tone(data.total);
  const subs = [data.sub.post, data.sub.pre, data.sub.peak, data.sub.mode, data.sub.uptime];
  const worst = [...subs].sort((a, b) => a.value - b.value)[0];

  const buildStatus = () => {
    if (worst.value >= 9) return "Operação no padrão ouro 🏆";
    const prefix = worst.value < 6 ? "🔴 CRÍTICO" : worst.value < 8 ? "⚠️ ATENÇÃO" : "Melhorar";
    const v = worst.displayValue;
    switch (worst.label) {
      case "Pós-ponta (atraso)":
        return `${prefix}: Atraso médio de ${v} no religamento após 21h — bombas paradas = menos captação diária.`;
      case "Pré-ponta (deslig.)":
        return `${prefix}: Desligamento antecipado em ${v} antes das 18h — perda de janela produtiva.`;
      case "Infração na ponta":
        return `${prefix}: Bombas ligadas na ponta (${v}) — tarifa até 6× mais cara.`;
      case "Modo de acionamento":
        return `${prefix}: Apenas ${v} dos acionamentos são remotos/automáticos — deslocamentos evitáveis.`;
      case "Uptime comunicação":
        return `${prefix}: Comunicação em ${v} — equipamentos offline comprometem a automação.`;
      default:
        return `${prefix}: ${worst.hint}`;
    }
  };
  const statusMsg = buildStatus();

  return (
    <div className={`rounded-xl border ${t.border} ${t.bg} p-4 shadow-md ${t.glow} h-full`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Trophy className={`w-5 h-5 ${t.text}`} />
          <h3 className="font-bold text-foreground tracking-wide uppercase text-xs">Score da Fazenda</h3>
        </div>
        <span className={`text-[10px] font-semibold ${t.text} uppercase`}>{t.label}</span>
      </div>

      <div className="flex items-baseline justify-center gap-1 mb-1">
        <span className={`text-6xl font-black ${t.text} tabular-nums leading-none`}>
          {data.total.toFixed(1)}
        </span>
        <span className="text-xl font-bold text-muted-foreground">/ 10</span>
      </div>
      <div className="text-center text-[10px] text-muted-foreground mb-3">
        {data.workingDays} dia{data.workingDays === 1 ? "" : "s"} útil{data.workingDays === 1 ? "" : "eis"} · últimos 30 dias
      </div>


      <div className="space-y-2 text-[11px]">
        {subs.map((s) => (
          <div key={s.label} className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-muted-foreground">{s.label}</span>
              <span className="text-foreground tabular-nums w-14 text-right">{s.displayValue}</span>
              <span className={`tabular-nums w-10 text-right font-semibold ${subTone(s.value)}`}>
                {s.value.toFixed(1)}
              </span>
              <span className="tabular-nums w-8 text-right text-[10px] text-muted-foreground">
                {Math.round(s.weight * 100)}%
              </span>
            </div>

            <div className="h-1 rounded-full bg-muted overflow-hidden">
              <div className={`h-full ${barColor(s.value)} transition-all`} style={{ width: `${(s.value / 10) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 pt-2 border-t border-border/50 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">Status:</span> {statusMsg}
      </div>
    </div>
  );
}
