// Relatório INEMA unificado — sub-abas: Outorgas | Monitoramento | Compliance
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileText, ScrollText, ShieldCheck, Loader2, Droplets } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getSupabaseForFarm } from "@/lib/supabaseRouter";
import { InemaCompliancePanel } from "@/components/inema/InemaCompliancePanel";

const InemaReportTab = lazy(() => import("@/components/reports/InemaReportTab"));

interface Props {
  farmId: string | null;
  fromDate: string;
  toDate: string;
}

interface PermitWell {
  id: string;
  well_name: string;
  flow_rate_m3_day: number;
  latitude: string | null;
  longitude: string | null;
  datum: string | null;
}

interface PermitCondition {
  id: string;
  condition_number: number | null;
  description: string;
  is_critical: boolean | null;
  deadline_days: number | null;
}

interface Permit {
  id: string;
  permit_number: string;
  process_number: string;
  permit_date: string;
  validity_start: string;
  validity_end: string;
  holder_name: string;
  holder_cpf_cnpj: string | null;
  municipality: string | null;
  basin: string | null;
  purpose: string | null;
  irrigated_area_ha: number | null;
  regime_hours_per_day: number | null;
  status: string | null;
  wells: PermitWell[];
  conditions: PermitCondition[];
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(`${s}T12:00:00`);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-BR");
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function useWaterPermits(farmId: string | null) {
  const [permits, setPermits] = useState<Permit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!farmId) {
        setPermits([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      const { data: perms } = await getSupabaseForFarm(farmId)
        .from("water_permits" as any)
        .select(
          "id, permit_number, process_number, permit_date, validity_start, validity_end, holder_name, holder_cpf_cnpj, municipality, basin, purpose, irrigated_area_ha, regime_hours_per_day, status",
        )
        .eq("farm_id", farmId)
        .order("permit_date", { ascending: false });

      const list = ((perms as any[]) ?? []) as Permit[];
      const ids = list.map((p) => p.id);

      let wells: any[] = [];
      let conds: any[] = [];
      if (ids.length > 0) {
        const [w, c] = await Promise.all([
          getSupabaseForFarm(farmId)
            .from("water_permit_wells" as any)
            .select("id, permit_id, well_name, flow_rate_m3_day, latitude, longitude, datum")
            .in("permit_id", ids),
          supabase
            .from("water_permit_conditions" as any)
            .select("id, permit_id, condition_number, description, is_critical, deadline_days")
            .in("permit_id", ids)
            .order("condition_number", { ascending: true }),
        ]);
        wells = (w.data as any[]) ?? [];
        conds = (c.data as any[]) ?? [];
      }

      if (!alive) return;
      setPermits(
        list.map((p) => ({
          ...p,
          wells: wells.filter((w) => w.permit_id === p.id),
          conditions: conds.filter((c) => c.permit_id === p.id),
        })),
      );
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [farmId]);

  return { permits, loading };
}

function PermitStatusBadge({ validityEnd }: { validityEnd: string }) {
  const end = new Date(`${validityEnd}T12:00:00`);
  const days = Math.floor((end.getTime() - Date.now()) / 86400000);
  if (isNaN(end.getTime())) return null;
  if (days < 0) return <Badge variant="destructive">Vencida</Badge>;
  if (days < 90) return <Badge className="bg-amber-500 text-white hover:bg-amber-500">Vence em {days}d</Badge>;
  return <Badge variant="secondary">Vigente</Badge>;
}

function OutorgasPanel({ farmId }: { farmId: string | null }) {
  const { permits, loading } = useWaterPermits(farmId);

  const totals = useMemo(() => {
    const wells = permits.flatMap((p) => p.wells);
    return {
      permits: permits.length,
      wells: wells.length,
      volume: wells.reduce((a, w) => a + (Number(w.flow_rate_m3_day) || 0), 0),
      conditions: permits.reduce((a, p) => a + p.conditions.length, 0),
    };
  }, [permits]);

  if (loading) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Carregando outorgas…
        </CardContent>
      </Card>
    );
  }

