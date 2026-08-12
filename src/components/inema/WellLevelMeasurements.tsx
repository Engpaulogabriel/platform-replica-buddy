// Setor Técnico — Registro de Níveis (NE/ND) por poço. O operador registra o
// nível ESTÁTICO (bomba parada ≥24h) e o DINÂMICO (bomba operando estabilizada)
// para atender ao monitoramento de níveis das outorgas INEMA. Alerta quando um
// poço está há mais de 6 meses sem medição. Grava em well_level_measurements.
import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { notify } from "@/lib/notify";
import { Gauge, Plus, RefreshCw, AlertTriangle } from "lucide-react";

interface Farm { id: string; name: string }
interface Equip { id: string; name: string }
interface Measurement {
  id: string; equipment_id: string | null; measured_at: string;
  static_level_m: number | null; dynamic_level_m: number | null; notes: string | null;
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
const fmtM = (n: number | null) => (n == null ? "—" : `${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`);
const daysSince = (iso: string) => Math.floor((Date.now() - new Date(iso + "T00:00:00").getTime()) / 86_400_000);

export default function WellLevelMeasurements() {
  const [farms, setFarms] = useState<Farm[]>([]);
  const [farmId, setFarmId] = useState<string>("");
  const [equips, setEquips] = useState<Equip[]>([]);
  const [rows, setRows] = useState<Measurement[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form
  const [eqId, setEqId] = useState<string>("");
  const [date, setDate] = useState<string>(todayIso());
  const [ne, setNe] = useState<string>("");
  const [nd, setNd] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  useEffect(() => {
    void supabase.from("farms").select("id, name").order("name").then(({ data }) => {
      const list = ((data ?? []) as any[]).filter((f) => f?.id && f?.name);
      setFarms(list);
      if (!farmId && list.length) setFarmId(list[0].id);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!farmId) { setEquips([]); setRows([]); return; }
    setLoading(true);
    const [{ data: eqRows }, { data: mRows }] = await Promise.all([
      supabase.from("equipments").select("id, name").eq("farm_id", farmId).eq("type", "poco").eq("active", true).order("name"),
      supabase.from("well_level_measurements" as any)
        .select("id, equipment_id, measured_at, static_level_m, dynamic_level_m, notes")
        .eq("farm_id", farmId).order("measured_at", { ascending: false }).limit(200),
    ]);
    setEquips((eqRows ?? []) as Equip[]);
    setRows(((mRows ?? []) as any[]) as Measurement[]);
    setLoading(false);
  }, [farmId]);

  useEffect(() => { void load(); }, [load]);

  const eqNameById = useMemo(() => new Map(equips.map((e) => [e.id, e.name])), [equips]);

  // Última medição por poço → alerta de >6 meses (180 dias) ou sem registro.
  const overdue = useMemo(() => {
    const last = new Map<string, string>();
    for (const r of rows) {
      if (!r.equipment_id) continue;
      const cur = last.get(r.equipment_id);
      if (!cur || r.measured_at > cur) last.set(r.equipment_id, r.measured_at);
    }
    return equips
      .map((e) => ({ id: e.id, name: e.name, last: last.get(e.id) ?? null }))
      .filter((e) => !e.last || daysSince(e.last) > 180)
      .sort((a, b) => (a.last ?? "").localeCompare(b.last ?? ""));
  }, [equips, rows]);

  const save = async () => {
    if (!farmId || !eqId) { notify.fail("Níveis", "Selecione fazenda e poço."); return; }
    if (!ne && !nd) { notify.fail("Níveis", "Informe NE e/ou ND."); return; }
    setSaving(true);
    const { error } = await supabase.from("well_level_measurements" as any).insert({
      farm_id: farmId,
      equipment_id: eqId,
      measured_at: date || todayIso(),
      static_level_m: ne === "" ? null : Number(ne.replace(",", ".")),
      dynamic_level_m: nd === "" ? null : Number(nd.replace(",", ".")),
      notes: notes.trim() || null,
    } as any);
    setSaving(false);
    if (error) { notify.fail("Níveis", "Não foi possível salvar. Tente novamente."); return; }
    notify.ok("Níveis", "Medição registrada.");
    setNe(""); setNd(""); setNotes("");
    void load();
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Gauge className="w-4 h-4 text-primary" /> Registro de Níveis (NE / ND) — Poços
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Fazenda */}
        <div className="flex flex-col gap-1 w-full sm:w-[280px]">
          <Label className="text-xs text-muted-foreground">Fazenda</Label>
          <Select value={farmId} onValueChange={setFarmId}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Selecione" /></SelectTrigger>
            <SelectContent>
              {farms.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Alerta de medições vencidas (>6 meses) */}
        {overdue.length > 0 && (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
            <div className="flex items-center gap-1.5 font-semibold text-warning mb-1">
              <AlertTriangle className="w-4 h-4" /> {overdue.length} poço(s) sem medição há mais de 6 meses
            </div>
            <div className="flex flex-wrap gap-1.5">
              {overdue.map((o) => (
                <Badge key={o.id} variant="outline" className="border-warning/50 text-warning">
                  {o.name}: {o.last ? `${fmtDate(o.last)} (${daysSince(o.last)}d)` : "nunca medido"}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Formulário */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Poço</Label>
            <Select value={eqId} onValueChange={setEqId}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Selecione" /></SelectTrigger>
              <SelectContent>
                {equips.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Data da medição</Label>
            <Input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">NE — nível estático (m)</Label>
            <Input inputMode="decimal" placeholder="bomba parada ≥24h" value={ne} onChange={(e) => setNe(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">ND — nível dinâmico (m)</Label>
            <Input inputMode="decimal" placeholder="bomba operando estável" value={nd} onChange={(e) => setNd(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-3">
            <Label className="text-xs text-muted-foreground">Observações</Label>
            <Textarea rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
          </div>
          <div className="flex items-end">
            <Button onClick={save} disabled={saving || !farmId || !eqId} className="w-full">
              <Plus className="w-4 h-4 mr-1.5" /> {saving ? "Salvando…" : "Registrar"}
            </Button>
          </div>
        </div>

        {/* Histórico */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase">Histórico de medições</span>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Atualizar
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground mb-1 sm:hidden">← deslize para ver todas as colunas →</p>
          <div className="overflow-x-auto -mx-2 px-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Poço</TableHead>
                  <TableHead className="text-right">NE (m)</TableHead>
                  <TableHead className="text-right">ND (m)</TableHead>
                  <TableHead>Observações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-xs py-6">
                    {loading ? "Carregando…" : "Sem medições registradas."}
                  </TableCell></TableRow>
                )}
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{fmtDate(r.measured_at)}</TableCell>
                    <TableCell>{r.equipment_id ? (eqNameById.get(r.equipment_id) ?? "—") : "—"}</TableCell>
                    <TableCell className="text-right">{fmtM(r.static_level_m)}</TableCell>
                    <TableCell className="text-right">{fmtM(r.dynamic_level_m)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[240px] truncate">{r.notes ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
