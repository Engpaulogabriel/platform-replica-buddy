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
import { FileText, Printer, AlertTriangle, Droplets, MapPin, RefreshCw } from "lucide-react";

interface Well { id: string; well_name: string; latitude: string | null; longitude: string | null; flow_rate_m3_day: number; datum: string | null }
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

export function InemaReport({ farmId }: { farmId: string | null }) {
  const [permits, setPermits] = useState<Permit[]>([]);
  const [pocos, setPocos] = useState<Poco[]>([]);
  const [hoursByEq, setHoursByEq] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<string>("month"); // month | 7 | 30

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

  if (!farmId) return <Card><CardContent className="py-8 text-center text-muted-foreground">Selecione uma fazenda.</CardContent></Card>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText className="w-4 h-4 text-primary" /> Relatório para protocolo no SEI BAHIA
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Atualizar
          </Button>
          <Button size="sm" onClick={() => window.print()}>
            <Printer className="w-4 h-4 mr-1.5" /> Imprimir / PDF
          </Button>
        </div>
      </div>

      {loading && permits.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">Carregando…</CardContent></Card>
      ) : permits.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">Nenhuma outorga cadastrada para esta fazenda.</CardContent></Card>
      ) : (
        <>
          {/* ══ A) OUTORGAS (formato SEI) ══ */}
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
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Poço</TableHead>
                            <TableHead>Latitude</TableHead>
                            <TableHead>Longitude</TableHead>
                            <TableHead className="text-right">Vazão (m³/dia)</TableHead>
                            <TableHead>Datum</TableHead>
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
                            </TableRow>
                          ))}
                          {p.wells.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-xs">Sem poços.</TableCell></TableRow>}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  {/* Condicionantes */}
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground mt-2 mb-1">Condicionantes</div>
                    <ol className="space-y-1">
                      {p.conditions.map((c) => (
                        <li key={c.id} className={`text-xs flex items-start gap-2 rounded px-2 py-1 ${c.is_critical ? "bg-destructive/5 border border-destructive/30" : "bg-muted/40"}`}>
                          <span className="font-bold shrink-0">{c.condition_number ?? "•"}.</span>
                          <span className="flex-1">
                            {c.is_critical && <span className="text-destructive font-bold">CRÍTICO — </span>}
                            {c.description}
                            {c.deadline_days ? <span className="text-muted-foreground"> (prazo {c.deadline_days} dias)</span> : null}
                          </span>
                          <Badge variant="outline" className={`${condTone(c.status)} shrink-0`}>{c.status}</Badge>
                        </li>
                      ))}
                      {p.conditions.length === 0 && <li className="text-xs text-muted-foreground">Sem condicionantes.</li>}
                    </ol>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {/* ══ B) MONITORAMENTO (telemetria) ══ */}
          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
                <span className="flex items-center gap-2"><Droplets className="w-4 h-4 text-primary" /> Relatório de monitoramento</span>
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
                <Table>
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

              {/* Compliance: captado vs autorizado */}
              <div className="rounded-md border border-border p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Vazão autorizada (soma das outorgas)</span>
                  <span className="font-medium">{fmtNum(authorizedPerDay)} m³/dia · {fmtNum(authorizedPeriod)} m³ no período</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Volume captado (estimado)</span>
                  <span className="font-medium">{fmtNum(totalCaptured)} m³</span>
                </div>
                <div className="h-2 rounded-full bg-secondary overflow-hidden">
                  <div className={`h-full rounded-full ${compliancePct >= 100 ? "bg-destructive" : compliancePct >= 80 ? "bg-warning" : "bg-primary"}`}
                       style={{ width: `${Math.min(100, compliancePct)}%` }} />
                </div>
                <div className="text-xs font-semibold flex items-center justify-between">
                  <span>Compliance do período</span>
                  <span className={compliancePct >= 100 ? "text-destructive" : compliancePct >= 80 ? "text-warning" : "text-primary"}>
                    {fmtNum(compliancePct, 1)}% do autorizado
                  </span>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                * Volume captado estimado por horas operadas × vazão nominal do poço (o sistema não historiza vazão real por dia).
                Nível estático/dinâmico não é medido pela telemetria atual — informar manualmente no protocolo quando exigido.
                Os nºs de poço das portarias não são vinculados 1:1 aos equipamentos físicos (numeração por portaria).
              </p>
            </CardContent>
          </Card>
        </>
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
