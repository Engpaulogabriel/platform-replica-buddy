// ============================================================================
// INEMA — Painel de Compliance Hídrico (Risco de Multa).
// Cruza uso REAL do dia (horas + volume) com os limites da outorga por poço.
// FONTE DOS LIMITES: water_permits + water_permit_wells (NÃO mais inema_permits,
// que estava vazia). A vinculação poço↔equipamento é AUTOMÁTICA:
//   1) water_permit_wells.equipment_id (vínculo explícito);
//   2) fallback pelo NÚMERO do poço no nome ("Poço 3" ↔ "POÇO 03 R2").
// Limites por poço: max_daily_hours = regime_hours_per_day; max_daily_volume_m3 =
// flow_rate_m3_day; max_flow_m3h = flow_rate_m3_day / regime_hours_per_day;
// expiration_date = validity_end. Barras: amarelo ≥80%, vermelho ≥95%.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useHorimetro } from "@/hooks/useHorimetro";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CalendarClock, Droplet, Clock, ShieldCheck, FileDown } from "lucide-react";
import { exportInemaCompliancePDF, type InemaComplianceRow } from "@/lib/reportExport";

// Thresholds globais (o cliente quer alerta ANTES de estourar).
const YELLOW_PCT = 80;
const RED_PCT = 95;

export interface InemaPermit {
  id?: string;
  farm_id: string;
  equipment_id: string;
  portaria_number: string | null;
  processo_number: string | null;
  titular_name: string | null;
  max_daily_hours: number | null;
  max_daily_volume_m3: number | null;
  expiration_date: string | null;
  latitude: number | null;
  longitude: number | null;
  observacoes: string | null;
  // Novos campos (INEMA — dados institucionais da outorga)
  process_number: string | null;         // Nº do Processo INEMA (ex: 2022-001234)
  max_flow_m3h: number | null;           // Vazão máxima outorgada (m³/h)
  water_use_purpose: string | null;      // Finalidade (Irrigação, Dessedentação animal…)
  hydrographic_basin: string | null;     // Bacia hidrográfica / Aquífero
}

interface WellCompliance {
  equipmentId: string;
  name: string;
  hoursToday: number;
  hoursLimit: number | null;
  hoursPct: number | null;
  hoursRemaining: number | null;
  volumeToday: number | null;
  volumeLimit: number | null;
  volumePct: number | null;
  volumeSource: "telemetria" | "estimado" | "—";
  monthVolume: number | null;
  monthVolumeLimit: number | null;
  monthVolumePct: number | null;
  status: "ok" | "warn" | "over" | "no-permit";
  permit: InemaPermit | null;
  daysToExpiry: number | null;
}

const pctColor = (pct: number | null): string =>
  pct == null ? "bg-muted"
  : pct >= RED_PCT ? "bg-destructive"
  : pct >= YELLOW_PCT ? "bg-amber-500"
  : "bg-primary";

const worstStatus = (h: number | null, v: number | null): WellCompliance["status"] => {
  const m = Math.max(h ?? 0, v ?? 0);
  if (h == null && v == null) return "ok";
  return m >= RED_PCT ? "over" : m >= YELLOW_PCT ? "warn" : "ok";
};

