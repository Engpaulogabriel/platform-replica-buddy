// useRenovImpact — impacto do sistema RENOV por fazenda, DINÂMICO (funciona pra
// qualquer fazenda) a partir de dados REAIS do banco. Separa o que é MEDIDO
// (economia defensável: deslocamento + energia) do que é ESTIMADO por premissa
// (m³ extras, multas, pessoal, manutenção) — cada estimativa carrega a premissa.
// Requer ≥30 dias de operação; senão retorna insufficientData=true.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// ── Premissas (conservadoras, rotuladas na UI). safraValuePerM3 e monthlySalary
//    começam em 0 = "configurar" (não assume valor sem o dado do cliente). ────
export const IMPACT_PREMISES = {
  costPerKm: 1.5,          // R$/km (combustível + desgaste)
  terrainSpeedKmh: 15,     // velocidade média em terreno ruim
  wellsPerOperator: 4,     // 1 operador presencial cobre ~4 poços
  fineValue: 10000,        // R$ por infração INEMA evitada (conservador)
  pumpReplaceCost: 80000,  // R$ troca de bomba submersível
  highWearRatio: 0.7,      // ≥70% do tempo ligado em 30d = desgaste alto (detecção)
  cvToKw: 0.7355,          // 1 CV ≈ 0,7355 kW
  // Configuráveis por fazenda (default 0 → card mostra "requer valor"):
  safraValuePerM3: 0,      // R$/m³ da safra
  monthlySalary: 0,        // salário médio regional (R$/mês)
};

const PERIOD_DAYS = 30;
const MIN_DAYS = 30;
const HORAS_MES = PERIOD_DAYS;

const haversineKm = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const R = 6371, toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
// Hora local BRT (UTC-3) a partir de ISO.
const hourBRT = (iso: string): number => (new Date(iso).getUTCHours() + 21) % 24;

export interface ImpactItem { value: number | null; note?: string; }
export interface RenovImpact {
  loading: boolean;
  insufficientData: boolean;
  daysOfData: number;
  wellCount: number;
  remoteRatio: number;      // 0..1
  // MEDIDO (headline defensável)
  deslocamento: number;     // R$/mês
  deslocamentoKm: number;   // km/mês evitados
  deslocamentoHoras: number;// h/mês economizadas
  energia: number;          // R$/mês
  energiaHoras: number;     // horas de ponta evitadas
  measuredTotal: number;    // deslocamento + energia
  // ESTIMADO (premissas)
  m3Extra: number;          // m³/mês
  m3ExtraValue: number | null; // R$ (null se safra=0)
  multasEvitadas: number;   // R$ (premissa)
  multasOcorrencias: number;
  pessoalReduzidos: number; // nº operadores
  pessoalValue: number | null; // R$ (null se salário=0)
  manutencaoDetec: number;  // nº bombas em desgaste alto
  manutencaoValue: number;  // R$ potencial (premissa)
  estimatedTotal: number;   // soma dos estimados em R$ (só os com valor)
}

