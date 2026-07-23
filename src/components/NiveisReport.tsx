import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from "recharts";
import { Droplet, AlertTriangle, Download, FileText, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useLevelHistory } from "@/hooks/useLevelHistory";
import { notify } from "@/lib/notify";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

interface Props {
  fromDate: string;
  toDate: string;
}

const NiveisReport = ({ fromDate, toDate }: Props) => {
  const farmId = useDefaultFarmId();
  const [equipments, setEquipments] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [criticalLevel, setCriticalLevel] = useState<number>(20);
  const [renderReady, setRenderReady] = useState(false);
  const [equipmentLoading, setEquipmentLoading] = useState(false);

  useEffect(() => {
    setRenderReady(false);
    const id = window.setTimeout(() => setRenderReady(true), 0);
    return () => window.clearTimeout(id);
  }, [farmId, fromDate, toDate]);

  useEffect(() => {
    if (!renderReady || !farmId) { setEquipments([]); setEquipmentLoading(false); return; }
    let cancelled = false;
    setEquipmentLoading(true);
    (async () => {
      const { data } = await supabase
        .from("equipments")
        .select("id, name")
        .eq("farm_id", farmId)
        .eq("type", "nivel")
        .eq("active", true)
        .order("name");
      if (cancelled) return;
      const list = data ?? [];
      setEquipments(list);
      if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
      setEquipmentLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmId, renderReady]);

  const range = useMemo(() => ({
    from: new Date(`${fromDate}T00:00:00`),
    to: new Date(`${toDate}T23:59:59.999`),
  }), [fromDate, toDate]);

  const { data, loading, hasLoaded, error } = useLevelHistory(selectedId || null, range.from, range.to, renderReady);

  const chartData = useMemo(
    () => data.slice(-200).map((d) => ({
      time: new Date(d.read_at).getTime(),
      label: new Date(d.read_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
      percent: d.percent,
      meters: d.meters,
    })),
    [data],
  );

  const summary = useMemo(() => {
    const pcts = data.map((d) => d.percent).filter((v): v is number => v != null);
    const current = pcts.length ? pcts[pcts.length - 1] : null;
    const max = pcts.length ? Math.max(...pcts) : null;
    const min = pcts.length ? Math.min(...pcts) : null;

    let timeBelowMs = 0;
    for (let i = 1; i < data.length; i++) {
      const a = data[i - 1]; const b = data[i];
      if (a.percent != null && a.percent < criticalLevel) {
        timeBelowMs += new Date(b.read_at).getTime() - new Date(a.read_at).getTime();
      }
    }
    const hoursBelow = timeBelowMs / 3600000;

    return { current, max, min, hoursBelow, calibrated: data.some((d) => d.is_calibrated) };
  }, [data, criticalLevel]);

  const equipName = equipments.find((e) => e.id === selectedId)?.name ?? "—";

  if (!renderReady || equipmentLoading || loading || (selectedId && !hasLoaded)) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-3">Carregando níveis...</span>
      </div>
    );
  }

  const exportPDF = async () => {
    const doc = new jsPDF();
    doc.setFontSize(14); doc.setFont("helvetica", "bold");
    doc.text("Relatório de Comportamento de Nível", 14, 18);
    doc.setFontSize(10); doc.setFont("helvetica", "normal");
    doc.text(`Equipamento: ${equipName}`, 14, 26);
    doc.text(`Período: ${fromDate.split("-").reverse().join("/")} a ${toDate.split("-").reverse().join("/")}`, 14, 32);
    doc.text(`Atual: ${summary.current?.toFixed(1) ?? "—"}%   Máx: ${summary.max?.toFixed(1) ?? "—"}%   Mín: ${summary.min?.toFixed(1) ?? "—"}%   Tempo < ${criticalLevel}%: ${summary.hoursBelow.toFixed(1)}h`, 14, 38);

    autoTable(doc, {
      startY: 44,
      head: [["Data/Hora", "Nível (%)", "Metros"]],
      body: data.map((d) => [
        new Date(d.read_at).toLocaleString("pt-BR"),
        d.percent != null ? d.percent.toFixed(1) : "—",
        d.meters != null ? d.meters.toFixed(2) : "—",
      ]),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [0, 120, 200], textColor: 255 },
    });

    doc.save(`relatorio-nivel-${equipName}.pdf`);
    notify.ok("Relatório de Níveis", "PDF exportado!");
  };

  if (equipments.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="py-12 text-center">
          <Droplet className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
          <p className="text-sm font-medium text-foreground">Nenhum equipamento de nível cadastrado</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Equipamento</label>
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger className="bg-secondary border-border mt-1 w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                {equipments.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Nível crítico (%)</label>
            <Input
              type="number" min={0} max={100}
              value={criticalLevel}
              onChange={(e) => setCriticalLevel(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
              className="bg-secondary border-border mt-1 w-28"
            />
          </div>
          <div className="ml-auto">
            <Button variant="outline" size="sm" className="border-border gap-1" onClick={exportPDF} disabled={data.length === 0}>
              <FileText className="w-3.5 h-3.5" /> PDF
            </Button>
          </div>
        </CardContent>
      </Card>

      {!summary.calibrated && data.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-warning bg-warning/10 border border-warning/30 rounded px-3 py-2">
          <AlertTriangle className="w-4 h-4" />
          Equipamento sem calibração configurada — valores em metros podem ser imprecisos.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="bg-card border-border"><CardContent className="p-3">
          <p className="text-[11px] text-muted-foreground">Atual</p>
          <p className="text-xl font-bold text-primary">{summary.current?.toFixed(1) ?? "—"}%</p>
        </CardContent></Card>
        <Card className="bg-card border-border"><CardContent className="p-3">
          <p className="text-[11px] text-muted-foreground">Máximo</p>
          <p className="text-xl font-bold text-foreground">{summary.max?.toFixed(1) ?? "—"}%</p>
        </CardContent></Card>
        <Card className="bg-card border-border"><CardContent className="p-3">
          <p className="text-[11px] text-muted-foreground">Mínimo</p>
          <p className="text-xl font-bold text-foreground">{summary.min?.toFixed(1) ?? "—"}%</p>
        </CardContent></Card>
        <Card className="bg-card border-border"><CardContent className="p-3">
          <p className="text-[11px] text-muted-foreground">Tempo abaixo do crítico</p>
          <p className="text-xl font-bold text-destructive">{summary.hoursBelow.toFixed(1)}h</p>
        </CardContent></Card>
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-foreground">Comportamento do Nível</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-6 text-center text-xs text-muted-foreground">Carregando…</div>

          ) : error ? (
            <div className="py-12 text-center text-sm text-destructive">Erro: {error}</div>
          ) : chartData.length === 0 ? (
            <div className="py-12 text-center">
              <Droplet className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
              <p className="text-sm font-medium text-foreground">Sem leituras no período</p>
              <p className="text-xs text-muted-foreground mt-1">O histórico só registra mudanças significativas (≥2%) ou após 30 minutos.</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }}
                  formatter={(v: number, name: string, p: { payload?: { meters?: number | null } }) => {
                    const m = p?.payload?.meters;
                    return [`${Number(v).toFixed(1)}%${m != null ? ` (${m.toFixed(2)} m)` : ""}`, "Nível"];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine y={criticalLevel} stroke="hsl(var(--destructive))" strokeDasharray="4 4" label={{ value: `Crítico ${criticalLevel}%`, fill: "hsl(var(--destructive))", fontSize: 10 }} />
                <Line type="monotone" dataKey="percent" name="N1 (%)" stroke="hsl(var(--info))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default NiveisReport;