function daysBetween(dateIso: string | null): number | null {
  if (!dateIso) return null;
  const d = new Date(dateIso + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

// Extrai o PRIMEIRO número do texto ("Poço 3" → 3; "POÇO 03 R2" → 3).
// NÃO concatena todos os dígitos (senão "POÇO 03 R2" viraria 32 e não casaria).
function firstNum(s: string | null | undefined): number {
  const m = String(s ?? "").match(/\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}

/** Hook de compliance: outorgas (water_permits) + horas de hoje + volume por poço. */
export function useInemaCompliance(farmId: string | null | undefined) {
  const [permits, setPermits] = useState<InemaPermit[]>([]);
  const [equip, setEquip] = useState<Record<string, { name: string; estimated_flow_m3h: number | null; flow_total_m3: number | null; flow_daily_start_m3: number | null; outorga_volume_max_mensal_m3: number | null }>>({});
  const [farmHeader, setFarmHeader] = useState<{ name: string; city: string | null; state: string | null }>({ name: "Fazenda", city: null, state: null });
  const [score, setScore] = useState<{ scorePct: number | null; total: number; excedido: number } | null>(null);
  const [loading, setLoading] = useState(true);

  // "tick" a cada 1 min → o range do horímetro avança, o hook re-busca as horas
  // frescas e o contador regressivo (limite − operado) diminui em tempo real.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const todayStart = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const now = useMemo(() => new Date(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const hori = useHorimetro({ from: todayStart, to: now, enabled: !!farmId });

  const load = useCallback(async () => {
    if (!farmId) return;
    setLoading(true);
    // Outorgas: water_permits + water_permit_wells (NÃO inema_permits, que está vazia).
    const [{ data: wPermits }, { data: eqs }, { data: farm }] = await Promise.all([
      supabase.from("water_permits" as any)
        .select("id, permit_number, process_number, purpose, basin, validity_end, regime_hours_per_day, holder_name")
        .eq("farm_id", farmId),
      supabase.from("equipments").select("id,name,estimated_flow_m3h,flow_total_m3,flow_daily_start_m3,outorga_volume_max_mensal_m3").eq("farm_id", farmId).eq("type", "poco"),
      supabase.from("farms").select("name,city,state").eq("id", farmId).maybeSingle(),
    ]);
    if (farm) setFarmHeader({ name: (farm as any).name ?? "Fazenda", city: (farm as any).city ?? null, state: (farm as any).state ?? null });

    const eqList = ((eqs as any[]) ?? []);
    const map: typeof equip = {};
    for (const e of eqList) {
      map[e.id] = { name: e.name, estimated_flow_m3h: e.estimated_flow_m3h ?? null, flow_total_m3: e.flow_total_m3 ?? null, flow_daily_start_m3: e.flow_daily_start_m3 ?? null, outorga_volume_max_mensal_m3: (e as any).outorga_volume_max_mensal_m3 ?? null };
    }
    setEquip(map);

    // ── Vinculação AUTOMÁTICA poço da outorga → equipamento ──────────────────
    const permitList = ((wPermits as any[]) ?? []);
    let wells: any[] = [];
    if (permitList.length) {
      const { data: ww } = await supabase.from("water_permit_wells" as any)
        .select("permit_id, equipment_id, well_name, flow_rate_m3_day")
        .in("permit_id", permitList.map((p) => p.id));
      wells = ((ww as any[]) ?? []);
    }
    const permitById = new Map<string, any>(permitList.map((p) => [p.id, p]));
    // Índice número-do-poço → equipment_id (para o fallback).
    const eqByNumber = new Map<number, string>();
    for (const e of eqList) {
      const n = firstNum(e.name);
      if (Number.isFinite(n) && !eqByNumber.has(n)) eqByNumber.set(n, e.id);
    }
    // Vínculo explícito primeiro (prioridade sobre o casamento por número).
    const orderedWells = wells.slice().sort((a, b) => (a.equipment_id ? 0 : 1) - (b.equipment_id ? 0 : 1));
    const built: InemaPermit[] = [];
    const usedEq = new Set<string>();
    for (const w of orderedWells) {
      const p = permitById.get(w.permit_id);
      if (!p) continue;
      // 1) vínculo explícito; 2) fallback pelo número do poço no nome.
      let eqId: string | null = (w.equipment_id as string | null) ?? null;
      if (!eqId) {
        const n = firstNum(w.well_name);
        if (Number.isFinite(n) && eqByNumber.has(n)) eqId = eqByNumber.get(n)!;
      }
      if (!eqId || usedEq.has(eqId)) continue; // 1 outorga por equipamento (o 1º vence)
      usedEq.add(eqId);
      const daily = Number(w.flow_rate_m3_day || 0);
      const hrs = Number(p.regime_hours_per_day ?? 18) || 18;
      built.push({
        farm_id: farmId,
        equipment_id: eqId,
        portaria_number: p.permit_number ?? null,
        processo_number: null,
        titular_name: p.holder_name ?? null,
        max_daily_hours: p.regime_hours_per_day ?? 18,
        max_daily_volume_m3: daily || null,
        expiration_date: p.validity_end ?? null,
        latitude: null,
        longitude: null,
        observacoes: null,
        process_number: p.process_number ?? null,
        max_flow_m3h: hrs > 0 && daily > 0 ? Math.round((daily / hrs) * 100) / 100 : null,
        water_use_purpose: p.purpose ?? null,
        hydrographic_basin: p.basin ?? null,
      });
    }
    setPermits(built);

    // Score de conformidade (30d) — histórico persistido. Defensivo: se a migration
    // ainda não foi aplicada (RPC inexistente), apenas oculta.
    try {
      const { data: sc, error: scErr } = await supabase.rpc("inema_farm_score" as any, { _farm_id: farmId, _days: 30 });
      const row: any = Array.isArray(sc) ? sc[0] : sc;
      setScore(!scErr && row ? { scorePct: row.score_pct ?? null, total: Number(row.total_dias ?? 0), excedido: Number(row.dias_excedido ?? 0) } : null);
    } catch { setScore(null); }
    setLoading(false);
  }, [farmId]);
  useEffect(() => { void load(); }, [load]);

  const hoursByEq = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of (hori.byPump ?? [])) m[p.equipmentId] = p.monthTotal; // range = hoje
    return m;
  }, [hori.byPump]);

  // Horas do MÊS corrente por poço (para o volume mensal vs limite mensal).
  const monthHoursByEq = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of (hori.byPump ?? [])) m[p.equipmentId] = p.currentMonthTotal ?? 0;
    return m;
  }, [hori.byPump]);

  const wells = useMemo<WellCompliance[]>(() => {
    const byEq = new Map<string, InemaPermit>();
    for (const p of permits) byEq.set(p.equipment_id, p);
    // universo = poços com outorga OU com atividade hoje
    const ids = new Set<string>([...permits.map((p) => p.equipment_id), ...Object.keys(hoursByEq)]);
    const out: WellCompliance[] = [];
    for (const id of ids) {
      const permit = byEq.get(id) ?? null;
      const e = equip[id];
      const name = e?.name ?? permit?.equipment_id?.slice(0, 8) ?? "Poço";
      const hoursToday = Math.round((hoursByEq[id] ?? 0) * 100) / 100;
      const hoursLimit = permit?.max_daily_hours ?? null;
      const hoursPct = hoursLimit && hoursLimit > 0 ? Math.round((hoursToday / hoursLimit) * 1000) / 10 : null;
      const hoursRemaining = hoursLimit != null ? Math.max(0, Math.round((hoursLimit - hoursToday) * 10) / 10) : null;

      // volume: telemetria (flow_total - flow_daily_start) SÓ quando > 0 (há sensor
      // de vazão real medindo). Sem sensor, flow_total/flow_daily_start ficam 0 e
      // telemDaily=0 — nesse caso usa o ESTIMADO = horas × vazão nominal.
      let volumeToday: number | null = null;
      let volumeSource: WellCompliance["volumeSource"] = "—";
      const telemDaily = e && e.flow_total_m3 != null && e.flow_daily_start_m3 != null
        ? e.flow_total_m3 - e.flow_daily_start_m3 : null;
      if (telemDaily != null && telemDaily > 0) {
        volumeToday = Math.round(telemDaily);
        volumeSource = "telemetria";
      } else if (e?.estimated_flow_m3h != null && e.estimated_flow_m3h > 0) {
        // Sem sensor de vazão real → ESTIMA: horas operadas hoje × vazão nominal.
        volumeToday = Math.round(hoursToday * e.estimated_flow_m3h);
        volumeSource = "estimado";
      }

      const volumeLimit = permit?.max_daily_volume_m3 ?? null;
      const volumePct = volumeLimit && volumeLimit > 0 && volumeToday != null ? Math.round((volumeToday / volumeLimit) * 1000) / 10 : null;

      // Volume do MÊS (estimado: horas do mês × vazão) vs limite mensal da outorga.
      const monthVolume = e?.estimated_flow_m3h ? Math.round((monthHoursByEq[id] ?? 0) * e.estimated_flow_m3h) : null;
      const monthVolumeLimit = e?.outorga_volume_max_mensal_m3 ?? null;
      const monthVolumePct = monthVolumeLimit && monthVolumeLimit > 0 && monthVolume != null ? Math.round((monthVolume / monthVolumeLimit) * 1000) / 10 : null;

      out.push({
        equipmentId: id, name, hoursToday, hoursLimit, hoursPct, hoursRemaining,
        volumeToday, volumeLimit, volumePct, volumeSource,
        monthVolume, monthVolumeLimit, monthVolumePct,
        status: permit ? worstStatus(Math.max(hoursPct ?? 0, monthVolumePct ?? 0) || null, volumePct) : "no-permit",
        permit, daysToExpiry: daysBetween(permit?.expiration_date ?? null),
      });
    }
    return out.sort((a, b) => (b.hoursPct ?? -1) - (a.hoursPct ?? -1));
  }, [permits, equip, hoursByEq, monthHoursByEq]);

  // Renovação: faixas 180 / 90 / 30 dias antes do vencimento.
  const expiring = useMemo(
    () => wells.filter((w) => w.daysToExpiry != null && w.daysToExpiry <= 180)
      .sort((a, b) => (a.daysToExpiry ?? 0) - (b.daysToExpiry ?? 0)),
    [wells],
  );

  return { wells, expiring, loading: loading || hori.loading, reload: load, permits, farmHeader, score };
}

