import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Save, Settings2, Wand2, Lock } from "lucide-react";
import { toast } from "sonner";

const CV_TO_KW = 0.7355;

type EqType = "poco" | "bombeamento";

interface Row {
  id: string;
  name: string;
  type: EqType;
  power_cv: string;
  estimated_flow_m3h: string;
  dirty?: boolean;
}

interface Props {
  farmId: string | null;
  canEdit: boolean;
}

export default function EquipmentPowerConfig({ farmId, canEdit }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<"all" | EqType>("all");
  const [bulkType, setBulkType] = useState<EqType>("poco");
  const [bulkCv, setBulkCv] = useState<string>("");
  const [bulkFlow, setBulkFlow] = useState<string>("");

  const load = useCallback(async () => {
    if (!farmId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("equipments")
      .select("id, name, type, power_cv, power_kw, estimated_flow_m3h")
      .eq("farm_id", farmId)
      .in("type", ["poco", "bombeamento"] as never)
      .order("type", { ascending: true })
      .order("name", { ascending: true });
    if (error) {
      toast.error("Falha ao carregar equipamentos");
      setLoading(false);
      return;
    }
    const mapped: Row[] = ((data as never as Array<{
      id: string;
      name: string;
      type: EqType;
      power_cv: number | null;
      power_kw: number | null;
      estimated_flow_m3h: number | null;
    }>) ?? []).map((e) => {
      // se power_cv estiver vazio mas power_kw existir, deriva CV pra exibir.
      const cv = e.power_cv != null
        ? Number(e.power_cv)
        : e.power_kw != null
          ? Number(e.power_kw) / CV_TO_KW
          : 0;
      return {
        id: e.id,
        name: e.name,
        type: e.type,
        power_cv: cv ? cv.toFixed(0) : "",
        estimated_flow_m3h: e.estimated_flow_m3h != null ? Number(e.estimated_flow_m3h).toString() : "",
      };
    });
    setRows(mapped);
    setLoading(false);
  }, [farmId]);

  useEffect(() => { void load(); }, [load]);

  const updateRow = (id: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch, dirty: true } : r)));
  };

  const filtered = useMemo(
    () => rows.filter((r) => filter === "all" || r.type === filter),
    [rows, filter],
  );

  const totals = useMemo(() => {
    let cv = 0, kw = 0, flow = 0;
    for (const r of filtered) {
      const c = Number(r.power_cv) || 0;
      cv += c;
      kw += c * CV_TO_KW;
      flow += Number(r.estimated_flow_m3h) || 0;
    }
    return { cv, kw, flow };
  }, [filtered]);

  const dirtyCount = rows.filter((r) => r.dirty).length;

  const handleApplyBulk = () => {
    if (!canEdit) return;
    const cvNum = bulkCv === "" ? null : Number(bulkCv);
    const flowNum = bulkFlow === "" ? null : Number(bulkFlow);
    if (cvNum == null && flowNum == null) {
      toast.info("Informe ao menos um valor (CV ou m³/h)");
      return;
    }
    let count = 0;
    setRows((prev) =>
      prev.map((r) => {
        if (r.type !== bulkType) return r;
        count += 1;
        return {
          ...r,
          power_cv: cvNum != null ? String(cvNum) : r.power_cv,
          estimated_flow_m3h: flowNum != null ? String(flowNum) : r.estimated_flow_m3h,
          dirty: true,
        };
      }),
    );
    toast.success(`Aplicado em ${count} equipamento(s) do tipo ${bulkType}`);
  };

  const handleSave = async () => {
    if (!canEdit) return;
    const dirty = rows.filter((r) => r.dirty);
    if (dirty.length === 0) {
      toast.info("Nada para salvar");
      return;
    }
    setSaving(true);
    try {
      for (const r of dirty) {
        const cvNum = r.power_cv === "" ? null : Number(r.power_cv);
        const flowNum = r.estimated_flow_m3h === "" ? null : Number(r.estimated_flow_m3h);
        const kwNum = cvNum != null ? Number((cvNum * CV_TO_KW).toFixed(2)) : null;
        const { error } = await supabase
          .from("equipments")
          .update({
            power_cv: cvNum,
            power_kw: kwNum,
            estimated_flow_m3h: flowNum,
          } as never)
          .eq("id", r.id);
        if (error) throw error;
      }
      toast.success(`${dirty.length} equipamento(s) atualizado(s)`);
      await load();
    } catch (e) {
      toast.error(`Erro ao salvar: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  if (!farmId) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="p-6 text-sm text-muted-foreground">Carregando fazenda…</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-3 flex-row items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-primary" />
            Configuração de Potência e Vazão
          </CardTitle>
          <div className="flex items-center gap-2">
            {!canEdit && (
              <Badge variant="outline" className="text-[11px] gap-1">
                <Lock className="w-3 h-3" /> Somente leitura
              </Badge>
            )}
            <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
              <SelectTrigger className="h-8 w-[160px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os tipos</SelectItem>
                <SelectItem value="poco">Só poços</SelectItem>
                <SelectItem value="bombeamento">Só bombeamento</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              Nenhum equipamento encontrado.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Equipamento</TableHead>
                    <TableHead className="w-[120px]">Tipo</TableHead>
                    <TableHead className="w-[120px]">Potência (CV)</TableHead>
                    <TableHead className="w-[140px]">Potência (kW)</TableHead>
                    <TableHead className="w-[140px]">Vazão (m³/h)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => {
                    const cvNum = Number(r.power_cv) || 0;
                    const kw = cvNum * CV_TO_KW;
                    return (
                      <TableRow key={r.id} className={r.dirty ? "bg-warning/5" : undefined}>
                        <TableCell className="font-medium">{r.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px] capitalize">
                            {r.type}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            value={r.power_cv}
                            onChange={(e) => updateRow(r.id, { power_cv: e.target.value })}
                            disabled={!canEdit}
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {kw > 0 ? `${kw.toFixed(2)} kW` : "—"}
                          <span className="ml-1 text-[10px] opacity-60">(auto)</span>
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            value={r.estimated_flow_m3h}
                            onChange={(e) => updateRow(r.id, { estimated_flow_m3h: e.target.value })}
                            disabled={!canEdit}
                            className="h-8"
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell className="font-semibold">TOTAIS ({filtered.length} equip.)</TableCell>
                    <TableCell />
                    <TableCell className="font-semibold">{totals.cv.toLocaleString("pt-BR")} CV</TableCell>
                    <TableCell className="font-semibold">{totals.kw.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} kW</TableCell>
                    <TableCell className="font-semibold">{totals.flow.toLocaleString("pt-BR")} m³/h</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          )}

          {canEdit && (
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
              <Button onClick={handleSave} disabled={saving || dirtyCount === 0} size="sm">
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Save className="w-4 h-4 mr-1" />}
                Salvar alterações {dirtyCount > 0 && `(${dirtyCount})`}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {canEdit && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-info" />
              Aplicar mesmo valor para todos do tipo
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Tipo</label>
                <Select value={bulkType} onValueChange={(v) => setBulkType(v as EqType)}>
                  <SelectTrigger className="h-9 w-[160px] text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="poco">Poços</SelectItem>
                    <SelectItem value="bombeamento">Bombeamento</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Potência (CV)</label>
                <Input
                  type="number"
                  min={0}
                  value={bulkCv}
                  onChange={(e) => setBulkCv(e.target.value)}
                  placeholder="ex: 180"
                  className="h-9 w-[140px]"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Vazão (m³/h)</label>
                <Input
                  type="number"
                  min={0}
                  value={bulkFlow}
                  onChange={(e) => setBulkFlow(e.target.value)}
                  placeholder="ex: 450"
                  className="h-9 w-[140px]"
                />
              </div>
              <Button variant="secondary" size="sm" onClick={handleApplyBulk}>
                <Wand2 className="w-4 h-4 mr-1" />
                Aplicar a todos
              </Button>
              <p className="text-xs text-muted-foreground basis-full">
                Os campos vazios são ignorados. As alterações ainda precisam ser salvas.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
