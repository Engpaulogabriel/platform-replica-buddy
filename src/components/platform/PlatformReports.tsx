import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { notify } from "@/lib/notify";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend, BarChart, Bar } from "recharts";
import {
  FileText, Download, RefreshCw, TrendingUp, Activity, AlertOctagon, Clock, Trophy, FileSpreadsheet,
} from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

interface ReportRow {
  farm_id: string;
  farm_name: string;
  city: string | null;
  state: string | null;
  plan: string;
  equipments_count: number;
  users_count: number;
  agent_online: boolean;
  runtime_hours: number;
  commands_total: number;
  commands_success: number;
  commands_failed: number;
  automations_fired: number;
  alerts_critical: number;
  alerts_warning: number;
  last_heartbeat: string | null;
}

interface TimelineRow { day: string; commands_total: number; alerts_critical: number; automations_fired: number }

const PERIODS: Record<string, number> = { "7": 7, "30": 30, "90": 90 };

export default function PlatformReports({ isAdmin: _isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [periodDays, setPeriodDays] = useState<string>("30");

  const refresh = useCallback(async () => {
    setLoading(true);
    const since = new Date(Date.now() - PERIODS[periodDays] * 86400_000).toISOString();
    const until = new Date().toISOString();
    const [consRes, tlRes] = await Promise.all([
      supabase.rpc("platform_reports_consolidated" as any, { p_since: since, p_until: until }),
      supabase.rpc("platform_reports_timeline" as any, { p_since: since, p_until: until }),
    ]);
    if (consRes.error) notify.fail("Relatórios", "Erro: " + consRes.error.message);
    else setRows((consRes.data as any) ?? []);
    if (!tlRes.error) setTimeline((tlRes.data as any) ?? []);
    setLoading(false);
  }, [periodDays]);

  useEffect(() => { void refresh(); }, [refresh]);

  // KPIs agregados
  const totals = useMemo(() => {
    return rows.reduce((acc, r) => ({
      farms: acc.farms + 1,
      online: acc.online + (r.agent_online ? 1 : 0),
      runtime: acc.runtime + Number(r.runtime_hours || 0),
      commands: acc.commands + r.commands_total,
      success: acc.success + r.commands_success,
      failed: acc.failed + r.commands_failed,
      automations: acc.automations + r.automations_fired,
      critical: acc.critical + r.alerts_critical,
      warning: acc.warning + r.alerts_warning,
      equipments: acc.equipments + r.equipments_count,
    }), { farms: 0, online: 0, runtime: 0, commands: 0, success: 0, failed: 0, automations: 0, critical: 0, warning: 0, equipments: 0 });
  }, [rows]);

  // Top fazendas (ranking)
  const topRuntime = useMemo(() => [...rows].sort((a, b) => b.runtime_hours - a.runtime_hours).slice(0, 5), [rows]);
  const topCritical = useMemo(() => [...rows].filter(r => r.alerts_critical > 0).sort((a, b) => b.alerts_critical - a.alerts_critical).slice(0, 5), [rows]);
  const topCommands = useMemo(() => [...rows].sort((a, b) => b.commands_total - a.commands_total).slice(0, 5), [rows]);

  const exportCSV = () => {
    const header = ["Fazenda", "Cidade/UF", "Plano", "Equipamentos", "Usuários", "Agente", "Horas operação", "Cmd total", "Cmd sucesso", "Cmd falha", "Automações", "Alertas críticos", "Alertas avisos"];
    const lines = rows.map(r => [
      r.farm_name,
      `${r.city ?? ""}${r.state ? "/" + r.state : ""}`,
      r.plan,
      r.equipments_count,
      r.users_count,
      r.agent_online ? "Online" : "Offline",
      r.runtime_hours,
      r.commands_total,
      r.commands_success,
      r.commands_failed,
      r.automations_fired,
      r.alerts_critical,
      r.alerts_warning,
    ]);
    const csv = [header, ...lines].map(row => row.map(c => {
      const s = String(c ?? "");
      return s.includes(",") || s.includes(";") || s.includes("\"") ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `renov-relatorio-consolidado-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    notify.ok("Relatórios", "CSV exportado.");
  };

  const exportPDF = () => {
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    // Cabeçalho
    doc.setFillColor(66, 147, 80); // brand green
    doc.rect(0, 0, pageWidth, 50, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text("Renov Tecnologia Agricola", 30, 22);
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.text("Relatorio Consolidado da Plataforma", 30, 38);
    doc.setFontSize(9);
    doc.text(`Periodo: ultimos ${periodDays} dias  |  Gerado em ${new Date().toLocaleString("pt-BR")}`,
      pageWidth - 30, 38, { align: "right" });

    // Resumo
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(10);
    doc.text(`Fazendas: ${totals.farms}  |  Online: ${totals.online}  |  Equipamentos: ${totals.equipments}  |  Horas op.: ${totals.runtime.toFixed(1)}h  |  Comandos: ${totals.commands} (${totals.success} ok / ${totals.failed} falha)  |  Alertas criticos: ${totals.critical}`,
      30, 70);

    // Tabela
    autoTable(doc, {
      startY: 85,
      head: [["Fazenda", "Local", "Plano", "Equip.", "Usr", "Agente", "Horas op.", "Cmd", "OK", "Falha", "Autom.", "Crit.", "Avisos"]],
      body: rows.map(r => [
        r.farm_name,
        `${r.city ?? "—"}${r.state ? "/" + r.state : ""}`,
        r.plan.toUpperCase(),
        r.equipments_count,
        r.users_count,
        r.agent_online ? "ON" : "OFF",
        Number(r.runtime_hours).toFixed(1),
        r.commands_total,
        r.commands_success,
        r.commands_failed,
        r.automations_fired,
        r.alerts_critical,
        r.alerts_warning,
      ]),
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [66, 147, 80], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      didParseCell: (d) => {
        if (d.section === "body") {
          if (d.column.index === 5 && d.cell.raw === "OFF") d.cell.styles.textColor = [200, 30, 30];
          if (d.column.index === 11 && Number(d.cell.raw) > 0) d.cell.styles.textColor = [200, 30, 30];
          if (d.column.index === 9 && Number(d.cell.raw) > 0) d.cell.styles.textColor = [200, 100, 0];
        }
      },
    });

    // Rodapé
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(`Gestor de Bombas Renov  -  pagina ${i}/${pages}`, pageWidth / 2, doc.internal.pageSize.getHeight() - 15, { align: "center" });
    }

    doc.save(`renov-relatorio-consolidado-${new Date().toISOString().slice(0, 10)}.pdf`);
    notify.ok("Relatórios", "PDF exportado.");
  };

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <Kpi icon={Clock} label="Horas op. (total)" value={totals.runtime.toFixed(1) + "h"} />
        <Kpi icon={Activity} label="Comandos" value={totals.commands} hint={`${totals.success} ok · ${totals.failed} falha`} />
        <Kpi icon={TrendingUp} label="Automações" value={totals.automations} />
        <Kpi icon={AlertOctagon} label="Alertas críticos" value={totals.critical} tone="danger" />
        <Kpi icon={Trophy} label="Fazendas online" value={`${totals.online}/${totals.farms}`} tone="success" />
        <Kpi icon={FileText} label="Equipamentos" value={totals.equipments} />
      </div>

      {/* Controles */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4" /> Relatório consolidado
            </CardTitle>
            <div className="flex gap-2 flex-wrap">
              <Select value={periodDays} onValueChange={setPeriodDays}>
                <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">Últimos 7 dias</SelectItem>
                  <SelectItem value="30">Últimos 30 dias</SelectItem>
                  <SelectItem value="90">Últimos 90 dias</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
                <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />Atualizar
              </Button>
              <Button variant="outline" size="sm" onClick={exportCSV} disabled={!rows.length}>
                <FileSpreadsheet className="w-4 h-4 mr-1.5" />CSV
              </Button>
              <Button size="sm" onClick={exportPDF} disabled={!rows.length}>
                <Download className="w-4 h-4 mr-1.5" />PDF
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Timeline */}
          <div>
            <div className="text-sm font-medium mb-2">Atividade diária (cross-farm)</div>
            <div className="h-[220px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={timeline}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} tickFormatter={(d) => new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="commands_total" stroke="hsl(var(--primary))" name="Comandos" dot={false} />
                  <Line type="monotone" dataKey="automations_fired" stroke="hsl(217 91% 60%)" name="Automações" dot={false} />
                  <Line type="monotone" dataKey="alerts_critical" stroke="hsl(var(--destructive))" name="Críticos" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Tabela */}
          <div className="overflow-x-auto border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fazenda</TableHead>
                  <TableHead>Local</TableHead>
                  <TableHead>Plano</TableHead>
                  <TableHead className="text-center">Equip.</TableHead>
                  <TableHead className="text-center">Agente</TableHead>
                  <TableHead className="text-right">Horas op.</TableHead>
                  <TableHead className="text-right">Cmd</TableHead>
                  <TableHead className="text-right">OK / Falha</TableHead>
                  <TableHead className="text-right">Autom.</TableHead>
                  <TableHead className="text-right">Críticos</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-6">
                    {loading ? "Carregando…" : "Nenhuma fazenda encontrada."}
                  </TableCell></TableRow>
                )}
                {rows.map(r => (
                  <TableRow key={r.farm_id}>
                    <TableCell className="font-medium">{r.farm_name}</TableCell>
                    <TableCell className="text-sm">{r.city ? `${r.city}${r.state ? "/" + r.state : ""}` : "—"}</TableCell>
                    <TableCell><Badge variant={r.plan === "pro" ? "default" : "secondary"} className="uppercase text-[10px]">{r.plan}</Badge></TableCell>
                    <TableCell className="text-center">{r.equipments_count}</TableCell>
                    <TableCell className="text-center">
                      {r.agent_online
                        ? <span className="inline-flex items-center gap-1 text-xs"><span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />Online</span>
                        : <span className="text-xs text-muted-foreground">Offline</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{Number(r.runtime_hours).toFixed(1)}h</TableCell>
                    <TableCell className="text-right tabular-nums">{r.commands_total}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      <span className="text-green-600">{r.commands_success}</span>
                      {" / "}
                      <span className={r.commands_failed > 0 ? "text-destructive" : ""}>{r.commands_failed}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.automations_fired}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.alerts_critical > 0
                        ? <Badge variant="destructive">{r.alerts_critical}</Badge>
                        : <span className="text-muted-foreground">0</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Rankings */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <RankingCard title="Top 5 — Horas operação" rows={topRuntime} dataKey="runtime_hours" suffix="h" color="hsl(142 71% 45%)" />
            <RankingCard title="Top 5 — Comandos" rows={topCommands} dataKey="commands_total" color="hsl(var(--primary))" />
            <RankingCard title="Top 5 — Alertas críticos" rows={topCritical} dataKey="alerts_critical" color="hsl(var(--destructive))" empty="Nenhuma fazenda com críticos 🎉" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, hint, tone = "default" }: any) {
  const tones: Record<string, string> = {
    default: "text-foreground",
    success: "text-green-600",
    danger: "text-destructive",
  };
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

function RankingCard({ title, rows, dataKey, suffix = "", color, empty }: any) {
  if (!rows.length) {
    return (
      <Card><CardHeader className="pb-2"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
        <CardContent className="text-xs text-muted-foreground py-6 text-center">{empty ?? "Sem dados"}</CardContent></Card>
    );
  }
  const data = rows.map((r: any) => ({ name: r.farm_name, value: Number(r[dataKey]) }));
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent className="h-[200px] p-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ left: 10, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis type="number" tick={{ fontSize: 10 }} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={100} />
            <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: any) => `${v}${suffix}`} />
            <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