// Barra COMPACTA: só ícone + valor/limite + % + barra fina. `hint` = "est." p/ estimado.
function Bar({ icon, value, limit, unit, pct, hint }: {
  icon: React.ReactNode; value: number | null; limit: number | null; unit: string; pct: number | null; hint?: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-1 text-[10px] leading-none">
        <span className="text-muted-foreground shrink-0">{icon}</span>
        <span className="tabular-nums truncate">
          {value == null ? "—" : value.toLocaleString("pt-BR")}
          <span className="text-muted-foreground">/{limit != null ? limit.toLocaleString("pt-BR") : "—"}{unit}</span>
          {pct != null ? <span className={`ml-0.5 font-bold ${pct >= RED_PCT ? "text-destructive" : pct >= YELLOW_PCT ? "text-amber-600" : "text-muted-foreground"}`}>{pct}%</span> : null}
          {hint ? <span className="text-muted-foreground/70 ml-0.5">{hint}</span> : null}
        </span>
      </div>
      <Progress value={pct == null ? 0 : Math.min(100, pct)} className="h-1.5" indicatorClassName={pctColor(pct)} />
    </div>
  );
}

// "Xh YYmin" a partir de horas decimais (ex.: 3.6 → "3h 36min").
function fmtHm(h: number): string {
  const total = Math.max(0, Math.round(h * 60));
  const hh = Math.floor(total / 60), mm = total % 60;
  return `${hh}h ${String(mm).padStart(2, "0")}min`;
}

