// Relatório INEMA — formato para protocolo no SEI BAHIA.
// ─────────────────────────────────────────────────────────────────────────────
// A) OUTORGAS: portaria, processo, titular+CPF, validade, município/bacia,
//    finalidade/área, regime, TABELA DE POÇOS (coords DMS + vazão + datum),
//    CONDICIONANTES numeradas com status, status da outorga + alerta de venc.
// B) MONITORAMENTO: horas de operação (horímetro), vazão/volume captado
//    (telemetria) vs vazão autorizada (compliance) no período escolhido.
// Fonte: water_permits/_wells/_conditions (outorgas) + equipments + horímetro.
import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileText, Printer, AlertTriangle, Droplets, MapPin, RefreshCw, Download } from "lucide-react";
import { useEnvironmentalAgency } from "@/hooks/useEnvironmentalAgency";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { notify } from "@/lib/notify";

interface Well { id: string; well_name: string; latitude: string | null; longitude: string | null; flow_rate_m3_day: number; datum: string | null; equipment_id: string | null }
interface Condition { id: string; condition_number: number | null; description: string; deadline_days: number | null; is_critical: boolean; status: string }
interface Permit {
  id: string; permit_number: string; permit_date: string; process_number: string;
  holder_name: string; holder_cpf_cnpj: string | null; validity_start: string; validity_end: string;
  municipality: string | null; basin: string | null; purpose: string | null;
  irrigated_area_ha: number | null; regime_hours_per_day: number | null; status: string; notes: string | null;
  wells: Well[]; conditions: Condition[];
}
interface Poco { id: string; name: string; estimated_flow_m3h: number | null; flow_total_m3: number | null; flow_daily_start_m3: number | null }

const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString("pt-BR");
};
const fmtNum = (n: number | null | undefined, dec = 0) =>
  n == null ? "—" : n.toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });

const daysToExpiry = (end: string) => Math.ceil((new Date(end + "T00:00:00").getTime() - Date.now()) / 86_400_000);

function permitStatus(end: string): { label: string; tone: string } {
  const d = daysToExpiry(end);
  if (d < 0) return { label: "Vencida", tone: "bg-destructive/20 text-destructive border-destructive/50" };
  if (d <= 180) return { label: "Vencendo", tone: "bg-warning/20 text-warning border-warning/50" };
  return { label: "Vigente", tone: "bg-primary/15 text-primary border-primary/40" };
}
const condTone = (s: string) =>
  s === "cumprida" ? "bg-primary/15 text-primary border-primary/40"
    : s === "vencida" ? "bg-destructive/20 text-destructive border-destructive/50"
      : "bg-warning/15 text-warning border-warning/40";

// Portaria principal = outorga vigente mais recente (fallback: a de validade mais longa).
function pickMainPortaria(list: Permit[]): Permit | null {
  if (!list.length) return null;
  const vigentes = list.filter((p) => daysToExpiry(p.validity_end) >= 0);
  const pool = vigentes.length ? vigentes : list;
  return pool.slice().sort((a, b) => new Date(b.permit_date).getTime() - new Date(a.permit_date).getTime())[0];
}