  if (permits.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground text-sm">
          Nenhuma outorga cadastrada para esta fazenda.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Outorgas" value={String(totals.permits)} icon={ScrollText} />
        <SummaryCard label="Poços outorgados" value={String(totals.wells)} icon={Droplets} />
        <SummaryCard label="Volume diário outorgado" value={`${fmtNum(totals.volume, 2)} m³/dia`} icon={Droplets} />
        <SummaryCard label="Condicionantes" value={String(totals.conditions)} icon={ShieldCheck} />
      </div>

      <Accordion type="multiple" className="space-y-2">
        {permits.map((p) => (
          <AccordionItem key={p.id} value={p.id} className="border rounded-lg px-3">
            <AccordionTrigger className="hover:no-underline">
              <div className="flex flex-wrap items-center gap-2 text-left">
                <span className="font-semibold">Portaria {p.permit_number}</span>
                <PermitStatusBadge validityEnd={p.validity_end} />
                <span className="text-xs text-muted-foreground">
                  {p.wells.length} poço(s) · válida até {fmtDate(p.validity_end)}
                </span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pb-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Info label="Processo" value={p.process_number} />
                <Info label="Data da portaria" value={fmtDate(p.permit_date)} />
                <Info label="Vigência" value={`${fmtDate(p.validity_start)} — ${fmtDate(p.validity_end)}`} />
                <Info label="Titular" value={p.holder_name} />
                <Info label="CPF/CNPJ" value={p.holder_cpf_cnpj ?? "—"} />
                <Info label="Município" value={p.municipality ?? "—"} />
                <Info label="Bacia" value={p.basin ?? "—"} />
                <Info label="Finalidade" value={p.purpose ?? "—"} />
                <Info label="Área irrigada" value={p.irrigated_area_ha ? `${fmtNum(p.irrigated_area_ha, 2)} ha` : "—"} />
                <Info label="Regime" value={p.regime_hours_per_day ? `${p.regime_hours_per_day} h/dia` : "—"} />
              </div>

              <div>
                <h4 className="text-sm font-semibold mb-2">Poços outorgados</h4>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Poço</TableHead>
                        <TableHead className="text-right">Volume (m³/dia)</TableHead>
                        <TableHead>Latitude</TableHead>
                        <TableHead>Longitude</TableHead>
                        <TableHead>Datum</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {p.wells.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-muted-foreground text-sm">
                            Sem poços cadastrados
                          </TableCell>
                        </TableRow>
                      ) : (
                        p.wells.map((w) => (
                          <TableRow key={w.id}>
                            <TableCell className="font-medium">{w.well_name}</TableCell>
                            <TableCell className="text-right">{fmtNum(Number(w.flow_rate_m3_day), 2)}</TableCell>
                            <TableCell className="text-xs">{w.latitude ?? "—"}</TableCell>
                            <TableCell className="text-xs">{w.longitude ?? "—"}</TableCell>
                            <TableCell className="text-xs">{w.datum ?? "—"}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {p.conditions.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Condicionantes ({p.conditions.length})</h4>
                  <ul className="space-y-1.5">
                    {p.conditions.map((c) => (
                      <li key={c.id} className="flex gap-2 text-sm">
                        <span className="text-muted-foreground shrink-0">{c.condition_number ?? "•"}.</span>
                        <span className="flex-1">{c.description}</span>
                        {c.is_critical && <Badge variant="destructive" className="h-5 shrink-0">Crítica</Badge>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}

function SummaryCard({ label, value, icon: Icon }: { label: string; value: string; icon: any }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className="w-3.5 h-3.5" /> {label}
        </div>
        <div className="text-lg font-bold mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-medium break-words">{value}</div>
    </div>
  );
}

export function InemaReport({ farmId, fromDate, toDate }: Props) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ScrollText className="w-4 h-4" /> Relatório INEMA
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Outorgas de captação, monitoramento de volumes e conformidade das condicionantes.
          </p>
        </CardHeader>
      </Card>

      <Tabs defaultValue="outorgas" className="w-full">
        <TabsList>
          <TabsTrigger value="outorgas"><ScrollText className="w-4 h-4 mr-1.5" />Outorgas</TabsTrigger>
          <TabsTrigger value="monitoramento"><FileText className="w-4 h-4 mr-1.5" />Monitoramento</TabsTrigger>
          <TabsTrigger value="compliance"><ShieldCheck className="w-4 h-4 mr-1.5" />Compliance</TabsTrigger>
        </TabsList>

        <TabsContent value="outorgas" className="mt-4">
          <OutorgasPanel farmId={farmId} />
        </TabsContent>

        <TabsContent value="monitoramento" className="mt-4">
          <Suspense
            fallback={
              <Card>
                <CardContent className="py-10 text-center text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Carregando…
                </CardContent>
              </Card>
            }
          >
            <InemaReportTab farmId={farmId} fromDate={fromDate} toDate={toDate} />
          </Suspense>
        </TabsContent>

        <TabsContent value="compliance" className="mt-4">
          <InemaCompliancePanel farmId={farmId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default InemaReport;