// Contador regressivo COMPACTO. Cores: verde >20% restante; amarelo 10–20%;
// vermelho PISCANDO <10%; vermelho fixo "LIMITE ATINGIDO" em 0.
function Countdown({ kind, remaining, limit }: {
  kind: "horas" | "volume"; remaining: number | null; limit: number | null;
}) {
  if (limit == null || limit <= 0 || remaining == null) return null;
  const rem = Math.max(0, remaining);
  const pctRem = rem / limit;
  const atLimit = rem <= 0;
  const tone = atLimit
    ? "text-destructive font-bold"
    : pctRem < 0.1 ? "text-destructive font-bold animate-pulse"
    : pctRem < 0.2 ? "text-amber-600 font-semibold"
    : "text-primary";
  const value = kind === "horas" ? fmtHm(rem) : `${Math.round(rem).toLocaleString("pt-BR")} m³`;
  return (
    <div className={`text-[10px] leading-none ${tone}`}>
      {atLimit ? "🚨 LIMITE ATINGIDO" : `restam ${value}`}
    </div>
  );
}

const statusLabel = (s: WellCompliance["status"]) =>
  s === "over" ? "Risco" : s === "warn" ? "Atenção" : s === "no-permit" ? "Sem outorga" : "OK";

// Badge de status curto (cabe no card compacto).
function StatusBadge({ status }: { status: WellCompliance["status"] }) {
  const map: Record<WellCompliance["status"], [string, string]> = {
    over: ["Infração", "bg-destructive/20 text-destructive border-destructive/50"],
    warn: ["Atenção", "bg-amber-500/20 text-amber-600 border-amber-500/50"],
    ok: ["OK", "bg-primary/15 text-primary border-primary/40"],
    "no-permit": ["s/ outorga", "bg-muted text-muted-foreground border-border"],
  };
  const [label, cls] = map[status];
  return <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${cls}`}>{label}</span>;
}

export function InemaCompliancePanel({ farmId }: { farmId: string | null | undefined }) {
  const { wells, expiring, loading, farmHeader, score } = useInemaCompliance(farmId);

  const exportPdf = () => {
    const rows: InemaComplianceRow[] = wells.filter((w) => w.permit).map((w) => ({
      well: w.name,
      hoursToday: w.hoursToday, hoursLimit: w.hoursLimit,
      volumeToday: w.volumeToday, volumeLimit: w.volumeLimit,
      monthVolume: w.monthVolume, monthVolumeLimit: w.monthVolumeLimit,
      status: statusLabel(w.status),
      portaria: w.permit?.portaria_number ?? null,
      titular: w.permit?.titular_name ?? null,
      expiry: w.permit?.expiration_date ? new Date(w.permit.expiration_date + "T00:00:00").toLocaleDateString("pt-BR") : null,
      processNumber: w.permit?.process_number ?? null,
      maxFlowM3h: w.permit?.max_flow_m3h ?? null,
      waterUsePurpose: w.permit?.water_use_purpose ?? null,
      hydrographicBasin: w.permit?.hydrographic_basin ?? null,
    }));
    void exportInemaCompliancePDF(rows, farmHeader);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-primary" />Compliance Hídrico — Risco de Multa</h3>
        {score && score.total > 0 && (
          <Badge variant={score.scorePct != null && score.scorePct >= 95 ? "secondary" : "destructive"} className="gap-1">
            Conformidade 30d: {score.scorePct ?? "—"}% ({score.total - score.excedido}/{score.total} dias)
          </Badge>
        )}
        <Button size="sm" variant="outline" onClick={exportPdf} disabled={wells.filter((w) => w.permit).length === 0}>
          <FileDown className="w-4 h-4 mr-1.5" />PDF de Compliance
        </Button>
      </div>
      {/* Renovação de outorga — faixas 180 / 90 / 30 dias */}
      {expiring.length > 0 && (() => {
        const min = expiring[0].daysToExpiry ?? 999;
        const tier = min <= 30 ? "destructive" : min <= 90 ? "border-amber-500/60" : "border-amber-500/30";
        const faixa = min <= 30 ? "≤ 30 dias — URGENTE" : min <= 90 ? "≤ 90 dias" : "≤ 180 dias";
        return (
          <Alert className={tier === "destructive" ? "border-destructive/60" : tier}>
            <CalendarClock className="h-4 w-4" />
            <AlertDescription className="text-sm">
              <strong>Renovação de outorga ({faixa}):</strong>{" "}
              {expiring.map((w) => `${w.name} vence em ${w.daysToExpiry}d`).join(" · ")}.
            </AlertDescription>
          </Alert>
        );
      })()}

      {loading && wells.length === 0 ? (
        <p className="text-sm text-muted-foreground px-1">Carregando compliance…</p>
      ) : wells.length === 0 ? (
        <Alert><ShieldCheck className="h-4 w-4" /><AlertDescription>Nenhum poço com outorga vinculada. Cadastre as outorgas (water_permits) e os poços (water_permit_wells) — a vinculação aos equipamentos é automática (por vínculo explícito ou pelo número do poço).</AlertDescription></Alert>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
          {wells.map((w) => {
            const tip = w.permit?.portaria_number
              ? `Portaria ${w.permit.portaria_number} · ${w.permit.titular_name ?? "—"}${w.daysToExpiry != null ? ` · validade em ${w.daysToExpiry}d` : ""}`
              : "Sem outorga vinculada";
            const border = w.status === "over" ? "border-destructive/60" : w.status === "warn" ? "border-amber-500/60" : w.status === "no-permit" ? "border-border" : "border-primary/30";
            return (
              <Card key={w.equipmentId} title={tip} className={`p-2 space-y-1.5 ${border}`}>
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-bold text-foreground truncate" title={w.name}>{w.name}</span>
                  <StatusBadge status={w.status} />
                </div>
                <Bar icon={<Clock className="w-3 h-3" />} value={w.hoursToday} limit={w.hoursLimit} unit="h" pct={w.hoursPct} />
                <Countdown kind="horas" remaining={w.hoursLimit != null ? w.hoursLimit - w.hoursToday : null} limit={w.hoursLimit} />
                <Bar icon={<Droplet className="w-3 h-3" />} value={w.volumeToday} limit={w.volumeLimit} unit="m³" pct={w.volumePct} hint={w.volumeSource === "estimado" ? "est." : undefined} />
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
