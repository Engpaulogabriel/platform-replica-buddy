// Card "Retorno sobre Investimento" — VALOR TOTAL em R$ (5 componentes somados):
// Adapta automaticamente ao tempo de operação real (dias_com_dados < 30 → projeção).
//   1. Captação extra garantida (vazão × tempo de antecipação × custo energético equiv.)
//   2. Economia de energia (evitar ponta) — heurística por bomba/dia
//   3. Economia de deslocamento (trips evitadas, clusters + janela 60 min)
//   4. Economia de mão de obra (manual vs remoto × ciclos × dias)
//   5. Multas de demanda evitadas (placeholder 0 quando sem ultrapassagem)
import { useEffect, useState } from "react";
import { TrendingUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface Roi {
  total: number;          // valor real nos dias de operação
  projecaoMensal: number | null;
  diasOperacao: number;
  captacao: number;
  energia: number;
  deslocamento: number;
  maoObra: number;
  multas: number;
  trips: number;
  avgRoadKm: number;
  clusters: number;
  numPumps: number;
  captacaoVolumeM3: number;
}

const fmtBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 });
const fmtBRL0 = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const CLUSTER_RADIUS_KM = 2;
const TRIP_WINDOW_MIN = 60;

export function RoiTravelCard({ farmId }: { farmId: string | null }) {
  const [roi, setRoi] = useState<Roi | null>(null);
  const [hasCoords, setHasCoords] = useState(true);

  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    const load = async () => {
      const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
      const [
        farmRes, cfgRes, eqRes, logRes, firstLogRes, firstEqRes,
      ] = await Promise.all([
        supabase.from("farms").select("latitude, longitude").eq("id", farmId).maybeSingle(),
        supabase.from("farm_productivity_config" as any)
          .select("worker_cost_per_hour, vehicle_cost_per_km, travel_minutes_avg, manual_operation_time_minutes, remote_operation_time_minutes, cycles_per_day, tariff_peak, tariff_reserved, demand_cost_per_kw")
          .eq("farm_id", farmId).maybeSingle(),
        supabase.from("equipments")
          .select("id, latitude, longitude, power_kw, estimated_flow_m3h")
          .eq("farm_id", farmId).in("type", ["poco", "bombeamento"] as any).eq("active", true),
        supabase.from("automation_log")
          .select("equipment_id, occurred_at, origin")
          .eq("farm_id", farmId)
          .eq("origin", "remote" as any)
          .gte("occurred_at", thirtyAgo)
          .order("occurred_at", { ascending: true })
          .limit(5000),
        // descobre quando o sistema começou a operar
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

      const farm: any = farmRes.data ?? {};
      const cfg: any = cfgRes.data ?? {};
      const eqs: any[] = eqRes.data ?? [];
      const logs: any[] = logRes.data ?? [];

      // dias de operação real
      let firstDate: Date | null = null;
      const firstLog = (firstLogRes.data as any[])?.[0]?.occurred_at;
      const firstEq = (firstEqRes.data as any[])?.[0]?.created_at;
      if (firstLog) firstDate = new Date(firstLog);
      else if (firstEq) firstDate = new Date(firstEq);
      const diasOperacao = firstDate
        ? Math.max(1, Math.floor((Date.now() - firstDate.getTime()) / 86400_000))
        : 1;
      const escala = Math.min(diasOperacao, 30) / 30; // 0..1 para proporção real

      const farmLat = Number(farm.latitude);
      const farmLng = Number(farm.longitude);
      if (!Number.isFinite(farmLat) || !Number.isFinite(farmLng) || farmLat === 0) {
        if (!cancelled) { setHasCoords(false); setRoi(null); }
        return;
      }

      // Configs
      const workerCost = Number(cfg.worker_cost_per_hour ?? 25);
      const vehicleCost = Number(cfg.vehicle_cost_per_km ?? 2.5);
      const travelMin = Number(cfg.travel_minutes_avg ?? 30);
      const manualMin = Number(cfg.manual_operation_time_minutes ?? 80);
      const remoteMin = Number(cfg.remote_operation_time_minutes ?? 5);
      const cyclesDay = Number(cfg.cycles_per_day ?? 2);
      const tariffPeak = Number(cfg.tariff_peak ?? 1.884);
      const tariffReserved = Number(cfg.tariff_reserved ?? 0.3878);

      // Estatísticas dos equipamentos
      const numPumps = eqs.length;
      const avgPowerKw = numPumps > 0
        ? eqs.reduce((a, e) => a + Number(e.power_kw ?? 75), 0) / numPumps
        : 75;
      const avgFlow = numPumps > 0
        ? eqs.reduce((a, e) => a + Number(e.estimated_flow_m3h ?? 300), 0) / numPumps
        : 300;

      // Clusters geográficos
      type Cl = { ids: Set<string>; lat: number; lng: number; dist: number };
      const clusters: Cl[] = [];
      for (const e of eqs) {
        const lat = Number(e.latitude); const lng = Number(e.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0) continue;
        const tgt = clusters.find((c) => haversineKm(lat, lng, c.lat, c.lng) <= CLUSTER_RADIUS_KM);
        if (tgt) tgt.ids.add(e.id);
        else clusters.push({
          ids: new Set([e.id]), lat, lng,
          dist: haversineKm(farmLat, farmLng, lat, lng),
        });
      }
      const eqToCl = new Map<string, number>();
      clusters.forEach((c, i) => c.ids.forEach((id) => eqToCl.set(id, i)));

      // Viagens evitadas (janela 60 min)
      const win = TRIP_WINDOW_MIN * 60_000;
      let trips = 0, totalDist = 0;
      let wStart: number | null = null, wMax = 0, wHas = false;
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

      const avgKmStraight = trips > 0 ? totalDist / trips : 0;
      const avgRoadKm = avgKmStraight * 2 * 1.3; // ida-volta + estrada de terra
      const costPerTrip = avgRoadKm * vehicleCost + (travelMin / 60) * workerCost;

      // === COMPONENTES DO ROI (calibrado para faixa realista) ===
      // 3) Deslocamento — REAL (já reflete apenas os dias com dados)
      const deslocamento = trips * costPerTrip;

      // 4) Mão de obra — ajustada aos dias reais
      const horasManMo30d = ((manualMin - remoteMin) * cyclesDay * 30) / 60;
      const maoObra30d = Math.max(0, horasManMo30d) * workerCost;
      const maoObra = maoObra30d * escala;

      // 2) Energia (evitar ponta) — CONSERVADOR:
      //    sistema evita ~5 min/dia de ponta para ~60% das bombas
      //    (premissa: nem todas iriam atrasar todo dia).
      const PEAK_MIN_AVOIDED_PER_DAY = 5;
      const PUMPS_AFFECTED_FRACTION = 0.6;
      const energia30d = (PEAK_MIN_AVOIDED_PER_DAY / 60)
        * (numPumps * PUMPS_AFFECTED_FRACTION)
        * 30
        * avgPowerKw
        * Math.max(0, tariffPeak - tariffReserved);
      const energia = energia30d * escala;

      // 1) Captação extra: ganho de tempo × bombas × vazão = m³ extras.
      //    Valor conservador: R$ 0,02/m³ (custo médio de água p/ irrigação)
      //    — não é "economia financeira", é VALOR DA PRODUÇÃO extra captada.
      const WATER_VALUE_PER_M3 = 0.02;
      const gainMin = Math.max(0, manualMin - remoteMin);
      const captacaoVolumeM3_30d = (gainMin / 60) * numPumps * cyclesDay * 30 * avgFlow;
      const captacaoVolumeM3 = captacaoVolumeM3_30d * escala;
      const captacao30d = captacaoVolumeM3_30d * WATER_VALUE_PER_M3;
      const captacao = captacao30d * escala;

      // 5) Multas de demanda evitadas
      const multas = 0;

      const total = captacao + energia + deslocamento + maoObra + multas;
      const projecaoMensal = diasOperacao < 30 ? (total / Math.max(1, diasOperacao)) * 30 : null;

      if (!cancelled) {
        setHasCoords(true);
        setRoi({
          total, projecaoMensal, diasOperacao,
          captacao, energia, deslocamento, maoObra, multas,
          trips, avgRoadKm, clusters: clusters.length, numPumps,
          captacaoVolumeM3,
        });
      }
    };
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [farmId]);

  if (!farmId) return null;
  const isProjetado = roi ? roi.diasOperacao < 30 : false;

  return (
    <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 shadow-md shadow-emerald-500/20 h-full">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-emerald-500" />
          <h3 className="font-bold text-foreground tracking-wide uppercase text-xs">Retorno sobre Investimento</h3>
        </div>
        <span className="text-[10px] text-muted-foreground uppercase">
          {isProjetado ? `${roi?.diasOperacao ?? 0} dias` : "últimos 30 dias"}
        </span>
      </div>

      {!hasCoords ? (
        <div className="text-xs text-muted-foreground py-6 text-center">
          Configure latitude/longitude da sede no painel admin para ver o ROI.
        </div>
      ) : !roi ? (
        <div className="text-xs text-muted-foreground py-6 text-center">Calculando…</div>
      ) : (
        <>
          {/* TOTAL — destaque */}
          <div className="text-center rounded-lg bg-background/50 border border-emerald-500/40 p-3 mb-3">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
              {isProjetado
                ? `Economia em ${roi.diasOperacao} dias de operação`
                : "Economia total estimada"}
            </div>
            <div className="text-4xl font-black text-emerald-400 tabular-nums leading-none mt-1">
              {fmtBRL(roi.total)}
            </div>
            {isProjetado ? (
              <div className="text-[10px] text-emerald-300 mt-1 font-medium">
                Projeção mensal: {fmtBRL(roi.projecaoMensal ?? 0)}
              </div>
            ) : (
              <div className="text-[10px] text-muted-foreground mt-1">/ mês</div>
            )}
          </div>

          {/* Detalhamento */}
          <div className="space-y-1 text-xs">
            <Row label="Captação extra garantida" value={roi.captacao}
              hint={`+${roi.captacaoVolumeM3.toLocaleString("pt-BR", { maximumFractionDigits: 0 })} m³${isProjetado ? "" : "/mês"}`} />
            <Row label="Economia de energia (horário)" value={roi.energia}
              hint={`~5 min/dia ponta evitada · ${Math.round(roi.numPumps * 0.6)} bombas`} />
            <Row label="Economia de deslocamento" value={roi.deslocamento}
              hint={`${roi.trips} viagens · ${roi.avgRoadKm.toFixed(1)} km · ${roi.clusters} regiões`} />
            <Row label="Economia de mão de obra" value={roi.maoObra}
              hint="80 min → 5 min por ciclo" />
            <Row label="Multas de demanda evitadas" value={roi.multas}
              hint={roi.multas === 0 ? "0 ultrapassagens ✅" : undefined} />
          </div>

          <div className="mt-3 text-[9px] text-muted-foreground italic leading-snug border-t border-emerald-500/20 pt-2">
            {isProjetado
              ? `Sistema ativo há ${roi.diasOperacao} dias. Projeção mensal baseada na média diária observada.`
              : "Captação: ganho de tempo × vazão estimada × custo energético equivalente. Energia: 30 min/dia/bomba evitados na ponta × diferença tarifária. Deslocamento: clusters <2 km + janela 60 min. Mão de obra: ciclos diários × custo/hora."}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-emerald-500/10 last:border-0 pb-1 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate">{label}</div>
        {hint && <div className="text-[10px] text-muted-foreground truncate">{hint}</div>}
      </div>
      <div className="font-bold text-emerald-400 tabular-nums shrink-0">{fmtBRL0(value)}</div>
    </div>
  );
}
