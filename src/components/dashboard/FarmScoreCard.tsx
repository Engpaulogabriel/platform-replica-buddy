// Card "Score da Fazenda" — nova fórmula 0-10 (5 sub-indicadores).
//   1. Pós-ponta — atraso médio para religar após 21h
//   2. Pré-ponta — antecipação média de desligamento
//   3. Infração na ponta — bombas ligadas entre 18h-21h
//   4. Modo de acionamento — % remoto/auto vs local
//   5. Uptime de comunicação — equipamentos online
//
// Score final = SOMA PONDERADA dos sub-indicadores (0.0-10.0), pesos fixos
//   0.50 / 0.25 / 0.15 / 0.09 / 0.01. Sub-indicador SEM DADOS é EXCLUÍDO da soma
//   e os pesos dos restantes são RENORMALIZADOS (não inventamos 10.0).
// Base: últimos 30 DIAS, apenas DIAS ÚTEIS (is_free_demand = false).
import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface SubScore {
  label: string;
  value: number;         // 0-10
  displayValue: string;  // valor bruto formatado (ex: "37 min", "92%")
  hint: string;
  weight: number;        // 0-1 (peso NOMINAL; renormalizado quando há sub sem dados)
  noData?: boolean;      // true = sem amostra ⇒ excluído da soma ponderada
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
  // Faixas coerentes com as cores: verde(alto) → laranja(médio) → vermelho(baixo).
  if (score >= 9.0) return { text: "text-emerald-500", bg: "bg-emerald-500/10", border: "border-emerald-500/40", glow: "shadow-emerald-500/20", label: "Excelente" };
  if (score >= 7.5) return { text: "text-green-500",   bg: "bg-green-500/10",   border: "border-green-500/40",   glow: "shadow-green-500/20",   label: "Bom" };
  if (score >= 5.0) return { text: "text-orange-500",  bg: "bg-orange-500/10",  border: "border-orange-500/40",  glow: "shadow-orange-500/20",  label: "Regular" };
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
function scorePeak(totalPeakMin: number): number {
  // A nota reflete a MAGNITUDE real (total de minutos de ponta somados em bomba×dia),
  // não a mera contagem de eventos. Monotônica e conservadora: mais minutos ⇒ nota menor.
  // A ponta é a tarifa mais cara (até ~6×), então penalizamos cedo e com teto.
  //   0 min          => 10  (nenhuma infração)
  //   1..15 min      => 10 → 7  (infração leve, tolerância pequena)
  //   15..60 min     => 7  → 3
  //   60..180 min    => 3  → 0
  //   > 180 min      => 0  (teto de penalização)
  if (totalPeakMin <= 0) return 10;
  if (totalPeakMin <= 15)  return +(10 - (totalPeakMin / 15) * 3).toFixed(1);
  if (totalPeakMin <= 60)  return +(7 - ((totalPeakMin - 15) / 45) * 4).toFixed(1);
  if (totalPeakMin <= 180) return +(3 - ((totalPeakMin - 60) / 120) * 3).toFixed(1);
  return 0;
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

      // 1. Pós-ponta: média de late_min APENAS das bombas que precisavam religar.
      //    BUG corrigido: excluímos post_status === 'not_started' — essas linhas não
      //    tinham religamento a fazer e o late_min vem capado em 540 (9h), o que
      //    contaminava/inflava a média com bombas que nem precisavam rodar.
      const postRows = workingPumps.filter(
        p => p.post_status && p.post_status !== "not_started" && p.late_min != null
      );
      const avgLate = postRows.length > 0
        ? postRows.reduce((s, r) => s + Math.max(0, Number(r.late_min)), 0) / postRows.length
        : 0;
      const post: SubScore = {
        label: "Pós-ponta (atraso)",
        value: postRows.length > 0 ? scorePost(avgLate) : 0,
        displayValue: postRows.length > 0 ? `${Math.round(avgLate)} min` : "— / sem dados",
        hint: "Reduzir atraso no religamento após 21h",
        weight: 0.50,
        noData: postRows.length === 0,
      };

      // 2. Pré-ponta: antecipação = early_off_min (min antes das 18h).
      //    Também excluímos 'not_started' (bombas sem desligamento a antecipar).
      const preRows = workingPumps.filter(
        p => p.pre_status && p.pre_status !== "not_started" && p.early_off_min != null
      );
      const avgAntic = preRows.length > 0
        ? preRows.reduce((s, r) => s + Math.max(0, Number(r.early_off_min)), 0) / preRows.length
        : 0;
      const pre: SubScore = {
        label: "Pré-ponta (deslig.)",
        value: preRows.length > 0 ? scorePre(avgAntic) : 0,
        displayValue: preRows.length > 0 ? `${Math.round(avgAntic)} min` : "— / sem dados",
        hint: "Desligar bombas próximo às 17:45",
        weight: 0.25,
        noData: preRows.length === 0,
      };

      // 3. Infração na ponta: soma de minutos de ponta em linhas bomba×dia.
      //    peakRows.length é o nº de EVENTOS (bomba×dia), NÃO de bombas distintas.
      //    0 min é dado real (nenhuma infração) ⇒ nota 10, não é "sem dados".
      const peakRows = workingPumps.filter(p => Number(p.peak_minutes ?? 0) > 0);
      const peakEvents = peakRows.length; // eventos (bomba×dia), não bombas
      const totalPeak = peakRows.reduce((s, r) => s + Number(r.peak_minutes), 0);
      const peak: SubScore = {
        label: "Infração na ponta",
        value: scorePeak(totalPeak),
        displayValue: peakEvents === 0
          ? "0 eventos"
          : `${peakEvents} ev.(bomba×dia)·${totalPeak}min`,
        hint: "Minutos de bombas na ponta (18h-21h); contagem é bomba×dia, não bombas distintas",
        weight: 0.15,
      };

      // 4. Modo de acionamento
      //    BUG corrigido: sem log de acionamento NÃO significa 100% remoto — é SEM DADOS.
      const remoteN = logs.filter(l => ["remote", "auto", "system"].includes(l.origin)).length;
      const localN = logs.filter(l => l.origin === "local").length;
      const total = remoteN + localN;
      const pctRemote = total > 0 ? (remoteN / total) * 100 : 0;
      const mode: SubScore = {
        label: "Modo de acionamento",
        value: total > 0 ? scoreRemote(pctRemote) : 0,
        displayValue: total > 0 ? `${Math.round(pctRemote)}%` : "— / sem dados",
        hint: "Preferir acionamentos remotos/automáticos",
        weight: 0.09,
        noData: total === 0,
      };

      // 5. Uptime
      //    BUG corrigido: sem equipamentos monitorados NÃO é 100% — é SEM DADOS.
      const hasEq = eqs.length > 0;
      let uptimePct = 0;
      if (hasEq) {
        const online = eqs.filter(e => e.last_communication && new Date(e.last_communication).toISOString() >= fiveMinAgo).length;
        uptimePct = (online / eqs.length) * 100;
      }
      const uptime: SubScore = {
        label: "Uptime comunicação",
        value: hasEq ? scoreUptime(uptimePct) : 0,
        displayValue: hasEq ? `${Math.round(uptimePct)}%` : "— / sem dados",
        hint: "Verificar comunicação dos equipamentos",
        weight: 0.01,
        noData: !hasEq,
      };

      // Soma ponderada RENORMALIZADA: sub-métricas sem dados saem da conta e os pesos
      // das restantes são reescalados por (peso / Σ pesos disponíveis). Assim não
      // inflamos o score assumindo 10.0 para o que não temos como medir.
      const allSubs = [post, pre, peak, mode, uptime];
      const scored = allSubs.filter(s => !s.noData);
      const availableWeight = scored.reduce((s, x) => s + x.weight, 0);
      const totalScore = availableWeight > 0
        ? +(scored.reduce((s, x) => s + x.value * x.weight, 0) / availableWeight).toFixed(1)
        : 0;


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
  // "Pior" sub-métrica considera apenas as que TÊM dados (noData não conta como 0).
  const rankable = subs.filter(s => !s.noData);
  const worst = (rankable.length > 0 ? [...rankable] : [...subs]).sort((a, b) => a.value - b.value)[0];

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
        return `${prefix}: ${v} de bombas ligadas na ponta — tarifa até 6× mais cara.`;
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
          <div key={s.label} className={`space-y-0.5 ${s.noData ? "opacity-60" : ""}`}>
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-muted-foreground">{s.label}</span>
              <span className="text-foreground tabular-nums w-14 text-right">{s.displayValue}</span>
              <span className={`tabular-nums w-10 text-right font-semibold ${s.noData ? "text-muted-foreground" : subTone(s.value)}`}>
                {s.noData ? "—" : s.value.toFixed(1)}
              </span>
              <span className="tabular-nums w-8 text-right text-[10px] text-muted-foreground">
                {Math.round(s.weight * 100)}%
              </span>
            </div>

            <div className="h-1 rounded-full bg-muted overflow-hidden">
              {!s.noData && (
                <div className={`h-full ${barColor(s.value)} transition-all`} style={{ width: `${(s.value / 10) * 100}%` }} />
              )}
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
