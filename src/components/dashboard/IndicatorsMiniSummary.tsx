// Barra fina compacta no topo do Dashboard que mostra Eficiência, Score e
// Economia em 30d com link rápido para a aba "Indicadores". Substitui os
// 3 cards grandes que antes ficavam no Dashboard.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BarChart3, ChevronRight, Trophy, Zap, TrendingUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface Summary {
  efficiency: number | null;
  score: number | null;
  savings: number | null;
  diasOperacao: number | null;
  projecaoMensal: number | null;
}

const fmtBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function IndicatorsMiniSummary({ farmId }: { farmId: string | null }) {
  const [data, setData] = useState<Summary>({
    efficiency: null, score: null, savings: null, diasOperacao: null, projecaoMensal: null,
  });

  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    const load = async () => {
      const sevenAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString();

      const [sumRes, peakRes, eqRes, farmRes, cfgRes, eqGeoRes, logRes, firstLogRes, firstEqRes] = await Promise.all([
        supabase.rpc("get_energy_efficiency_summary", { _farm_id: farmId }),
        supabase.from("energy_efficiency_daily" as any)
          .select("date, minutes_on_during_peak")
          .eq("farm_id", farmId)
          .gte("date", sevenAgo)
          .gt("minutes_on_during_peak", 0),
        supabase.from("equipments")
          .select("id, last_communication")
          .eq("farm_id", farmId)
          .in("type", ["poco", "bombeamento"] as any)
          .eq("active", true),
        supabase.from("farms").select("latitude, longitude").eq("id", farmId).maybeSingle(),
        supabase.from("farm_productivity_config" as any)
          .select("worker_cost_per_hour, vehicle_cost_per_km, travel_minutes_avg, travel_distance_km, manual_operation_time_minutes, remote_operation_time_minutes, cycles_per_day, tariff_peak, tariff_reserved")
          .eq("farm_id", farmId).maybeSingle(),
        supabase.from("equipments").select("id, latitude, longitude, power_kw, estimated_flow_m3h")
          .eq("farm_id", farmId).in("type", ["poco", "bombeamento"] as any).eq("active", true),
        supabase.from("automation_log")
          .select("equipment_id, occurred_at")
          .eq("farm_id", farmId)
          .eq("origin", "remote" as any)
          .gte("occurred_at", thirtyAgo)
          .order("occurred_at", { ascending: true })
          .limit(5000),
        supabase.from("automation_log")
          .select("occurred_at")
          .eq("farm_id", farmId)
          .order("occurred_at", { ascending: true })
          .limit(1),
        supabase.from("equipments")
          .select("created_at")
          .eq("farm_id", farmId)
          .order("created_at", { ascending: true })
          .limit(1),
      ]);

      const sum = (sumRes.data as any) ?? null;
      const peakDays = (peakRes.data as any[]) ?? [];
      const eqs = (eqRes.data as any[]) ?? [];

      const effPct = sum?.avg_7d == null ? null : Number(sum.avg_7d);

      // Score (mesma fórmula do FarmScoreCard)
      const eff = effPct == null ? 40 : Math.max(0, Math.min(40, (effPct / 100) * 40));
      const postLost = Number(sum?.post_lost_pump_minutes ?? 0);
      const postLate = Number(sum?.post_late_pumps ?? 0);
      const avgDelay = postLate > 0 ? postLost / postLate : 0;
      let resp = 30;
      if (avgDelay > 30) resp = 0;
      else if (avgDelay > 15) resp = 10;
      else if (avgDelay > 5) resp = 20;
      let peak = 15;
      if (peakDays.length >= 2) peak = 0;
      else if (peakDays.length === 1) peak = 5;
      let uptimePct = 100;
      if (eqs.length > 0) {
        const online = eqs.filter(
          (e) => e.last_communication && new Date(e.last_communication).toISOString() >= fiveMinAgo,
        ).length;
        uptimePct = (online / eqs.length) * 100;
      }
      const uptime = (uptimePct / 100) * 15;
      const score = Math.round(eff + resp + peak + uptime);

      // Savings — clusters + janela 60min (mesma lógica do RoiTravelCard)
      const farm: any = farmRes.data ?? {};
      const cfg: any = cfgRes.data ?? {};
      const eqGeo: any[] = eqGeoRes.data ?? [];
      const logs: any[] = logRes.data ?? [];
      let savings: number | null = null;
      let diasOperacao: number | null = null;
      let projecaoMensal: number | null = null;

      const farmLat = Number(farm.latitude);
      const farmLng = Number(farm.longitude);
      if (Number.isFinite(farmLat) && Number.isFinite(farmLng) && farmLat !== 0) {
        // dias de operação real
        let firstDate: Date | null = null;
        const firstLog = (firstLogRes.data as any[])?.[0]?.occurred_at;
        const firstEq = (firstEqRes.data as any[])?.[0]?.created_at;
        if (firstLog) firstDate = new Date(firstLog);
        else if (firstEq) firstDate = new Date(firstEq);
        diasOperacao = firstDate ? Math.max(1, Math.floor((Date.now() - firstDate.getTime()) / 86400_000)) : 1;
        const escala = Math.min(diasOperacao, 30) / 30;

        // monta clusters greedy <2km
        type Cl = { ids: Set<string>; lat: number; lng: number; dist: number };
        const clusters: Cl[] = [];
        for (const e of eqGeo) {
          const lat = Number(e.latitude); const lng = Number(e.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0) continue;
          const tgt = clusters.find((c) => haversineKm(lat, lng, c.lat, c.lng) <= 2);
          if (tgt) tgt.ids.add(e.id);
          else clusters.push({ ids: new Set([e.id]), lat, lng, dist: haversineKm(farmLat, farmLng, lat, lng) });
        }
        const eqToCl = new Map<string, number>();
        clusters.forEach((c, i) => c.ids.forEach((id) => eqToCl.set(id, i)));

        // agrupa logs em viagens (janela 60min)
        const win = 60 * 60_000;
        let trips = 0; let totalDist = 0;
        let wStart: number | null = null; let wMax = 0; let wHas = false;
        const close = () => { if (wHas) { trips++; totalDist += wMax; } wStart = null; wMax = 0; wHas = false; };
        for (const l of logs) {
          const cIdx = eqToCl.get(l.equipment_id);
          if (cIdx === undefined) continue;
          const t = new Date(l.occurred_at).getTime();
          if (wStart === null) wStart = t;
          else if (t - wStart > win) { close(); wStart = t; }
          const d = clusters[cIdx].dist;
          if (d > wMax) wMax = d;
          wHas = true;
        }
        close();

        const avgRoadKm = trips > 0 ? (totalDist / trips) * 2 * 1.3 : 0;
        const workerCost = Number(cfg.worker_cost_per_hour ?? 25);
        const vehicleCost = Number(cfg.vehicle_cost_per_km ?? 2.5);
        const travelMin = Number(cfg.travel_minutes_avg ?? 30);
        const manualMin = Number(cfg.manual_operation_time_minutes ?? 80);
        const remoteMin = Number(cfg.remote_operation_time_minutes ?? 5);
        const cyclesDay = Number(cfg.cycles_per_day ?? 2);
        const tariffPeak = Number(cfg.tariff_peak ?? 1.884);
        const tariffReserved = Number(cfg.tariff_reserved ?? 0.3878);
        const costPerTrip = avgRoadKm * vehicleCost + (travelMin / 60) * workerCost;
        const deslocamento = trips * costPerTrip;

        const numPumps = eqGeo.length;
        const avgPowerKw = numPumps > 0
          ? eqGeo.reduce((a: number, e: any) => a + Number(e.power_kw ?? 75), 0) / numPumps
          : 75;
        const avgFlow = numPumps > 0
          ? eqGeo.reduce((a: number, e: any) => a + Number(e.estimated_flow_m3h ?? 300), 0) / numPumps
          : 300;
        const horasMo = ((manualMin - remoteMin) * cyclesDay * 30) / 60;
        const maoObra30d = Math.max(0, horasMo) * workerCost;
        // Energia: 5 min/dia ponta evitada × 60% das bombas
        const energia30d = (5 / 60) * (numPumps * 0.6) * 30 * avgPowerKw * Math.max(0, tariffPeak - tariffReserved);
        // Captação: m³ extras × R$ 0,02/m³
        const gainMin = Math.max(0, manualMin - remoteMin);
        const volM3_30d = (gainMin / 60) * numPumps * cyclesDay * 30 * avgFlow;
        const captacao30d = volM3_30d * 0.02;

        const maoObra = maoObra30d * escala;
        const energia = energia30d * escala;
        const captacao = captacao30d * escala;

        savings = deslocamento + maoObra + energia + captacao;
        projecaoMensal = diasOperacao < 30 ? (savings / Math.max(1, diasOperacao)) * 30 : null;
      }

      if (!cancelled) {
        setData({ efficiency: effPct, score, savings, diasOperacao, projecaoMensal });
      }
    };
    void load();
    const t = setInterval(load, 300_000); // 5 min p/ cota Cloud
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [farmId]);

  if (!farmId) return null;

  const effLabel = data.efficiency == null ? "—" : `${data.efficiency.toFixed(1)}%`;
  const scoreLabel = data.score == null ? "—" : `${data.score}/100`;
  const savingsLabel = data.savings == null ? "—" : fmtBRL(data.savings);
  const isProjetado = data.diasOperacao != null && data.diasOperacao < 30;

  return (
    <Link
      to="/indicadores"
      className="group flex items-center justify-between gap-4 rounded-lg border border-border bg-card/60 hover:bg-card hover:border-primary/40 transition-all px-3 py-2 mb-3"
    >
      <div className="flex items-center gap-4 flex-wrap min-w-0">
        <div className="flex items-center gap-1.5 text-xs font-bold text-foreground uppercase tracking-wider shrink-0">
          <BarChart3 className="w-4 h-4 text-primary" />
          Indicadores
        </div>
        <Stat icon={<Zap className="w-3.5 h-3.5 text-amber-500" />} label="Eficiência" value={effLabel} />
        <span className="text-border">|</span>
        <Stat icon={<Trophy className="w-3.5 h-3.5 text-emerald-500" />} label="Score" value={scoreLabel} />
        <span className="text-border">|</span>
        <Stat
          icon={<TrendingUp className="w-3.5 h-3.5 text-emerald-500" />}
          label={isProjetado ? `Economia ${data.diasOperacao}d` : "Economia 30d"}
          value={savingsLabel}
        />
      </div>
      <div className="flex items-center gap-1 text-xs font-medium text-primary shrink-0 group-hover:gap-2 transition-all">
        <span className="hidden sm:inline">Ver detalhes</span>
        <ChevronRight className="w-4 h-4" />
      </div>
    </Link>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {icon}
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-bold text-foreground tabular-nums">{value}</span>
    </div>
  );
}
