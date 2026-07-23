// /produtividade — ROI financeiro + Conformidade INEMA + Configurações
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { notify } from "@/lib/notify";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend } from "recharts";
import {
  TrendingUp, DollarSign, Droplets, Zap, AlertTriangle, FileText, Save, Download, Info, Settings, Truck, Lock,
} from "lucide-react";
import { useProductivityData, useInemaConfig, DEFAULT_PROD_CFG, type ProductivityConfig } from "@/hooks/useProductivityData";
import { useFarmAccess } from "@/hooks/useFarmAccess";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { supabase } from "@/integrations/supabase/client";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

const fmtBRL = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtNum = (v: number, d = 1) => v.toLocaleString("pt-BR", { maximumFractionDigits: d, minimumFractionDigits: d });

export default function Produtividade() {
  const { isPlatformAdmin, canViewFinancial, loading: accessLoading } = useFarmAccess();
  const farmId = useDefaultFarmId();
  const [periodDays, setPeriodDays] = useState("30");

  if (accessLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Carregando…</div>;
  }
  // Administrador (owner) e platform_admin acessam — Supervisor e Operador NÃO.
  if (!canViewFinancial) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <Lock className="h-4 w-4" />
          <AlertTitle>Acesso restrito</AlertTitle>
          <AlertDescription>
            Esta área contém dados financeiros (ROI e tarifas) e está disponível apenas
            para o Administrador da fazenda.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const { from, to } = useMemo(() => {
    const t = new Date();
    const f = new Date(t.getTime() - Number(periodDays) * 86400_000);
    return { from: f, to: t };
  }, [periodDays]);

  const data = useProductivityData({ from, to });
  const inema = useInemaConfig();

  const pieData = [
    { name: "Reservado", value: data.pumps.reduce((s, p) => s + p.hours_by_post.reserved, 0), color: "hsl(217 91% 60%)" },
    { name: "Fora-Ponta", value: data.pumps.reduce((s, p) => s + p.hours_by_post.off_peak, 0), color: "hsl(142 71% 45%)" },
    { name: "Intermediária", value: data.pumps.reduce((s, p) => s + p.hours_by_post.intermediate, 0), color: "hsl(38 92% 50%)" },
    { name: "Ponta", value: data.pumps.reduce((s, p) => s + p.hours_by_post.peak, 0), color: "hsl(var(--destructive))" },
  ];
  const totalHours = pieData.reduce((s, p) => s + p.value, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-primary" />
            Produtividade & Conformidade
          </h1>
          <p className="text-sm text-muted-foreground">ROI financeiro, análise tarifária Coelba e relatório INEMA.</p>
        </div>
        <Select value={periodDays} onValueChange={setPeriodDays}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Últimos 7 dias</SelectItem>
            <SelectItem value="30">Últimos 30 dias</SelectItem>
            <SelectItem value="60">Últimos 60 dias</SelectItem>
            <SelectItem value="90">Últimos 90 dias</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="roi" className="w-full">
        <TabsList>
          <TabsTrigger value="roi"><DollarSign className="w-4 h-4 mr-1.5" />ROI & Energia</TabsTrigger>
          <TabsTrigger value="inema"><FileText className="w-4 h-4 mr-1.5" />Conformidade INEMA</TabsTrigger>
          <TabsTrigger value="config"><Settings className="w-4 h-4 mr-1.5" />Configurações {!isPlatformAdmin && <Lock className="w-3 h-3 ml-1" />}</TabsTrigger>
        </TabsList>

        {/* ============ ABA ROI ============ */}
        <TabsContent value="roi" className="space-y-4 mt-4">
          {data.loading ? (
            <Card><CardContent className="py-10 text-center text-muted-foreground">Calculando…</CardContent></Card>
          ) : (
            <>
              {/* KPIs */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Kpi icon={Truck} label="Economia em Deslocamento" value={fmtBRL(data.travelSavings)} hint={`${data.remoteCommandsCount} comandos remotos`} tone="success" />
                <Kpi icon={Zap} label="Custo Energético" value={fmtBRL(data.totals.cost)} hint={`${fmtNum(data.totals.kwh, 0)} kWh`} />
                <Kpi icon={Droplets} label="Volume Bombeado" value={`${fmtNum(data.totals.volume_m3, 0)} m³`} hint={`${fmtNum(data.totals.hours, 1)} h`} tone="info" />
                <Kpi icon={DollarSign} label="Custo por m³" value={data.totals.cost_per_m3 > 0 ? fmtBRL(data.totals.cost_per_m3) : "—"} />
              </div>

              {/* Alerta de ponta */}
              {data.totals.peak_overcost > 0.01 && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>⚠️ Você gastou {fmtBRL(data.totals.peak_overcost)} a mais ligando bombas no horário de ponta (18h–21h)</AlertTitle>
                  <AlertDescription>
                    Deslocar todo o bombeamento para o horário <strong>Reservado (21h30–6h)</strong> economizaria aproximadamente <strong>{fmtBRL(data.totals.reserved_potential_savings)}</strong> no período analisado.
                  </AlertDescription>
                </Alert>
              )}

              {/* Pizza tarifária */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-base">Distribuição por posto tarifário</CardTitle></CardHeader>
                  <CardContent>
                    {totalHours > 0 ? (
                      <ResponsiveContainer width="100%" height={240}>
                        <PieChart>
                          <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={(e) => `${e.name}: ${((e.value / totalHours) * 100).toFixed(0)}%`}>
                            {pieData.map((p, i) => <Cell key={i} fill={p.color} />)}
                          </Pie>
                          <Tooltip formatter={(v: any) => `${fmtNum(Number(v), 1)} h`} />
                          <Legend />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : <div className="text-center text-muted-foreground py-12 text-sm">Sem operação no período.</div>}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-base">Custo por bomba</CardTitle></CardHeader>
                  <CardContent>
                    {data.pumps.length > 0 ? (
                      <ResponsiveContainer width="100%" height={240}>
                        <BarChart data={data.pumps.map(p => ({
                          name: p.name,
                          "Reservado": p.cost_by_post.reserved,
                          "Fora-Ponta": p.cost_by_post.off_peak,
                          "Intermediária": p.cost_by_post.intermediate,
                          "Ponta": p.cost_by_post.peak,
                        }))}>
                          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                          <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                          <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `R$${v.toFixed(0)}`} />
                          <Tooltip formatter={(v: any) => fmtBRL(Number(v))} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Bar dataKey="Reservado" stackId="a" fill="hsl(217 91% 60%)" />
                          <Bar dataKey="Fora-Ponta" stackId="a" fill="hsl(142 71% 45%)" />
                          <Bar dataKey="Intermediária" stackId="a" fill="hsl(38 92% 50%)" />
                          <Bar dataKey="Ponta" stackId="a" fill="hsl(var(--destructive))" />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <div className="text-center text-muted-foreground py-12 text-sm">Sem dados.</div>}
                  </CardContent>
                </Card>
              </div>

              {/* Tabela detalhada */}
              <Card>
                <CardHeader className="pb-2 flex-row items-center justify-between">
                  <CardTitle className="text-base">Detalhamento por bomba</CardTitle>
                  <Button size="sm" variant="outline" onClick={() => exportRoiPDF(data, periodDays)} disabled={data.pumps.length === 0}>
                    <Download className="w-4 h-4 mr-1.5" />PDF
                  </Button>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Bomba</TableHead>
                          <TableHead className="text-right">kW</TableHead>
                          <TableHead className="text-right">Vazão (m³/h)</TableHead>
                          <TableHead className="text-right">Horas</TableHead>
                          <TableHead className="text-right">kWh</TableHead>
                          <TableHead className="text-right">Volume (m³)</TableHead>
                          <TableHead className="text-right">Custo Total</TableHead>
                          <TableHead className="text-right text-destructive">Excedente Ponta</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.pumps.length === 0 && (
                          <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-6">Nenhuma operação no período.</TableCell></TableRow>
                        )}
                        {data.pumps.map(p => (
                          <TableRow key={p.equipmentId}>
                            <TableCell className="font-medium">{p.name}</TableCell>
                            <TableCell className="text-right tabular-nums">{p.power_kw ?? "—"}</TableCell>
                            <TableCell className="text-right tabular-nums">{p.estimated_flow_m3h ?? "—"}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtNum(p.hours_total, 1)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtNum(p.kwh_by_post.peak + p.kwh_by_post.intermediate + p.kwh_by_post.reserved + p.kwh_by_post.off_peak, 0)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtNum(p.volume_m3, 0)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtBRL(p.cost_total)}</TableCell>
                            <TableCell className="text-right tabular-nums text-destructive">{p.peak_overcost > 0.01 ? fmtBRL(p.peak_overcost) : "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>

              <Disclaimer />
            </>
          )}
        </TabsContent>

        {/* ============ ABA INEMA ============ */}
        <TabsContent value="inema" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4" /> Relatório de Captação INEMA</CardTitle>
                <p className="text-xs text-muted-foreground mt-1">Portaria INEMA 22.181/2021 — Medição indireta por horímetro.</p>
              </div>
              <Button size="sm" onClick={() => exportInemaPDF(data, inema.data, periodDays)} disabled={data.pumps.length === 0}>
                <Download className="w-4 h-4 mr-1.5" />Gerar PDF Oficial
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {!inema.data?.outorga_numero && (
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertDescription>Configure os dados da outorga na aba <strong>Configurações</strong> para gerar o relatório oficial.</AlertDescription>
                </Alert>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <InfoBox label="Outorga Nº" value={inema.data?.outorga_numero ?? "—"} />
                <InfoBox label="Vazão Outorgada" value={inema.data?.vazao_outorgada_m3h ? `${inema.data.vazao_outorgada_m3h} m³/h` : "—"} />
                <InfoBox label="Validade" value={inema.data?.outorga_validade ? new Date(inema.data.outorga_validade).toLocaleDateString("pt-BR") : "—"} />
                <InfoBox label="Volume Captado" value={`${fmtNum(data.totals.volume_m3, 0)} m³`} />
              </div>

              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Captação</TableHead>
                      <TableHead className="text-right">Horas operadas</TableHead>
                      <TableHead className="text-right">Vazão (m³/h)</TableHead>
                      <TableHead className="text-right">Vazão (L/s)</TableHead>
                      <TableHead className="text-right">Volume (m³)</TableHead>
                      <TableHead className="text-right">Eficiência</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.pumps.map(p => {
                      const flow = p.estimated_flow_m3h ?? 0;
                      const flowLs = (flow * 1000) / 3600;
                      const outorga = inema.data?.vazao_outorgada_m3h ?? 0;
                      const eff = outorga > 0 && flow > 0 ? Math.min(100, (flow / outorga) * 100) : 0;
                      return (
                        <TableRow key={p.equipmentId}>
                          <TableCell className="font-medium">{p.name}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtNum(p.hours_total, 2)}</TableCell>
                          <TableCell className="text-right tabular-nums">{flow || "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{flow ? fmtNum(flowLs, 2) : "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtNum(p.volume_m3, 0)}</TableCell>
                          <TableCell className="text-right tabular-nums">{eff > 0 ? `${eff.toFixed(0)}%` : "—"}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Volume diário captado (m³)</CardTitle></CardHeader>
                <CardContent>
                  {data.dailyVolume.length > 0 ? (
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={data.dailyVolume}>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                        <XAxis dataKey="day" tick={{ fontSize: 10 }} tickFormatter={(d) => new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} />
                        <YAxis tick={{ fontSize: 10 }} />
                        <Tooltip formatter={(v: any) => `${fmtNum(Number(v), 0)} m³`} />
                        <Bar dataKey="volume_m3" fill="hsl(217 91% 60%)" />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : <div className="text-center text-muted-foreground py-8 text-sm">Sem dados no período.</div>}
                </CardContent>
              </Card>
              <Disclaimer />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ============ ABA CONFIG ============ */}
        <TabsContent value="config" className="space-y-4 mt-4">
          <ConfigForm cfg={data.cfg} onSaved={data.reload} canEdit={isPlatformAdmin} farmId={farmId} />
          <InemaForm value={inema.data} onSaved={inema.reload} canEdit={isPlatformAdmin} farmId={inema.farmId} />
          <EquipmentParamsForm canEdit={isPlatformAdmin} farmId={farmId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, hint, tone = "default" }: any) {
  const tones: Record<string, string> = { default: "text-foreground", success: "text-green-600", danger: "text-destructive", info: "text-blue-600" };
  return (
    <Card><CardContent className="p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><Icon className="w-5 h-5 text-primary" /></div>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">{label}</div>
        <div className={`text-xl font-bold leading-tight ${tones[tone]}`}>{value}</div>
        {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
      </div>
    </CardContent></Card>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="border rounded-md p-2">
      <div className="text-[10px] uppercase text-muted-foreground tracking-wider">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

function Disclaimer() {
  return (
    <div className="text-[11px] text-muted-foreground border-t pt-2 italic flex items-start gap-1.5">
      <Info className="w-3 h-3 shrink-0 mt-0.5" />
      Valores financeiros são estimativas baseadas nos parâmetros configurados e postos tarifários da Coelba (Irrigante).
      O relatório INEMA utiliza medição indireta por horímetro × vazão nominal cadastrada.
    </div>
  );
}

// ─── Forms ────────────────────────────────────────────────────────────────

function ConfigForm({ cfg, onSaved, canEdit, farmId }: { cfg: ProductivityConfig; onSaved: () => void; canEdit: boolean; farmId: string | null }) {
  const [v, setV] = useState<ProductivityConfig>(cfg);
  const [saving, setSaving] = useState(false);

  const set = (k: keyof ProductivityConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV({ ...v, [k]: Number(e.target.value) });

  const save = async () => {
    if (!farmId) return;
    setSaving(true);
    const { error } = await supabase.from("farm_productivity_config" as any)
      .upsert({ farm_id: farmId, ...v, updated_at: new Date().toISOString() } as any);
    setSaving(false);
    if (error) { notify.fail("Produtividade", "Erro: " + error.message); return; }
    notify.ok("Produtividade", "Configurações salvas.");
    onSaved();
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><Truck className="w-4 h-4" />Deslocamento & Tarifas Coelba</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {!canEdit && (
          <Alert><Lock className="h-4 w-4" /><AlertDescription>Somente a Renov pode editar tarifas e parâmetros financeiros.</AlertDescription></Alert>
        )}
        <div>
          <h4 className="text-sm font-semibold mb-2">Deslocamento até os poços</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="Tempo médio (min)" value={v.travel_minutes_avg} onChange={set("travel_minutes_avg")} disabled={!canEdit} />
            <Field label="Distância (km)" value={v.travel_distance_km} onChange={set("travel_distance_km")} disabled={!canEdit} />
            <Field label="Custo funcionário (R$/h)" value={v.worker_cost_per_hour} onChange={set("worker_cost_per_hour")} disabled={!canEdit} step="0.01" />
            <Field label="Custo veículo (R$/km)" value={v.vehicle_cost_per_km} onChange={set("vehicle_cost_per_km")} disabled={!canEdit} step="0.01" />
          </div>
        </div>
        <div>
          <h4 className="text-sm font-semibold mb-2">Tarifas Coelba (Irrigante)</h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="kWh Reservado (R$)" value={v.tariff_reserved} onChange={set("tariff_reserved")} disabled={!canEdit} step="0.0001" />
            <Field label="kWh Fora-Ponta (R$)" value={v.tariff_off_peak} onChange={set("tariff_off_peak")} disabled={!canEdit} step="0.0001" />
            <Field label="kWh Intermediária (R$)" value={v.tariff_intermediate} onChange={set("tariff_intermediate")} disabled={!canEdit} step="0.0001" />
            <Field label="kWh Ponta (R$)" value={v.tariff_peak} onChange={set("tariff_peak")} disabled={!canEdit} step="0.0001" />
            <Field label="Demanda contratada (kW)" value={v.contracted_demand_kw} onChange={set("contracted_demand_kw")} disabled={!canEdit} />
            <Field label="Custo demanda (R$/kW)" value={v.demand_cost_per_kw} onChange={set("demand_cost_per_kw")} disabled={!canEdit} step="0.01" />
          </div>
        </div>
        {canEdit && (
          <Button onClick={save} disabled={saving}><Save className="w-4 h-4 mr-1.5" />{saving ? "Salvando…" : "Salvar configurações"}</Button>
        )}
      </CardContent>
    </Card>
  );
}

function InemaForm({ value, onSaved, canEdit, farmId }: { value: any; onSaved: () => void; canEdit: boolean; farmId: string | null }) {
  const [v, setV] = useState(value ?? {});
  const [saving, setSaving] = useState(false);
  // Sincroniza quando o valor recarrega (com chave estável pra não causar loop)
  const valKey = JSON.stringify(value ?? {});
  useMemoEffect(() => { setV(value ?? {}); }, [valKey]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });

  const save = async () => {
    if (!farmId) return;
    setSaving(true);
    const payload: any = {
      farm_id: farmId,
      outorga_numero: v.outorga_numero || null,
      outorga_processo: v.outorga_processo || null,
      outorga_validade: v.outorga_validade || null,
      vazao_outorgada_m3h: v.vazao_outorgada_m3h ? Number(v.vazao_outorgada_m3h) : null,
      orgao: v.orgao || "INEMA",
      responsavel_tecnico: v.responsavel_tecnico || null,
      observacoes: v.observacoes || null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("farm_inema_config" as any).upsert(payload);
    setSaving(false);
    if (error) { notify.fail("Produtividade", "Erro: " + error.message); return; }
    notify.ok("Produtividade", "Dados INEMA salvos.");
    onSaved();
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4" />Dados da Outorga (INEMA)</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Field text label="Outorga Nº" value={v.outorga_numero ?? ""} onChange={set("outorga_numero")} disabled={!canEdit} />
          <Field text label="Processo" value={v.outorga_processo ?? ""} onChange={set("outorga_processo")} disabled={!canEdit} />
          <Field text label="Validade" value={v.outorga_validade ?? ""} onChange={set("outorga_validade")} disabled={!canEdit} type="date" />
          <Field label="Vazão outorgada (m³/h)" value={v.vazao_outorgada_m3h ?? 0} onChange={set("vazao_outorgada_m3h")} disabled={!canEdit} />
          <Field text label="Órgão" value={v.orgao ?? "INEMA"} onChange={set("orgao")} disabled={!canEdit} />
          <Field text label="Responsável técnico" value={v.responsavel_tecnico ?? ""} onChange={set("responsavel_tecnico")} disabled={!canEdit} />
        </div>
        {canEdit && <Button onClick={save} disabled={saving}><Save className="w-4 h-4 mr-1.5" />{saving ? "Salvando…" : "Salvar dados INEMA"}</Button>}
      </CardContent>
    </Card>
  );
}

function EquipmentParamsForm({ canEdit, farmId }: { canEdit: boolean; farmId: string | null }) {
  const [eqs, setEqs] = useState<any[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  useMemoEffect(() => {
    if (!farmId) return;
    void supabase.from("equipments")
      .select("id, name, estimated_flow_m3h, power_kw")
      .eq("farm_id", farmId).in("type", ["poco", "bombeamento"] as any)
      .order("name")
      .then(({ data }) => setEqs(data ?? []));
  }, [farmId]);

  const updateField = (id: string, field: "estimated_flow_m3h" | "power_kw", val: string) => {
    setEqs(prev => prev.map(e => e.id === id ? { ...e, [field]: val === "" ? null : Number(val) } : e));
  };

  const saveOne = async (eq: any) => {
    setSaving(eq.id);
    const { error } = await supabase.from("equipments")
      .update({ estimated_flow_m3h: eq.estimated_flow_m3h, power_kw: eq.power_kw } as any)
      .eq("id", eq.id);
    setSaving(null);
    if (error) notify.fail("Produtividade", "Erro: " + error.message);
    else notify.ok("Produtividade", `${eq.name} atualizado.`);
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Parâmetros por bomba (vazão & potência)</CardTitle></CardHeader>
      <CardContent>
        {!canEdit && <Alert className="mb-3"><Lock className="h-4 w-4" /><AlertDescription>Somente a Renov pode editar.</AlertDescription></Alert>}
        <Table>
          <TableHeader><TableRow>
            <TableHead>Bomba</TableHead>
            <TableHead className="w-[160px]">Vazão estimada (m³/h)</TableHead>
            <TableHead className="w-[140px]">Potência (kW)</TableHead>
            <TableHead className="w-[100px]"></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {eqs.length === 0 && <TableRow><TableCell colSpan={4} className="text-center py-4 text-muted-foreground text-sm">Nenhuma bomba cadastrada.</TableCell></TableRow>}
            {eqs.map(eq => (
              <TableRow key={eq.id}>
                <TableCell className="font-medium">{eq.name}</TableCell>
                <TableCell><Input type="number" step="0.1" value={eq.estimated_flow_m3h ?? ""} onChange={(e) => updateField(eq.id, "estimated_flow_m3h", e.target.value)} disabled={!canEdit} /></TableCell>
                <TableCell><Input type="number" step="0.1" value={eq.power_kw ?? ""} onChange={(e) => updateField(eq.id, "power_kw", e.target.value)} disabled={!canEdit} /></TableCell>
                <TableCell>{canEdit && <Button size="sm" variant="outline" onClick={() => saveOne(eq)} disabled={saving === eq.id}>Salvar</Button>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Field({ label, value, onChange, disabled, step, text, type }: {
  label: string; value: number | string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean; step?: string; text?: boolean; type?: string;
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input type={type ?? (text ? "text" : "number")} step={step} value={value as any} onChange={onChange} disabled={disabled} className="h-9" />
    </div>
  );
}

// useEffect com chave estável pra não infinite loop
import { useEffect } from "react";
function useMemoEffect(fn: () => void, deps: any[]) { useEffect(fn, deps); }

// ─── PDF exports ──────────────────────────────────────────────────────────

function pdfHeader(doc: jsPDF, title: string, subtitle: string) {
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(66, 147, 80);
  doc.rect(0, 0, w, 50, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16); doc.setFont("helvetica", "bold");
  doc.text("Renov Tecnologia Agrícola", 30, 22);
  doc.setFontSize(11); doc.setFont("helvetica", "normal");
  doc.text(title, 30, 38);
  doc.setFontSize(9);
  doc.text(subtitle, w - 30, 38, { align: "right" });
  doc.setTextColor(0, 0, 0);
}

function exportRoiPDF(d: ReturnType<typeof useProductivityData>, periodDays: string) {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  pdfHeader(doc, "Relatório de Produtividade & Energia", `Últimos ${periodDays} dias  |  ${new Date().toLocaleString("pt-BR")}`);
  doc.setFontSize(10);
  doc.text(
    `Volume: ${fmtNum(d.totals.volume_m3, 0)} m³  |  Horas: ${fmtNum(d.totals.hours, 1)} h  |  Energia: ${fmtNum(d.totals.kwh, 0)} kWh  |  Custo: ${fmtBRL(d.totals.cost)}  |  Custo/m³: ${d.totals.cost_per_m3 > 0 ? fmtBRL(d.totals.cost_per_m3) : "—"}`,
    30, 70,
  );
  doc.text(
    `Economia em deslocamento: ${fmtBRL(d.travelSavings)} (${d.remoteCommandsCount} comandos remotos)  |  Excedente em ponta: ${fmtBRL(d.totals.peak_overcost)}`,
    30, 84,
  );
  autoTable(doc, {
    startY: 100,
    head: [["Bomba", "kW", "m³/h", "Horas Ponta", "Horas Interm.", "Horas Reserv.", "Horas Fora-Ponta", "Volume (m³)", "Custo Total", "Excedente Ponta"]],
    body: d.pumps.map(p => [
      p.name, p.power_kw ?? "—", p.estimated_flow_m3h ?? "—",
      fmtNum(p.hours_by_post.peak, 1), fmtNum(p.hours_by_post.intermediate, 1), fmtNum(p.hours_by_post.reserved, 1), fmtNum(p.hours_by_post.off_peak, 1),
      fmtNum(p.volume_m3, 0), fmtBRL(p.cost_total), p.peak_overcost > 0.01 ? fmtBRL(p.peak_overcost) : "—",
    ]),
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [66, 147, 80], textColor: 255, fontStyle: "bold" },
  });
  doc.setFontSize(8); doc.setTextColor(120);
  doc.text("Valores financeiros são estimativas baseadas nas tarifas configuradas (Coelba Irrigante).", 30, doc.internal.pageSize.getHeight() - 20);
  doc.save(`renov-produtividade-${new Date().toISOString().slice(0, 10)}.pdf`);
  notify.ok("Produtividade", "PDF exportado.");
}

function exportInemaPDF(d: ReturnType<typeof useProductivityData>, inema: any, periodDays: string) {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  pdfHeader(doc, "Relatório de Captação de Água — INEMA", `Portaria 22.181/2021  |  Últimos ${periodDays} dias`);
  doc.setFontSize(10);
  let y = 70;
  doc.setFont("helvetica", "bold"); doc.text("Identificação", 30, y); y += 14;
  doc.setFont("helvetica", "normal");
  doc.text(`Outorga Nº: ${inema?.outorga_numero ?? "—"}`, 30, y); y += 12;
  doc.text(`Processo: ${inema?.outorga_processo ?? "—"}`, 30, y); y += 12;
  doc.text(`Validade: ${inema?.outorga_validade ? new Date(inema.outorga_validade).toLocaleDateString("pt-BR") : "—"}`, 30, y); y += 12;
  doc.text(`Vazão outorgada: ${inema?.vazao_outorgada_m3h ?? "—"} m³/h`, 30, y); y += 12;
  doc.text(`Responsável técnico: ${inema?.responsavel_tecnico ?? "—"}`, 30, y); y += 18;

  doc.setFont("helvetica", "bold"); doc.text("Resumo do período", 30, y); y += 14;
  doc.setFont("helvetica", "normal");
  doc.text(`Volume total captado: ${fmtNum(d.totals.volume_m3, 0)} m³`, 30, y); y += 12;
  doc.text(`Horas totais de bombeamento: ${fmtNum(d.totals.hours, 2)} h`, 30, y); y += 18;

  autoTable(doc, {
    startY: y,
    head: [["Captação", "Horas", "Vazão (m³/h)", "Vazão (L/s)", "Volume (m³)", "Eficiência"]],
    body: d.pumps.map(p => {
      const flow = p.estimated_flow_m3h ?? 0;
      const flowLs = (flow * 1000) / 3600;
      const outorga = inema?.vazao_outorgada_m3h ?? 0;
      const eff = outorga > 0 && flow > 0 ? Math.min(100, (flow / outorga) * 100) : 0;
      return [p.name, fmtNum(p.hours_total, 2), flow || "—", flow ? fmtNum(flowLs, 2) : "—", fmtNum(p.volume_m3, 0), eff > 0 ? `${eff.toFixed(0)}%` : "—"];
    }),
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [66, 147, 80], textColor: 255 },
  });

  doc.setFontSize(8); doc.setTextColor(120);
  doc.text("Medição indireta por horímetro × vazão nominal cadastrada (Portaria INEMA 22.181/2021).", 30, doc.internal.pageSize.getHeight() - 30);
  doc.text(`Gerado em ${new Date().toLocaleString("pt-BR")} por Gestor de Bombas Renov.`, 30, doc.internal.pageSize.getHeight() - 18);
  doc.save(`renov-inema-${new Date().toISOString().slice(0, 10)}.pdf`);
  notify.ok("Produtividade", "Relatório INEMA exportado.");
}