export function InemaReport({ farmId }: { farmId: string | null }) {
  const [permits, setPermits] = useState<Permit[]>([]);
  const [pocos, setPocos] = useState<Poco[]>([]);
  const [hoursByEq, setHoursByEq] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<string>("month"); // month | 7 | 30
  const { agency } = useEnvironmentalAgency(farmId); // órgão ambiental por estado

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date();
    if (period === "month") { from.setDate(1); from.setHours(0, 0, 0, 0); }
    else { from.setDate(from.getDate() - Number(period)); }
    const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
    return { from, to, days };
  }, [period]);

  const load = useCallback(async () => {
    if (!farmId) { setPermits([]); setPocos([]); setHoursByEq({}); setLoading(false); return; }
    setLoading(true);
    const [{ data: permitRows }, { data: eqRows }, { data: horas }] = await Promise.all([
      supabase.from("water_permits" as any).select("*").eq("farm_id", farmId).order("validity_end", { ascending: true }),
      supabase.from("equipments").select("id,name,estimated_flow_m3h,flow_total_m3,flow_daily_start_m3").eq("farm_id", farmId).eq("type", "poco").order("name"),
      supabase.rpc("get_horimetro_daily", { _farm_id: farmId, _from: range.from.toISOString(), _to: range.to.toISOString() }),
    ]);
    const pList = (permitRows ?? []) as any[];
    const ids = pList.map((p) => p.id);
    let wells: any[] = [], conds: any[] = [];
    if (ids.length) {
      const [{ data: w }, { data: c }] = await Promise.all([
        supabase.from("water_permit_wells" as any).select("*").in("permit_id", ids),
        supabase.from("water_permit_conditions" as any).select("*").in("permit_id", ids).order("condition_number", { ascending: true }),
      ]);
      wells = (w ?? []) as any[]; conds = (c ?? []) as any[];
    }
    setPermits(pList.map((p) => ({
      ...p,
      wells: wells.filter((w) => w.permit_id === p.id),
      conditions: conds.filter((c) => c.permit_id === p.id),
    })) as Permit[]);
    setPocos((eqRows ?? []) as Poco[]);
    const hm: Record<string, number> = {};
    for (const r of (horas ?? []) as Array<{ equipment_id: string; hours: number }>) {
      hm[r.equipment_id] = (hm[r.equipment_id] ?? 0) + Number(r.hours || 0);
    }
    setHoursByEq(hm);
    setLoading(false);
  }, [farmId, range.from, range.to]);

  useEffect(() => { void load(); }, [load]);

  // ── Compliance: captado (estimado por horas × vazão nominal) vs autorizado ──
  const authorizedPerDay = useMemo(
    () => permits.reduce((s, p) => s + p.wells.reduce((a, w) => a + Number(w.flow_rate_m3_day || 0), 0), 0),
    [permits],
  );
  const monitoring = useMemo(() => pocos.map((e) => {
    const hours = hoursByEq[e.id] ?? 0;
    const volume = hours * Number(e.estimated_flow_m3h ?? 0); // estimado (sem histórico de vazão real)
    return { id: e.id, name: e.name, hours, volume, flow: e.estimated_flow_m3h ?? null };
  }), [pocos, hoursByEq]);
  const totalCaptured = monitoring.reduce((s, m) => s + m.volume, 0);
  const authorizedPeriod = authorizedPerDay * range.days;
  const compliancePct = authorizedPeriod > 0 ? (totalCaptured / authorizedPeriod) * 100 : 0;

  // Vazão autorizada por Nº de poço (das water_permits). Match best-effort pelo
  // número no nome do poço/equipamento; se o mesmo nº está em várias outorgas,
  // usa a MAIOR vazão autorizada.
  const authByPocoNumber = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of permits) for (const w of p.wells) {
      const n = parseInt(String(w.well_name).replace(/\D+/g, ""), 10);
      if (!Number.isFinite(n)) continue;
      m.set(n, Math.max(m.get(n) ?? 0, Number(w.flow_rate_m3_day || 0)));
    }
    return m;
  }, [permits]);
  // Vínculo EXPLÍCITO poço→equipamento (water_permit_wells.equipment_id) — precede
  // o casamento por número.
  const authByEquip = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of permits) for (const w of p.wells) {
      if (!w.equipment_id) continue;
      m.set(w.equipment_id, Math.max(m.get(w.equipment_id) ?? 0, Number(w.flow_rate_m3_day || 0)));
    }
    return m;
  }, [permits]);
  const perPoco = useMemo(() => monitoring.map((mo) => {
    const n = parseInt(String(mo.name).replace(/\D+/g, ""), 10);
    const authDaily = authByEquip.get(mo.id) ?? (Number.isFinite(n) ? (authByPocoNumber.get(n) ?? null) : null);
    const authPeriod = authDaily != null ? authDaily * range.days : null;
    const pct = authPeriod && authPeriod > 0 ? (mo.volume / authPeriod) * 100 : null;
    return { ...mo, authDaily, authPeriod, pct };
  }), [monitoring, authByEquip, authByPocoNumber, range.days]);

  // Baixar PDF: chama a EDGE FUNCTION (server-side) — não depende de qual versão
  // do frontend está publicada no Lovable. Se a função falhar (rede/deploy
  // pendente), cai no gerador local como fallback.
  const exportPDF = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token || !farmId) throw new Error("sem sessão");
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-inema-pdf`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
          },
          body: JSON.stringify({
            farm_id: farmId,
            date_start: range.from.toISOString(),
            date_end: range.to.toISOString(),
          }),
        },
      );
      if (!res.ok) throw new Error(`edge ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `renov-${agency.agency_acronym.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      notify.ok("Relatório", "PDF exportado.");
    } catch (_) {
      // Fallback: geração local (pode estar desatualizada se o Lovable não publicou).
      await exportPDFLocal();
    }
  };

  // PDF oficial — DADOS DA OUTORGA vindos de water_permits (não da inema_permits/config).
  const exportPDFLocal = async () => {
    try {
      // Rebusca FRESCA no clique — o PDF nunca depende do estado do componente
      // (evita "—" por timing / estado não carregado). Fallback: usa o state.
      let src: Permit[] = permits;
      if (farmId) {
        try {
          const { data: pr } = await supabase.from("water_permits" as any)
            .select("*").eq("farm_id", farmId).order("validity_end", { ascending: true });
          const pl = (pr ?? []) as any[];
          if (pl.length) {
            const ids = pl.map((p) => p.id);
            const { data: w } = await supabase.from("water_permit_wells" as any).select("*").in("permit_id", ids);
            const wl = (w ?? []) as any[];
            src = pl.map((p) => ({ ...p, wells: wl.filter((x) => x.permit_id === p.id), conditions: [] })) as Permit[];
          }
        } catch (_) { /* mantém o state */ }
      }
      const permitsForPdf = src;
      const mainForPdf = pickMainPortaria(permitsForPdf);

      const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      const w = doc.internal.pageSize.getWidth();
      doc.setFillColor(66, 147, 80); doc.rect(0, 0, w, 50, "F");
      doc.setTextColor(255, 255, 255); doc.setFontSize(16); doc.setFont("helvetica", "bold");
      doc.text("Renov Tecnologia Agrícola", 30, 22);
      doc.setFontSize(11); doc.setFont("helvetica", "normal");
      doc.text(`Relatório ${agency.agency_acronym} — Captação de Água`, 30, 38);
      doc.setFontSize(9);
      doc.text(`${agency.agency_name} (${agency.state_code})`, w - 30, 38, { align: "right" });
      doc.setTextColor(0, 0, 0);

      const wellsSum = (p: Permit) => p.wells.reduce((a, wl) => a + Number(wl.flow_rate_m3_day || 0), 0);
      const mp = mainForPdf;
      let y = 70;
      doc.setFontSize(11); doc.setFont("helvetica", "bold"); doc.text("Dados da outorga (principal)", 30, y); y += 15;
      doc.setFontSize(10); doc.setFont("helvetica", "normal");
      if (mp) {
        const volDay = wellsSum(mp);
        const hours = Number(mp.regime_hours_per_day ?? 18) || 18;
        const flowM3h = hours > 0 ? volDay / hours : 0;
        const rows: Array<[string, string]> = [
          ["Nº da Portaria", mp.permit_number],
          ["Nº do Processo", mp.process_number],
          ["Titular", `${mp.holder_name}${mp.holder_cpf_cnpj ? ` — CPF ${mp.holder_cpf_cnpj}` : ""}`],
          ["Finalidade de uso", mp.purpose ?? "—"],
          ["Bacia / Aquífero", mp.basin ?? "—"],
          ["Município", mp.municipality ?? "—"],
          ["Validade", `${fmtDate(mp.validity_start)} a ${fmtDate(mp.validity_end)}`],
          ["Vazão máx. outorgada", `${fmtNum(flowM3h, 1)} m³/h`],
          ["Volume máx. diário", `${fmtNum(volDay)} m³/dia`],
          ["Horas máx./dia", `${fmtNum(hours)} h`],
        ];
        for (const [k, v] of rows) { doc.text(`${k}: ${v}`, 30, y); y += 13; }
      } else {
        doc.text("Nenhuma outorga cadastrada.", 30, y); y += 13;
      }
      y += 6;

      doc.setFont("helvetica", "bold"); doc.text("Outorgas da fazenda", 30, y);
      autoTable(doc, {
        startY: y + 6,
        head: [["Portaria", "Processo", "Validade", "Área (ha)", "Poços", "Vazão total (m³/dia)"]],
        body: permitsForPdf.map((p) => [
          p.permit_number, p.process_number,
          `${fmtDate(p.validity_start)}–${fmtDate(p.validity_end)}`,
          fmtNum(p.irrigated_area_ha, 2), String(p.wells.length), fmtNum(wellsSum(p)),
        ]),
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [66, 147, 80], textColor: 255 },
      });
      y = (doc as any).lastAutoTable.finalY + 18;

      // Poços outorgados — coordenadas EXATAMENTE como na portaria (DMS da
      // outorga, NÃO do equipamento). É o que o órgão ambiental autorizou.
      const wellRows = permitsForPdf.flatMap((p) =>
        p.wells.map((wl) => [
          p.permit_number,
          wl.well_name,
          wl.latitude ?? "—",
          wl.longitude ?? "—",
          fmtNum(wl.flow_rate_m3_day),
          wl.datum ?? "—",
        ]),
      );
      if (wellRows.length) {
        doc.setFont("helvetica", "bold");
        doc.text("Poços outorgados (coordenadas da portaria)", 30, y);
        autoTable(doc, {
          startY: y + 6,
          head: [["Portaria", "Poço", "Latitude", "Longitude", "Vazão (m³/dia)", "Datum"]],
          body: wellRows,
          styles: { fontSize: 8, cellPadding: 3 },
          headStyles: { fillColor: [66, 147, 80], textColor: 255 },
        });
        y = (doc as any).lastAutoTable.finalY + 18;
      }

      doc.setFont("helvetica", "bold");
      doc.text(`Monitoramento (${fmtDate(range.from.toISOString())} a ${fmtDate(range.to.toISOString())})`, 30, y);
      autoTable(doc, {
        startY: y + 6,
        head: [["Poço", "Horas operadas", "Vazão nominal (m³/h)", "Volume captado (m³)"]],
        body: monitoring.map((m) => [m.name, fmtNum(m.hours, 1), fmtNum(m.flow, 1), fmtNum(m.volume)]),
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [66, 147, 80], textColor: 255 },
      });

      const h = doc.internal.pageSize.getHeight();
      doc.setFontSize(8); doc.setTextColor(120);
      doc.text("Volume captado estimado por horas × vazão nominal (medição indireta). Nível estático/dinâmico não medido pela telemetria.", 30, h - 30);
      doc.text(`Gerado em ${new Date().toLocaleString("pt-BR")} — Gestor de Bombas Renov.`, 30, h - 18);
      doc.save(`renov-${agency.agency_acronym.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.pdf`);
      notify.ok("Relatório", "PDF exportado.");
    } catch (_) {
      notify.fail("Relatório", "Falha ao gerar PDF.");
    }
  };

  // Nome do equipamento vinculado (só leitura aqui; o vínculo é editado no Setor Técnico).
  const equipNameById = useMemo(() => new Map(pocos.map((e) => [e.id, e.name])), [pocos]);

  const mainPortaria = useMemo(() => pickMainPortaria(permits), [permits]);

  if (!farmId) return <Card><CardContent className="py-8 text-center text-muted-foreground">Selecione uma fazenda.</CardContent></Card>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText className="w-4 h-4 text-primary" /> Relatório {agency.agency_acronym} — {agency.agency_name} ({agency.state_code})
          {mainPortaria && (
            <span className="ml-1 text-foreground font-medium">· Outorga {mainPortaria.permit_number}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Atualizar
          </Button>
          <Button variant="outline" size="sm" onClick={exportPDF} disabled={loading || !farmId}>
            <Download className="w-4 h-4 mr-1.5" /> Baixar PDF
          </Button>
          <Button size="sm" onClick={() => window.print()}>
            <Printer className="w-4 h-4 mr-1.5" /> Imprimir
          </Button>
        </div>
      </div>

      {loading && permits.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">Carregando…</CardContent></Card>
      ) : permits.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">Nenhuma outorga cadastrada para esta fazenda.</CardContent></Card>
      ) : (
        <Tabs defaultValue="outorgas" className="w-full">
          <TabsList>
            <TabsTrigger value="outorgas">Outorgas</TabsTrigger>
            <TabsTrigger value="monitoramento">Monitoramento</TabsTrigger>
            <TabsTrigger value="compliance">Compliance</TabsTrigger>
          </TabsList>

          {/* ══ OUTORGAS (formato SEI) ══ */}
          <TabsContent value="outorgas" className="space-y-4 mt-4">
          {permits.map((p) => {
            const stt = permitStatus(p.validity_end);
            const d = daysToExpiry(p.validity_end);
            return (
              <Card key={p.id} className="border-border">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
                    <span>Portaria nº {p.permit_number}</span>
                    <Badge variant="outline" className={stt.tone}>{stt.label}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {d >= 0 && d <= 180 && (
                    <Alert variant="destructive" className="bg-warning/10 border-warning/40">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>⚠️ Outorga vence em {d} dia(s) — {fmtDate(p.validity_end)}</AlertTitle>
                      <AlertDescription>Providenciar renovação e o relatório de monitoramento no SEI.</AlertDescription>
                    </Alert>
                  )}
                  {d < 0 && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>🔴 Outorga VENCIDA em {fmtDate(p.validity_end)} ({Math.abs(d)} dia(s))</AlertTitle>
                      <AlertDescription>Captação sem outorga vigente é irregular. Regularizar com urgência.</AlertDescription>
                    </Alert>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                    <Field label="Publicação (DOE)" value={fmtDate(p.permit_date)} />
                    <Field label="Processo" value={p.process_number} />
                    <Field label="Titular" value={`${p.holder_name}${p.holder_cpf_cnpj ? ` — CPF ${p.holder_cpf_cnpj}` : ""}`} />
                    <Field label="Validade" value={`${fmtDate(p.validity_start)} a ${fmtDate(p.validity_end)}`} />
                    <Field label="Município" value={p.municipality ?? "—"} />
                    <Field label="Bacia hidrográfica" value={p.basin ?? "—"} />
                    <Field label="Finalidade" value={p.purpose ?? "—"} />
                    <Field label="Área irrigada" value={`${fmtNum(p.irrigated_area_ha, 2)} ha`} />
                    <Field label="Regime de captação" value={`${fmtNum(p.regime_hours_per_day)} h/dia`} />
                  </div>

                  {/* Poços */}
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground mt-2 mb-1 flex items-center gap-1"><MapPin className="w-3 h-3" /> Poços outorgados</div>
                    <div className="overflow-x-auto">
                      <Table className="md:[&_th]:px-2 md:[&_td]:px-2 md:[&_td]:py-1.5 xl:[&_th]:px-4 xl:[&_td]:p-4">
                        <TableHeader>
                          <TableRow>
                            <TableHead>Poço</TableHead>
                            <TableHead>Latitude</TableHead>
                            <TableHead>Longitude</TableHead>
                            <TableHead className="text-right">Vazão (m³/dia)</TableHead>
                            <TableHead>Datum</TableHead>
                            <TableHead>Equipamento (sistema)</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {p.wells.map((w) => (
                            <TableRow key={w.id}>
                              <TableCell className="font-medium">{w.well_name}</TableCell>
                              <TableCell className="font-mono text-xs">{w.latitude ?? "—"}</TableCell>
                              <TableCell className="font-mono text-xs">{w.longitude ?? "—"}</TableCell>
                              <TableCell className="text-right">{fmtNum(w.flow_rate_m3_day)}</TableCell>
                              <TableCell className="text-xs">{w.datum ?? "—"}</TableCell>
                              <TableCell className="text-xs">
                                {w.equipment_id
                                  ? (equipNameById.get(w.equipment_id) ?? "—")
                                  : <span className="text-muted-foreground">— não vinculado —</span>}
                              </TableCell>
                            </TableRow>
                          ))}
                          {p.wells.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground text-xs">Sem poços.</TableCell></TableRow>}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  {/* Condicionantes */}
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground mt-2 mb-1">Condicionantes</div>
                    <ol className="space-y-1">
                      {p.conditions.map((c) => {
                        // "Crítica" só faz sentido enquanto PENDENTE — cumprida não é mais risco.
                        const showCritical = c.is_critical && c.status !== "cumprida";
                        return (
                        <li key={c.id} className={`text-xs flex items-start gap-2 rounded px-2 py-1 ${showCritical ? "bg-destructive/5 border border-destructive/30" : "bg-muted/40"}`}>
                          <span className="font-bold shrink-0">{c.condition_number ?? "•"}.</span>
                          <span className="flex-1">
                            {showCritical && <span className="text-destructive font-bold">CRÍTICO — </span>}
                            {c.description}
                            {c.deadline_days && c.status !== "cumprida" ? <span className="text-muted-foreground"> (prazo {c.deadline_days} dias)</span> : null}
                          </span>
                          <Badge variant="outline" className={`${condTone(c.status)} shrink-0`}>{c.status}</Badge>
                        </li>
                        );
                      })}
                      {p.conditions.length === 0 && <li className="text-xs text-muted-foreground">Sem condicionantes.</li>}
                    </ol>
                  </div>
                </CardContent>
              </Card>
            );
          })}
          </TabsContent>

          {/* ══ MONITORAMENTO (telemetria) ══ */}
          <TabsContent value="monitoramento" className="space-y-4 mt-4">
          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
                <span className="flex items-center gap-2 flex-wrap">
                  <Droplets className="w-4 h-4 text-primary" /> Relatório de Monitoramento — {agency.agency_name} ({agency.agency_acronym})
                  <span className="text-xs font-normal text-muted-foreground">· Outorga: {mainPortaria?.permit_number ?? "—"}</span>
                </span>
                <div className="print:hidden">
                  <Select value={period} onValueChange={setPeriod}>
                    <SelectTrigger className="h-8 w-[170px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="month">Mês corrente</SelectItem>
                      <SelectItem value="7">Últimos 7 dias</SelectItem>
                      <SelectItem value="30">Últimos 30 dias</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="text-xs text-muted-foreground">
                Período: {fmtDate(range.from.toISOString())} a {fmtDate(range.to.toISOString())} ({range.days} dia(s))
              </div>
              <div className="overflow-x-auto">
                <Table className="md:[&_th]:px-2 md:[&_td]:px-2 md:[&_td]:py-1.5 xl:[&_th]:px-4 xl:[&_td]:p-4">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Poço</TableHead>
                      <TableHead className="text-right">Horas operadas</TableHead>
                      <TableHead className="text-right">Vazão nominal (m³/h)</TableHead>
                      <TableHead className="text-right">Volume captado (m³)*</TableHead>
                      <TableHead className="text-right">Nível estático</TableHead>
                      <TableHead className="text-right">Nível dinâmico</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {monitoring.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-medium">{m.name}</TableCell>
                        <TableCell className="text-right">{fmtNum(m.hours, 1)}</TableCell>
                        <TableCell className="text-right">{fmtNum(m.flow, 1)}</TableCell>
                        <TableCell className="text-right">{fmtNum(m.volume)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">—</TableCell>
                        <TableCell className="text-right text-muted-foreground">—</TableCell>
                      </TableRow>
                    ))}
                    {monitoring.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground text-xs">Sem poços com telemetria.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
          </TabsContent>

          {/* ══ COMPLIANCE — comparativo simples autorizado vs captado (water_permits) ══ */}
          <TabsContent value="compliance" className="space-y-4 mt-4">
          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2"><Droplets className="w-4 h-4 text-primary" /> Compliance — Captação vs Autorizado</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="text-xs text-muted-foreground">
                Período: {fmtDate(range.from.toISOString())} a {fmtDate(range.to.toISOString())} ({range.days} dia(s))
              </div>
              <div className="overflow-x-auto">
                <Table className="md:[&_th]:px-2 md:[&_td]:px-2 md:[&_td]:py-1.5 xl:[&_th]:px-4 xl:[&_td]:p-4">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Poço</TableHead>
                      <TableHead className="text-right">Autorizado (m³/dia)</TableHead>
                      <TableHead className="text-right">Autorizado no período (m³)</TableHead>
                      <TableHead className="text-right">Captado (m³)</TableHead>
                      <TableHead className="text-right">% do autorizado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {perPoco.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-medium">{m.name}</TableCell>
                        <TableCell className="text-right">{m.authDaily != null ? fmtNum(m.authDaily) : <span className="text-muted-foreground text-xs">Sem vínculo</span>}</TableCell>
                        <TableCell className="text-right">{m.authPeriod != null ? fmtNum(m.authPeriod) : "—"}</TableCell>
                        <TableCell className="text-right">{fmtNum(m.volume)}</TableCell>
                        <TableCell className={`text-right font-medium ${m.pct == null ? "text-muted-foreground" : m.pct >= 100 ? "text-destructive" : m.pct >= 80 ? "text-warning" : "text-primary"}`}>
                          {m.pct != null ? `${fmtNum(m.pct, 1)}%` : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                    {perPoco.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-xs">Sem poços com telemetria.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>

              {/* Total da fazenda */}
              <div className="rounded-md border border-border p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Autorizado total (soma das outorgas)</span>
                  <span className="font-medium">{fmtNum(authorizedPerDay)} m³/dia · {fmtNum(authorizedPeriod)} m³ no período</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Captado total (estimado)</span>
                  <span className="font-medium">{fmtNum(totalCaptured)} m³ · {fmtNum(compliancePct, 1)}% do autorizado</span>
                </div>
                <div className="h-2 rounded-full bg-secondary overflow-hidden">
                  <div className={`h-full rounded-full ${compliancePct >= 100 ? "bg-destructive" : compliancePct >= 80 ? "bg-warning" : "bg-primary"}`}
                       style={{ width: `${Math.min(100, compliancePct)}%` }} />
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Captado estimado por horas operadas × vazão nominal (o sistema não historiza vazão real por dia).
                Vazão autorizada pelo vínculo poço↔equipamento (aba Outorgas) ou, na falta, pelo número do poço.
              </p>
            </CardContent>
          </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

export default InemaReport;