export function useRenovImpact(farmId: string | null | undefined): RenovImpact {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<{
    eqs: any[]; logs: any[]; cmds: any[]; cfg: any; hoursByEq: Record<string, number>;
    regimeHours: number; earliestIso: string | null;
  } | null>(null);

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - PERIOD_DAYS * 86_400_000);
    return { from, to };
  }, []);

  const load = useCallback(async () => {
    if (!farmId) { setData(null); setLoading(false); return; }
    setLoading(true);
    const fromIso = range.from.toISOString(), toIso = range.to.toISOString();
    const [{ data: eqs }, { data: logs }, { data: cmds }, { data: cfg }, { data: horas }, { data: permits }, { data: earliest }] =
      await Promise.all([
        supabase.from("equipments").select("id,name,latitude,longitude,estimated_flow_m3h,power_kw,power_cv")
          .eq("farm_id", farmId).eq("active", true).in("type", ["poco", "bombeamento"]).order("name"),
        supabase.from("automation_log").select("origin,action,occurred_at,equipment_id")
          .eq("farm_id", farmId).gte("occurred_at", fromIso).in("action", ["turn_on", "turn_off"]),
        supabase.from("commands").select("created_at,responded_at")
          .eq("farm_id", farmId).gte("created_at", fromIso).not("responded_at", "is", null).limit(2000),
        supabase.from("farm_productivity_config").select("tariff_peak,tariff_off_peak,manual_travel_minutes_per_trigger,safra_value_per_m3,monthly_salary_regional").eq("farm_id", farmId).maybeSingle(),
        supabase.rpc("get_horimetro_daily", { _farm_id: farmId, _from: fromIso, _to: toIso }),
        supabase.from("water_permits" as any).select("regime_hours_per_day").eq("farm_id", farmId).limit(1).maybeSingle(),
        supabase.from("automation_log").select("occurred_at").eq("farm_id", farmId).order("occurred_at", { ascending: true }).limit(1).maybeSingle(),
      ]);
    const hoursByEq: Record<string, number> = {};
    for (const r of (horas ?? []) as Array<{ equipment_id: string; hours: number }>) {
      hoursByEq[r.equipment_id] = (hoursByEq[r.equipment_id] ?? 0) + Number(r.hours || 0);
    }
    setData({
      eqs: (eqs ?? []) as any[], logs: (logs ?? []) as any[], cmds: (cmds ?? []) as any[],
      cfg: cfg ?? null, hoursByEq,
      regimeHours: Number((permits as any)?.regime_hours_per_day ?? 18) || 18,
      earliestIso: (earliest as any)?.occurred_at ?? null,
    });
    setLoading(false);
  }, [farmId, range.from, range.to]);

  useEffect(() => { void load(); }, [load]);

  return useMemo<RenovImpact>(() => {
    const empty: RenovImpact = {
      loading, insufficientData: true, daysOfData: 0, wellCount: 0, remoteRatio: 0,
      deslocamento: 0, deslocamentoKm: 0, deslocamentoHoras: 0, energia: 0, energiaHoras: 0, measuredTotal: 0,
      m3Extra: 0, m3ExtraValue: null, multasEvitadas: 0, multasOcorrencias: 0,
      pessoalReduzidos: 0, pessoalValue: null, manutencaoDetec: 0, manutencaoValue: 0, estimatedTotal: 0,
    };
    if (loading || !data) return empty;

    const { eqs, logs, cmds, cfg, hoursByEq, regimeHours, earliestIso } = data;
    const wellCount = eqs.length;
    const daysOfData = earliestIso ? Math.floor((Date.now() - new Date(earliestIso).getTime()) / 86_400_000) : 0;
    if (wellCount === 0 || daysOfData < MIN_DAYS) return { ...empty, loading: false, wellCount, daysOfData };

    const P = IMPACT_PREMISES;
    const tariffPeak = Number(cfg?.tariff_peak ?? 2.8);
    const tariffOff = Number(cfg?.tariff_off_peak ?? 0.55);
    const dTarifa = Math.max(0, tariffPeak - tariffOff);
    const manualTravelMin = Number(cfg?.manual_travel_minutes_per_trigger ?? 0) || 0;
    // Premissas configuráveis por fazenda (farm_productivity_config). 0 = "requer valor".
    const safraValue = Number(cfg?.safra_value_per_m3 ?? 0) || 0;
    const salaryRegional = Number(cfg?.monthly_salary_regional ?? 0) || 0;

    const powerKw = (e: any): number => e.power_kw != null && e.power_kw > 0 ? Number(e.power_kw)
      : e.power_cv != null && e.power_cv > 0 ? Number(e.power_cv) * P.cvToKw : 75;
    const withCoords = eqs.filter((e) => e.latitude != null && e.longitude != null);
    const centroid = withCoords.length
      ? { lat: withCoords.reduce((s, e) => s + Number(e.latitude), 0) / withCoords.length,
          lon: withCoords.reduce((s, e) => s + Number(e.longitude), 0) / withCoords.length }
      : null;
    const distToWell = (e: any): number => (centroid && e.latitude != null && e.longitude != null)
      ? haversineKm(centroid.lat, centroid.lon, Number(e.latitude), Number(e.longitude)) : 0;
    // minutos que o operador levaria pra chegar (terreno ruim) — ou config, se maior.
    const manualMinFor = (e: any): number => {
      const byDist = centroid ? (distToWell(e) / P.terrainSpeedKmh) * 60 : 0;
      return Math.max(byDist, manualTravelMin);
    };

    // Acionamentos: remotos/auto vs local.
    const isRemote = (o: string) => o === "remote" || o === "auto" || o === "system" || o === "automatico" || o === "automacao";
    const totalActions = logs.length;
    const remoteActions = logs.filter((l) => isRemote(String(l.origin))).length;
    const remoteRatio = totalActions > 0 ? remoteActions / totalActions : 0;

    // ── #1 DESLOCAMENTO (MEDIDO) ─────────────────────────────────────────────
    // Rota sequencial entre poços (por nome). km/dia = rota × 2 × remoteRatio.
    let routeKm = 0;
    for (let i = 1; i < withCoords.length; i++) {
      const a = withCoords[i - 1], b = withCoords[i];
      routeKm += haversineKm(Number(a.latitude), Number(a.longitude), Number(b.latitude), Number(b.longitude));
    }
    const kmMes = routeKm * 2 * remoteRatio * HORAS_MES;
    const deslocamento = kmMes * P.costPerKm;
    const deslocamentoHoras = P.terrainSpeedKmh > 0 ? kmMes / P.terrainSpeedKmh : 0;

    // ── #2 ENERGIA (MEDIDO) ──────────────────────────────────────────────────
    // Desligamentos remotos/auto na janela de ponta (17–21h): sem o sistema o
    // operador levaria manualMin/poço → esse tempo ficaria na ponta.
    const eqById = new Map(eqs.map((e) => [e.id, e]));
    let energia = 0, energiaHoras = 0;
    for (const l of logs) {
      if (l.action !== "turn_off" || !isRemote(String(l.origin))) continue;
      const h = hourBRT(l.occurred_at);
      if (!(h >= 17 && h < 21)) continue;
      const e = l.equipment_id ? eqById.get(l.equipment_id) : null;
      if (!e) continue;
      const avoidH = manualMinFor(e) / 60;
      energiaHoras += avoidH;
      energia += avoidH * powerKw(e) * dTarifa;
    }

    const measuredTotal = deslocamento + energia;

    // ── #3 m³ EXTRAS (ESTIMADO — safra) ──────────────────────────────────────
    // Tempo real de resposta (commands) vs tempo manual (distância/15km/h).
    const respMins = cmds.map((c) => (new Date(c.responded_at).getTime() - new Date(c.created_at).getTime()) / 60000)
      .filter((m) => m >= 0 && m < 240);
    const avgRespMin = respMins.length ? respMins.reduce((s, m) => s + m, 0) / respMins.length : 0;
    let m3Extra = 0;
    for (const l of logs) {
      if (l.action !== "turn_on" || !isRemote(String(l.origin))) continue;
      const e = l.equipment_id ? eqById.get(l.equipment_id) : null;
      if (!e || e.estimated_flow_m3h == null) continue;
      const diffMin = Math.max(0, manualMinFor(e) - avgRespMin);
      m3Extra += (diffMin / 60) * Number(e.estimated_flow_m3h);
    }
    const m3ExtraValue = safraValue > 0 ? m3Extra * safraValue : null;

    // ── #4 MULTAS EVITADAS (ESTIMADO) ────────────────────────────────────────
    // Dias com desligamento auto/remoto na aproximação da ponta (compliance).
    const complianceDays = new Set<string>();
    for (const l of logs) {
      if (l.action !== "turn_off" || !isRemote(String(l.origin))) continue;
      const h = hourBRT(l.occurred_at);
      if (h >= 16 && h < 18) complianceDays.add(l.occurred_at.slice(0, 10));
    }
    const multasOcorrencias = complianceDays.size;
    const multasEvitadas = multasOcorrencias * P.fineValue;

    // ── #5 PESSOAL (ESTIMADO — premissa) ─────────────────────────────────────
    const operatorsBefore = Math.ceil(wellCount / P.wellsPerOperator);
    const pessoalReduzidos = Math.max(0, operatorsBefore - 1);
    const pessoalValue = salaryRegional > 0 ? pessoalReduzidos * salaryRegional : null;

    // ── #6 MANUTENÇÃO PREVENTIVA (ESTIMADO) ──────────────────────────────────
    const highWearThreshold = 24 * PERIOD_DAYS * P.highWearRatio; // horas em 30d
    const manutencaoDetec = eqs.filter((e) => (hoursByEq[e.id] ?? 0) >= highWearThreshold).length;
    const manutencaoValue = manutencaoDetec * P.pumpReplaceCost;

    const estimatedTotal = (m3ExtraValue ?? 0) + multasEvitadas + (pessoalValue ?? 0) + manutencaoValue;

    return {
      loading: false, insufficientData: false, daysOfData, wellCount, remoteRatio,
      deslocamento, deslocamentoKm: kmMes, deslocamentoHoras, energia, energiaHoras, measuredTotal,
      m3Extra, m3ExtraValue, multasEvitadas, multasOcorrencias,
      pessoalReduzidos, pessoalValue, manutencaoDetec, manutencaoValue, estimatedTotal,
    };
  }, [loading, data]);
}
