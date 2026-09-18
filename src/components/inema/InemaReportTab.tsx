// Relatório INEMA (Portaria 19452 / BA) — monitoramento de captação de água subterrânea.
// Por poço, por dia: horas de funcionamento (pump_runtime), vazão instantânea
// (equipments.estimated_flow_m3h) e volume captado (horas × vazão).
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Download, FileSpreadsheet, FileText, Loader2, Droplets, CalendarRange } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getSupabaseForFarm } from "@/lib/supabaseRouter";
import { exportInemaPDF, exportInemaXLSX, exportInemaAnnualPDF, type InemaReportData, type InemaFarmHeader, type InemaAnnualReportData, type InemaAnnualPump, type InemaAnnualMonth, type InemaSignatureTitular, type InemaSignatureRT } from "@/lib/reportExport";
import { notify } from "@/lib/notify";


type Grouping = "dia" | "semana" | "mes";

interface Props {
  farmId: string | null;
  fromDate: string;
  toDate: string;
}

interface EquipmentRow {
  id: string;
  name: string;
  type: string;
  estimated_flow_m3h: number | null;
  latitude?: number | null;
  longitude?: number | null;
}

interface RuntimeRow {
  equipment_id: string;
  started_at: string;
  ended_at: string | null;
}

interface DailyPumpRow {
  bucket: string; // YYYY-MM-DD (dia inicial do agrupamento)
  bucketLabel: string;
  equipmentId: string;
  equipmentName: string;
  hours: number;
  flowRate: number | null;
  volume: number | null; // m³ no bucket
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfWeek(d: Date): Date {
  const x = new Date(d);
  const dow = x.getDay(); // 0 = Dom
  x.setDate(x.getDate() - dow);
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function fmtDateBR(iso: string): string {
  const [y, m, dd] = iso.split("-");
  return `${dd}/${m}/${y}`;
}
function bucketize(day: Date, group: Grouping): { key: string; label: string } {
  if (group === "dia") return { key: ymd(day), label: fmtDateBR(ymd(day)) };
  if (group === "semana") {
    const s = startOfWeek(day);
    const e = new Date(s); e.setDate(e.getDate() + 6);
    return { key: ymd(s), label: `${fmtDateBR(ymd(s))} - ${fmtDateBR(ymd(e))}` };
  }
  const s = startOfMonth(day);
  const label = s.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  return { key: ymd(s), label: label.charAt(0).toUpperCase() + label.slice(1) };
}

function fmtHours(h: number): string {
  const total = Math.max(0, Math.round(h * 60));
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  if (hh === 0) return `${mm} min`;
  return `${hh}h ${String(mm).padStart(2, "0")}min`;
}
function fmtNum(n: number, dec = 2): string {
  return n.toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export default function InemaReportTab({ farmId, fromDate, toDate }: Props) {
  const [loading, setLoading] = useState(false);
  const [equipments, setEquipments] = useState<EquipmentRow[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeRow[]>([]);
  const [group, setGroup] = useState<Grouping>("dia");
  const [farmHeader, setFarmHeader] = useState<InemaFarmHeader>({
    name: "Fazenda", city: null, state: null, cnpj: null, proprietario: null,
    endereco: null, zip_code: null, phone: null, email: null,
    latitude: null, longitude: null,
    outorgaNumero: null, orgao: null, vazaoOutorgadaM3h: null, permits: [],
  });
  const [permitByEq, setPermitByEq] = useState<Map<string, { max_flow_m3h: number | null; max_daily_volume_m3: number | null; max_daily_hours: number | null }>>(new Map());



  const range = useMemo(() => ({
    from: new Date(`${fromDate}T00:00:00`),
    to: new Date(`${toDate}T23:59:59.999`),
  }), [fromDate, toDate]);

  // Carrega equipamentos-poço e cabeçalho
  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    (async () => {
      // OUTORGA vinda de water_permits (+ water_permit_wells), NÃO de inema_permits
      // (que está vazia e deixava o PDF com "—"). O resto do fluxo é idêntico.
      const [{ data: eq }, { data: farm }, { data: inema }, { data: wPermits }] = await Promise.all([
        getSupabaseForFarm(farmId).from("equipments")
          .select("id, name, type, estimated_flow_m3h, is_captacao, latitude, longitude")
          .eq("farm_id", farmId)
          .eq("is_captacao", true)
          .order("name"),
        supabase.from("farms")
          .select("name, city, state, cnpj, proprietario, endereco, zip_code, phone, email, latitude, longitude")
          .eq("id", farmId).maybeSingle(),
        getSupabaseForFarm(farmId).from("farm_inema_config" as any)
          .select("outorga_numero, orgao, vazao_outorgada_m3h")
          .eq("farm_id", farmId).maybeSingle(),
        getSupabaseForFarm(farmId).from("water_permits" as any)
          .select("id, permit_number, process_number, purpose, basin, validity_end, permit_date, regime_hours_per_day, municipality, holder_name, holder_cpf_cnpj")
          .eq("farm_id", farmId)
          .order("validity_end", { ascending: false }),
      ]);

      if (cancelled) return;

      // Poços das outorgas (water_permit_wells) — ligados por permit_id.
      const permitsList = ((wPermits as any[] | null) ?? []);
      let wells: any[] = [];
      if (permitsList.length) {
        const { data: ww } = await getSupabaseForFarm(farmId).from("water_permit_wells" as any)
          .select("permit_id, equipment_id, well_name, flow_rate_m3_day")
          .in("permit_id", permitsList.map((p) => p.id));
        wells = ((ww as any[] | null) ?? []);
      }
      if (cancelled) return;

      // Apenas equipamentos de captação com nome válido (regra INEMA)
      const list = (eq ?? []).filter((e: any) =>
        e.name && String(e.name).trim() !== "" && e.name !== "—"
      ) as EquipmentRow[];
      setEquipments(list);

      // ── Monta permits[] (InemaPermitHeader) de water_permits + wells ─────────
      const wellsSum = (permitId: string) =>
        wells.filter((w) => w.permit_id === permitId).reduce((a, w) => a + Number(w.flow_rate_m3_day || 0), 0);
      const today = new Date().toISOString().slice(0, 10);
      const mainPermit = (() => {
        const vig = permitsList.filter((p) => !p.validity_end || p.validity_end >= today);
        const pool = vig.length ? vig : permitsList;
        return pool.slice().sort((a, b) => String(b.permit_date ?? "").localeCompare(String(a.permit_date ?? "")))[0] ?? null;
      })();
      const permitHeaders = permitsList.map((p) => {
        const volDay = wellsSum(p.id);
        const hrs = Number(p.regime_hours_per_day ?? 18) || 18;
        return {
          _permitId: p.id as string,
          portaria_number: p.permit_number ?? null,
          process_number: p.process_number ?? null,
          water_use_purpose: p.purpose ?? null,
          hydrographic_basin: p.basin ?? null,
          expiration_date: p.validity_end ?? null,
          max_flow_m3h: hrs > 0 ? Math.round((volDay / hrs) * 100) / 100 : null,
          max_daily_volume_m3: volDay || null,
          max_daily_hours: p.regime_hours_per_day ?? null,
          equipment_id: null as string | null,
        };
      });
      // Portaria principal (vigente mais recente) em primeiro — o PDF usa permits[0].
      if (mainPermit) {
        permitHeaders.sort((a, b) => (a._permitId === mainPermit.id ? -1 : b._permitId === mainPermit.id ? 1 : 0));
      }
      const mainVolDay = mainPermit ? wellsSum(mainPermit.id) : 0;
      const mainHrs = Number(mainPermit?.regime_hours_per_day ?? 18) || 18;

      const inemaData = inema as any;
      const farmAny = farm as any;
      setFarmHeader({
        name: farm?.name ?? "Fazenda",
        city: farmAny?.city ?? mainPermit?.municipality ?? null,
        state: farmAny?.state ?? null,
        cnpj: farmAny?.cnpj ?? mainPermit?.holder_cpf_cnpj ?? null,
        proprietario: farmAny?.proprietario ?? mainPermit?.holder_name ?? null,
        endereco: farmAny?.endereco ?? null,
        zip_code: farmAny?.zip_code ?? null,
        phone: farmAny?.phone ?? null,
        email: farmAny?.email ?? null,
        latitude: farmAny?.latitude ?? null,
        longitude: farmAny?.longitude ?? null,
        outorgaNumero: inemaData?.outorga_numero ?? mainPermit?.permit_number ?? null,
        orgao: inemaData?.orgao ?? "INEMA",
        vazaoOutorgadaM3h: inemaData?.vazao_outorgada_m3h ?? (mainHrs > 0 ? Math.round((mainVolDay / mainHrs) * 100) / 100 : null),
        permits: permitHeaders.map(({ _permitId, ...h }) => h),
      });

      // ── permitByEq: limite por equipamento, do vínculo do poço ───────────────
      // water_permit_wells.equipment_id → limite (volume/dia = flow_rate_m3_day;
      // horas/dia = regime da portaria). Fallback: casamento pelo nº do poço.
      const regimeByPermit = new Map<string, number>(permitsList.map((p) => [p.id as string, Number(p.regime_hours_per_day ?? 18) || 18]));
      const pMap = new Map<string, { max_flow_m3h: number | null; max_daily_volume_m3: number | null; max_daily_hours: number | null }>();
      const byNumber = new Map<number, { vol: number; hrs: number }>();
      for (const w of wells) {
        const daily = Number(w.flow_rate_m3_day || 0);
        const hrs = regimeByPermit.get(w.permit_id) ?? 18;
        if (w.equipment_id && !pMap.has(w.equipment_id)) {
          pMap.set(w.equipment_id, {
            max_flow_m3h: hrs > 0 ? Math.round((daily / hrs) * 100) / 100 : null,
            max_daily_volume_m3: daily || null,
            max_daily_hours: hrs,
          });
        }
        const n = parseInt(String(w.well_name ?? "").replace(/\D+/g, ""), 10);
        if (Number.isFinite(n) && !byNumber.has(n)) byNumber.set(n, { vol: daily, hrs });
      }
      for (const e of list) {
        if (pMap.has(e.id)) continue;
        const n = parseInt(String(e.name ?? "").replace(/\D+/g, ""), 10);
        if (Number.isFinite(n) && byNumber.has(n)) {
          const b = byNumber.get(n)!;
          pMap.set(e.id, {
            max_flow_m3h: b.hrs > 0 ? Math.round((b.vol / b.hrs) * 100) / 100 : null,
            max_daily_volume_m3: b.vol || null,
            max_daily_hours: b.hrs,
          });
        }
      }
      setPermitByEq(pMap);
    })();
    return () => { cancelled = true; };
  }, [farmId]);


  // Carrega sessões de runtime
  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase.from("pump_runtime")
        .select("equipment_id, started_at, ended_at")
        .eq("farm_id", farmId)
        .lte("started_at", range.to.toISOString())
        .or(`ended_at.is.null,ended_at.gte.${range.from.toISOString()}`);
      if (cancelled) return;
      if (error) {
        notify.fail("INEMA", `Falha ao carregar sessões: ${error.message}`);
        setRuntimes([]);
      } else {
        setRuntimes((data ?? []) as RuntimeRow[]);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [farmId, range.from.getTime(), range.to.getTime()]);

  // Calcula horas por (bucket × equipamento)
  const rows = useMemo<DailyPumpRow[]>(() => {
    if (equipments.length === 0) return [];
    const nameById = new Map(equipments.map((e) => [e.id, e.name]));
    const flowById = new Map(equipments.map((e) => [e.id, e.estimated_flow_m3h]));

    // key = `${bucket}::${equipmentId}`
    const acc = new Map<string, { bucket: string; label: string; equipmentId: string; hours: number }>();
    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();

    const validIds = new Set(equipments.map((e) => e.id));
    for (const r of runtimes) {
      if (!validIds.has(r.equipment_id)) continue; // ignora boosters/bombas — INEMA só poços

      const s0 = Math.max(new Date(r.started_at).getTime(), fromMs);
      const e0 = Math.min(r.ended_at ? new Date(r.ended_at).getTime() : Date.now(), toMs);
      if (!(e0 > s0)) continue;
      // Fatiar por dia
      let cursor = new Date(s0);
      cursor.setHours(0, 0, 0, 0);
      while (cursor.getTime() <= e0) {
        const next = new Date(cursor); next.setDate(next.getDate() + 1);
        const a = Math.max(s0, cursor.getTime());
        const b = Math.min(e0, next.getTime() - 1);
        if (b > a) {
          const bk = bucketize(cursor, group);
          const key = `${bk.key}::${r.equipment_id}`;
          const cur = acc.get(key) ?? { bucket: bk.key, label: bk.label, equipmentId: r.equipment_id, hours: 0 };
          cur.hours += (b - a) / 3_600_000;
          acc.set(key, cur);
        }
        cursor = next;
      }
    }

    // Gera linhas + inclui equipamentos sem dados (bucket=único "sem dados")
    const list: DailyPumpRow[] = Array.from(acc.values())
      .filter((v) => v.hours > 0)
      .map((v) => {
        const flow = flowById.get(v.equipmentId) ?? null;
        const name = nameById.get(v.equipmentId) ?? "";
        return {
          bucket: v.bucket,
          bucketLabel: v.label,
          equipmentId: v.equipmentId,
          equipmentName: name,
          hours: Math.round(v.hours * 100) / 100,
          flowRate: flow,
          volume: flow != null ? Math.round(flow * v.hours * 100) / 100 : null,
        };
      })
      .filter((r) => r.equipmentName && r.equipmentName.trim() !== "" && r.equipmentName !== "—");

    list.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.equipmentName.localeCompare(b.equipmentName));
    return list;
  }, [runtimes, equipments, group, range.from.getTime(), range.to.getTime()]);

  // Consumo acumulado por equipamento (ordem cronológica)
  const rowsWithAcc = useMemo(() => {
    const acc = new Map<string, number>();
    return rows.map((r) => {
      const prev = acc.get(r.equipmentId) ?? 0;
      const next = prev + (r.volume ?? 0);
      acc.set(r.equipmentId, next);
      return { ...r, accumulated: next };
    });
  }, [rows]);

  // Totais por poço — apenas equipamentos com horas > 0 no período
  const totalsByPump = useMemo(() => {
    const m = new Map<string, { name: string; hours: number; volume: number; flow: number | null }>();
    for (const r of rows) {
      if (!r.equipmentName || r.equipmentName.trim() === "" || r.equipmentName === "—") continue;
      if (r.hours <= 0) continue;
      const cur = m.get(r.equipmentId) ?? { name: r.equipmentName, hours: 0, volume: 0, flow: r.flowRate };
      cur.hours += r.hours;
      cur.volume += r.volume ?? 0;
      m.set(r.equipmentId, cur);
    }
    return Array.from(m.entries())
      .map(([id, v]) => ({ id, ...v }))
      .filter((p) => p.hours > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const totalFarm = useMemo(() => {
    return totalsByPump.reduce((s, p) => s + p.volume, 0);
  }, [totalsByPump]);

  // Dias no período (inclusivo) para calcular o limite outorgado do período
  const daysInPeriod = useMemo(() => {
    const ms = range.to.getTime() - range.from.getTime();
    return Math.max(1, Math.ceil(ms / 86_400_000));
  }, [range.from.getTime(), range.to.getTime()]);

  // Resumo de compliance por poço: volume vs. limite outorgado do período
  const complianceByPump = useMemo(() => {
    return totalsByPump.map((p) => {
      const permit = permitByEq.get(p.id);
      let periodLimit: number | null = null;
      if (permit) {
        if (permit.max_daily_volume_m3 != null) {
          periodLimit = permit.max_daily_volume_m3 * daysInPeriod;
        } else if (permit.max_daily_hours != null && p.flow != null) {
          periodLimit = permit.max_daily_hours * p.flow * daysInPeriod;
        }
      }
      const pct = periodLimit != null && periodLimit > 0 ? p.volume / periodLimit : null;
      return {
        pump: p.name,
        hours: p.hours,
        flow: p.flow,
        volume: p.volume,
        periodLimit: periodLimit != null ? Math.round(periodLimit * 100) / 100 : null,
        pct,
      };
    });
  }, [totalsByPump, permitByEq, daysInPeriod]);

  const buildReportData = (titular: InemaSignatureTitular | null, rt: InemaSignatureRT | null): InemaReportData => ({
    farm: farmHeader,
    period: { fromIso: fromDate, toIso: toDate },
    grouping: group,
    rows: rowsWithAcc.map((r) => ({
      bucketLabel: r.bucketLabel,
      pump: r.equipmentName,
      hours: r.hours,
      flowRate: r.flowRate,
      volume: r.volume,
      accumulated: r.accumulated,
    })),
    totalsByPump: totalsByPump.map((p) => ({ pump: p.name, hours: p.hours, volume: p.volume, flow: p.flow })),
    totalFarm,
    complianceByPump,
    titular,
    rt,
  });

  const reportData = useMemo<InemaReportData>(
    () => buildReportData(null, null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [farmHeader, fromDate, toDate, group, rowsWithAcc, totalsByPump, totalFarm, complianceByPump],
  );

  const handleXLSX = () => {
    try { exportInemaXLSX(reportData); notify.ok("INEMA", "Excel gerado."); }
    catch (e: any) { notify.fail("INEMA", e?.message ?? "Falha ao gerar Excel"); }
  };

  const [annualYear, setAnnualYear] = useState<number>(() => new Date(fromDate).getFullYear() || new Date().getFullYear());
  const [annualLoading, setAnnualLoading] = useState(false);
  const [annualDialogOpen, setAnnualDialogOpen] = useState(false);
  // Modo do diálogo de assinatura: "annual" (Relatório Anual) ou "normal" (PDF do período)
  const [sigMode, setSigMode] = useState<"annual" | "normal">("annual");

  // Signature form state — Declarante
  const [sigTitularName, setSigTitularName] = useState("");
  const [sigTitularDoc, setSigTitularDoc] = useState("");
  const [sigTitularCapacity, setSigTitularCapacity] = useState<"titular" | "procurador" | "representante">("titular");
  const [sigTitularAttorney, setSigTitularAttorney] = useState("");
  const [sigTitularDigital, setSigTitularDigital] = useState(false);
  // Signature form state — Responsável Técnico (opcional)
  const [includeRT, setIncludeRT] = useState(false);
  const [sigRTName, setSigRTName] = useState("");
  const [sigRTCrea, setSigRTCrea] = useState("");
  const [sigRTArt, setSigRTArt] = useState("");
  const [sigRTDigital, setSigRTDigital] = useState(false);


  // Pré-preenche titular sempre que abrir o diálogo ou farmHeader mudar
  useEffect(() => {
    if (!annualDialogOpen) return;
    setSigTitularName((v) => v || (farmHeader.proprietario ?? ""));
    setSigTitularDoc((v) => v || (farmHeader.cnpj ?? ""));
  }, [annualDialogOpen, farmHeader.proprietario, farmHeader.cnpj]);

  const openAnnualDialog = () => { setSigMode("annual"); setAnnualDialogOpen(true); };
  const handlePDF = () => { setSigMode("normal"); setAnnualDialogOpen(true); };

  const buildSignatures = (): { titular: InemaSignatureTitular | null; rt: InemaSignatureRT | null } => {
    const titular: InemaSignatureTitular | null = sigTitularName.trim()
      ? {
          name: sigTitularName.trim(),
          cpfCnpj: sigTitularDoc.trim(),
          capacity: sigTitularCapacity,
          attorneyNumber: sigTitularCapacity === "procurador" ? sigTitularAttorney.trim() : null,
          digital: sigTitularDigital,
          signedAt: sigTitularDigital ? new Date().toISOString() : undefined,
        }
      : null;
    const rt: InemaSignatureRT | null = includeRT && sigRTName.trim()
      ? {
          name: sigRTName.trim(),
          crea: sigRTCrea.trim(),
          art: sigRTArt.trim(),
          digital: sigRTDigital,
          signedAt: sigRTDigital ? new Date().toISOString() : undefined,
        }
      : null;
    return { titular, rt };
  };

  const handleNormalPDF = async () => {
    setAnnualLoading(true);
    try {
      const { titular, rt } = buildSignatures();
      await exportInemaPDF(buildReportData(titular, rt));
      notify.ok("INEMA", "PDF gerado.");
      setAnnualDialogOpen(false);
    } catch (e: any) {
      notify.fail("INEMA", e?.message ?? "Falha ao gerar PDF");
    } finally {
      setAnnualLoading(false);
    }
  };


  const handleAnnualPDF = async () => {
    if (!farmId) return;
    setAnnualLoading(true);
    try {
      const yearStart = new Date(annualYear, 0, 1);
      const yearEnd = new Date(annualYear, 11, 31, 23, 59, 59, 999);

      const { data: rt, error: rtErr } = await supabase.from("pump_runtime")
        .select("equipment_id, started_at, ended_at")
        .eq("farm_id", farmId)
        .lte("started_at", yearEnd.toISOString())
        .or(`ended_at.is.null,ended_at.gte.${yearStart.toISOString()}`);
      if (rtErr) throw rtErr;

      // Limites por equipamento reaproveitam o permitByEq (montado de water_permits
      // no useEffect acima) — não lê mais de inema_permits.

      const acc = new Map<string, number[]>();
      const fromMs = yearStart.getTime();
      const toMs = yearEnd.getTime();
      for (const r of (rt as RuntimeRow[] | null) ?? []) {
        const s0 = Math.max(new Date(r.started_at).getTime(), fromMs);
        const e0 = Math.min(r.ended_at ? new Date(r.ended_at).getTime() : Date.now(), toMs);
        if (!(e0 > s0)) continue;
        let cursor = new Date(s0); cursor.setHours(0, 0, 0, 0);
        while (cursor.getTime() <= e0) {
          const next = new Date(cursor); next.setDate(next.getDate() + 1);
          const a = Math.max(s0, cursor.getTime());
          const b = Math.min(e0, next.getTime() - 1);
          if (b > a) {
            const mIdx = cursor.getMonth();
            const arr = acc.get(r.equipment_id) ?? new Array(12).fill(0);
            arr[mIdx] += (b - a) / 3_600_000;
            acc.set(r.equipment_id, arr);
          }
          cursor = next;
        }
      }

      const pumps: InemaAnnualPump[] = equipments.map((e) => {
        const hoursArr = acc.get(e.id) ?? new Array(12).fill(0);
        const p = permitByEq.get(e.id);
        const flow = e.estimated_flow_m3h;
        const maxDailyVol = p?.max_daily_volume_m3 ?? null;
        const maxDailyH = p?.max_daily_hours ?? null;
        const monthly: InemaAnnualMonth[] = hoursArr.map((h, i) => {
          const volume = flow != null ? h * flow : 0;
          const dim = daysInMonth(annualYear, i);
          const limit = maxDailyVol != null
            ? maxDailyVol * dim
            : (maxDailyH != null && flow != null ? maxDailyH * flow * dim : 0);
          const pct = limit > 0 ? volume / limit : 0;
          return { hours: Math.round(h * 100) / 100, volume: Math.round(volume * 100) / 100, limit: Math.round(limit * 100) / 100, pct };
        });
        return {
          id: e.id,
          name: e.name,
          flowRate: flow,
          maxDailyVolumeM3: maxDailyVol,
          maxDailyHours: maxDailyH,
          monthly,
          totalHours: monthly.reduce((s, m) => s + m.hours, 0),
          totalVolume: monthly.reduce((s, m) => s + m.volume, 0),
          totalLimit: monthly.reduce((s, m) => s + m.limit, 0),
          latitude: e.latitude ?? null,
          longitude: e.longitude ?? null,
          capturePoint: e.name,
        };
      }).filter((p) => p.totalHours > 0 || p.totalLimit > 0);

      if (pumps.length === 0) {
        notify.fail("INEMA", "Sem dados no ano selecionado.");
        return;
      }

      const { titular, rt: rtSig } = buildSignatures();

      await exportInemaAnnualPDF({ farm: farmHeader, year: annualYear, pumps, titular, rt: rtSig });

      notify.ok("INEMA", `Relatório anual ${annualYear} gerado.`);
      setAnnualDialogOpen(false);
    } catch (e: any) {
      notify.fail("INEMA", e?.message ?? "Falha ao gerar relatório anual");
    } finally {
      setAnnualLoading(false);
    }
  };

  function daysInMonth(y: number, m: number) {
    return new Date(y, m + 1, 0).getDate();
  }


  if (loading && rowsWithAcc.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-3">Carregando dados INEMA…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-foreground flex items-center gap-2">
            <Droplets className="w-4 h-4 text-primary" />
            Relatório INEMA — Portaria 19452
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div>
              <div className="text-muted-foreground uppercase text-[10px]">Fazenda</div>
              <div className="text-foreground font-medium">{farmHeader.name}</div>
              {farmHeader.endereco && (
                <div className="text-muted-foreground">{farmHeader.endereco}</div>
              )}
              {(farmHeader.city || farmHeader.state) && (
                <div className="text-muted-foreground">{[farmHeader.city, farmHeader.state].filter(Boolean).join(" / ")}</div>
              )}
              {farmHeader.latitude != null && farmHeader.longitude != null && (
                <div className="text-muted-foreground">
                  Lat/Long: {Number(farmHeader.latitude).toFixed(6)}, {Number(farmHeader.longitude).toFixed(6)}
                </div>
              )}
            </div>
            <div>
              <div className="text-muted-foreground uppercase text-[10px]">Produtor / CPF / CNPJ</div>
              <div className="text-foreground">{farmHeader.proprietario ?? "—"}</div>
              <div className="text-muted-foreground">{farmHeader.cnpj ?? "—"}</div>
            </div>
            <div>
              <div className="text-muted-foreground uppercase text-[10px]">Outorga</div>
              <div className="text-foreground">{farmHeader.outorgaNumero ?? "—"}</div>
              <div className="text-muted-foreground">
                {farmHeader.vazaoOutorgadaM3h != null ? `Vazão outorgada: ${fmtNum(farmHeader.vazaoOutorgadaM3h)} m³/h` : ""}
              </div>
            </div>
          </div>


          <div className="flex flex-wrap items-end gap-3 pt-2 border-t border-border">
            <div>
              <label className="text-[10px] uppercase text-muted-foreground block">Agrupar por</label>
              <Select value={group} onValueChange={(v) => setGroup(v as Grouping)}>
                <SelectTrigger className="w-32 h-9 bg-secondary border-border"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="dia">Dia</SelectItem>
                  <SelectItem value="semana">Semana</SelectItem>
                  <SelectItem value="mes">Mês</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="text-xs text-muted-foreground">
              Período: <span className="text-foreground font-medium">{fmtDateBR(fromDate)} a {fmtDateBR(toDate)}</span>
            </div>
            <div className="ml-auto flex flex-wrap items-end gap-2">
              <div>
                <label className="text-[10px] uppercase text-muted-foreground block">Ano (anual)</label>
                <Select value={String(annualYear)} onValueChange={(v) => setAnnualYear(Number(v))}>
                  <SelectTrigger className="w-24 h-9 bg-secondary border-border"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 5 }).map((_, i) => {
                      const y = new Date().getFullYear() - i;
                      return <SelectItem key={y} value={String(y)}>{y}</SelectItem>;
                    })}
                  </SelectContent>
                </Select>
              </div>
              <Button variant="outline" size="sm" onClick={openAnnualDialog} disabled={annualLoading || equipments.length === 0}>
                {annualLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <CalendarRange className="w-4 h-4 mr-1" />}
                Relatório Anual
              </Button>
              <Button variant="outline" size="sm" onClick={handleXLSX} disabled={rowsWithAcc.length === 0}>
                <FileSpreadsheet className="w-4 h-4 mr-1" /> Baixar Excel
              </Button>
              <Button size="sm" onClick={handlePDF} disabled={rowsWithAcc.length === 0}>
                <Download className="w-4 h-4 mr-1" /> Baixar PDF
              </Button>
            </div>

          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">{group === "dia" ? "Data" : group === "semana" ? "Semana" : "Mês"}</TableHead>
                <TableHead>Poço</TableHead>
                <TableHead className="text-right">Horas de Funcionamento</TableHead>
                <TableHead className="text-right">Vazão Instantânea (m³/h)</TableHead>
                <TableHead className="text-right">Volume Captado (m³)</TableHead>
                <TableHead className="text-right">Consumo Acumulado (m³)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rowsWithAcc.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    Sem dados de bombeamento no período selecionado.
                  </TableCell>
                </TableRow>
              ) : rowsWithAcc.map((r, i) => (
                <TableRow key={`${r.bucket}-${r.equipmentId}-${i}`}>
                  <TableCell className="whitespace-nowrap">{r.bucketLabel}</TableCell>
                  <TableCell>{r.equipmentName}</TableCell>
                  <TableCell className="text-right">{fmtHours(r.hours)}</TableCell>
                  <TableCell className={`text-right ${r.flowRate == null ? "bg-yellow-500/20 text-yellow-700 dark:text-yellow-300 font-medium" : ""}`}>
                    {r.flowRate == null ? "N/D" : fmtNum(r.flowRate)}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.volume == null ? <Badge variant="outline" className="bg-yellow-500/20">N/D</Badge> : fmtNum(r.volume)}
                  </TableCell>
                  <TableCell className="text-right font-medium">{fmtNum(r.accumulated)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-foreground">Totalizadores do período</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Poço</TableHead>
                <TableHead className="text-right">Vazão Nominal (m³/h)</TableHead>
                <TableHead className="text-right">Horas Totais</TableHead>
                <TableHead className="text-right">Volume Total (m³)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {totalsByPump.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{p.name}</TableCell>
                  <TableCell className={`text-right ${p.flow == null ? "bg-yellow-500/20 text-yellow-700 dark:text-yellow-300" : ""}`}>
                    {p.flow == null ? "N/D" : fmtNum(p.flow)}
                  </TableCell>
                  <TableCell className="text-right">{fmtHours(p.hours)}</TableCell>
                  <TableCell className="text-right font-medium">{fmtNum(p.volume)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-secondary/60 font-semibold">
                <TableCell colSpan={3} className="text-right">Volume Total da Fazenda no período</TableCell>
                <TableCell className="text-right">{fmtNum(totalFarm)} m³</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p className="text-[11px] text-muted-foreground mt-3">
            Dados derivados do log operacional (pump_runtime → automation_log). Relatório em conformidade com a Portaria INEMA nº 19452.
          </p>
        </CardContent>
      </Card>

      <Dialog open={annualDialogOpen} onOpenChange={setAnnualDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {sigMode === "annual"
                ? `Assinaturas do Relatório Anual INEMA — ${annualYear}`
                : `Assinaturas do Relatório INEMA — ${fmtDateBR(fromDate)} a ${fmtDateBR(toDate)}`}
            </DialogTitle>
            <DialogDescription>
              Confirme os dados de assinatura. O bloco do Responsável Técnico é opcional.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-foreground">Declarante</h4>
              <p className="text-xs text-muted-foreground">Pessoa que assina este documento.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="tit-name">Nome completo</Label>
                  <Input id="tit-name" value={sigTitularName} onChange={(e) => setSigTitularName(e.target.value)} maxLength={120} />
                </div>
                <div>
                  <Label htmlFor="tit-doc">CPF</Label>
                  <Input id="tit-doc" value={sigTitularDoc} onChange={(e) => setSigTitularDoc(e.target.value)} maxLength={20} />
                </div>
              </div>
              <div>
                <Label htmlFor="tit-cap">Qualidade</Label>
                <Select value={sigTitularCapacity} onValueChange={(v) => setSigTitularCapacity(v as "titular" | "procurador" | "representante")}>
                  <SelectTrigger id="tit-cap"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="titular">Titular da Outorga</SelectItem>
                    <SelectItem value="procurador">Procurador Legal</SelectItem>
                    <SelectItem value="representante">Representante Legal</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {sigTitularCapacity === "procurador" && (
                <div>
                  <Label htmlFor="tit-att">Procuração nº</Label>
                  <Input id="tit-att" value={sigTitularAttorney} onChange={(e) => setSigTitularAttorney(e.target.value)} maxLength={60} placeholder="Ex.: 12345/2026" />
                </div>
              )}
              <div className="flex items-center gap-2">
                <Checkbox id="tit-digital" checked={sigTitularDigital} onCheckedChange={(v) => setSigTitularDigital(!!v)} />
                <Label htmlFor="tit-digital" className="text-xs font-normal cursor-pointer">
                  Assinatura digital (registra data/hora no PDF). Deixe desmarcado para assinatura manuscrita.
                </Label>
              </div>
            </div>

            <div className="border-t border-border pt-4 space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox id="inc-rt" checked={includeRT} onCheckedChange={(v) => setIncludeRT(!!v)} />
                <Label htmlFor="inc-rt" className="text-sm font-semibold cursor-pointer">
                  Incluir Responsável Técnico (opcional)
                </Label>
              </div>
              {includeRT && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="sm:col-span-2">
                      <Label htmlFor="rt-name">Nome do profissional</Label>
                      <Input id="rt-name" value={sigRTName} onChange={(e) => setSigRTName(e.target.value)} maxLength={120} />
                    </div>
                    <div>
                      <Label htmlFor="rt-crea">Nº CREA</Label>
                      <Input id="rt-crea" value={sigRTCrea} onChange={(e) => setSigRTCrea(e.target.value)} maxLength={40} />
                    </div>
                    <div>
                      <Label htmlFor="rt-art">Nº ART vinculada</Label>
                      <Input id="rt-art" value={sigRTArt} onChange={(e) => setSigRTArt(e.target.value)} maxLength={40} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox id="rt-digital" checked={sigRTDigital} onCheckedChange={(v) => setSigRTDigital(!!v)} />
                    <Label htmlFor="rt-digital" className="text-xs font-normal cursor-pointer">
                      Assinatura digital do RT (registra data/hora no PDF)
                    </Label>
                  </div>
                </>
              )}
            </div>


            <p className="text-[11px] text-muted-foreground border-t border-border pt-3">
              Se nenhum dado do titular for informado, o PDF terá apenas linhas em branco para assinatura manual.
              O rodapé institucional (Portarias 19.452/2019 e 21.953/2020) é sempre incluído.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAnnualDialogOpen(false)} disabled={annualLoading}>
              Cancelar
            </Button>
            <Button onClick={sigMode === "annual" ? handleAnnualPDF : handleNormalPDF} disabled={annualLoading}>
              {annualLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Download className="w-4 h-4 mr-1" />}
              Gerar PDF
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
