// Setor Técnico — Vínculos de Outorga: liga cada poço das portarias (water_permit_
// wells) a um equipamento físico do sistema (equipment_id). SÓ aqui o vínculo é
// editável; a aba Outorgas (Relatórios) mostra apenas leitura. RLS: o UPDATE em
// water_permit_wells exige platform_admin.
import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { notify } from "@/lib/notify";
import { Link2, RefreshCw } from "lucide-react";

interface Farm { id: string; name: string }
interface Equip { id: string; name: string }
interface Well {
  id: string; permit_id: string; well_name: string; flow_rate_m3_day: number; equipment_id: string | null;
  permit_number: string;
}

export default function OutorgaWellLinks() {
  const [farms, setFarms] = useState<Farm[]>([]);
  const [farmId, setFarmId] = useState<string>("");
  const [equips, setEquips] = useState<Equip[]>([]);
  const [wells, setWells] = useState<Well[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    void supabase.from("farms").select("id, name").order("name").then(({ data }) => {
      const list = ((data ?? []) as any[]).filter((f) => f?.id && f?.name);
      setFarms(list);
      if (!farmId && list.length) setFarmId(list[0].id);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!farmId) { setWells([]); setEquips([]); return; }
    setLoading(true);
    const [{ data: permitRows }, { data: eqRows }] = await Promise.all([
      supabase.from("water_permits" as any).select("id, permit_number").eq("farm_id", farmId),
      supabase.from("equipments").select("id, name").eq("farm_id", farmId).eq("active", true).eq("type", "poco").order("name"),
    ]);
    setEquips((eqRows ?? []) as Equip[]);
    const permits = (permitRows ?? []) as Array<{ id: string; permit_number: string }>;
    const numById = new Map(permits.map((p) => [p.id, p.permit_number]));
    if (permits.length === 0) { setWells([]); setLoading(false); return; }
    const { data: wellRows } = await supabase
      .from("water_permit_wells" as any)
      .select("id, permit_id, well_name, flow_rate_m3_day, equipment_id")
      .in("permit_id", permits.map((p) => p.id));
    setWells(((wellRows ?? []) as any[]).map((w) => ({ ...w, permit_number: numById.get(w.permit_id) ?? "?" })));
    setLoading(false);
  }, [farmId]);

  useEffect(() => { void load(); }, [load]);

  const link = async (wellId: string, equipmentId: string) => {
    const eqId = equipmentId === "none" ? null : equipmentId;
    setBusyId(wellId);
    setWells((prev) => prev.map((w) => (w.id === wellId ? { ...w, equipment_id: eqId } : w)));
    const { error } = await supabase.from("water_permit_wells" as any).update({ equipment_id: eqId }).eq("id", wellId);
    setBusyId(null);
    if (error) { notify.fail("Vínculo", "Falha ao salvar (apenas Setor Técnico/admin pode)."); void load(); }
    else notify.ok("Vínculo", eqId ? "Poço vinculado." : "Vínculo removido.");
  };

  const sorted = useMemo(
    () => wells.slice().sort((a, b) => a.permit_number.localeCompare(b.permit_number) || a.well_name.localeCompare(b.well_name)),
    [wells],
  );

  // Número do poço a partir do nome ("Poço 7"→"7"; "POÇO 07 R1"→"7").
  const pocoNum = (s: string): string | null => {
    const m = String(s).match(/po[çc]o\s*0*([0-9]+)/i);
    return m ? m[1] : null;
  };
  // Auto-vínculo: para cada poço sem vínculo, casa por número; 1 match → vincula.
  const autoLink = async () => {
    let linked = 0, skipped = 0;
    for (const w of wells) {
      if (w.equipment_id) continue;
      const wn = pocoNum(w.well_name);
      if (!wn) { skipped++; continue; }
      const matches = equips.filter((e) => pocoNum(e.name) === wn);
      if (matches.length === 1) { await link(w.id, matches[0].id); linked++; }
      else skipped++;
    }
    notify.ok("Vínculos", `${linked} vinculado(s) automaticamente · ${skipped} sem match único (manual).`);
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-base flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <span className="flex items-center gap-2"><Link2 className="w-4 h-4 text-primary" /> Vínculos de Outorga (poço ↔ equipamento)</span>
          <div className="flex items-center flex-wrap gap-2">
            <Select value={farmId} onValueChange={setFarmId}>
              <SelectTrigger className="h-8 w-full sm:w-[180px] text-xs"><SelectValue placeholder="Fazenda" /></SelectTrigger>
              <SelectContent>{farms.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}</SelectContent>
            </Select>
            <button type="button" className="text-xs text-primary flex items-center gap-1 font-medium" onClick={() => void autoLink()} disabled={loading || wells.length === 0}>
              <Link2 className="w-3.5 h-3.5" /> Vincular automaticamente
            </button>
            <button type="button" className="text-xs text-muted-foreground flex items-center gap-1" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Atualizar
            </button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-2">
          Vincule cada poço das portarias ao equipamento físico correspondente. Isso alimenta o
          comparativo autorizado × captado do relatório. Só o Setor Técnico edita.
        </p>
        <p className="text-[10px] text-muted-foreground mb-1 sm:hidden">← deslize para ver todas as colunas →</p>
        <div className="overflow-x-auto -mx-2 px-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Portaria</TableHead>
                <TableHead>Poço (outorga)</TableHead>
                <TableHead className="text-right">Vazão (m³/dia)</TableHead>
                <TableHead>Equipamento físico</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="text-xs">{w.permit_number}</TableCell>
                  <TableCell className="text-xs font-medium">{w.well_name}</TableCell>
                  <TableCell className="text-right text-xs">{Number(w.flow_rate_m3_day).toLocaleString("pt-BR")}</TableCell>
                  <TableCell>
                    <Select value={w.equipment_id ?? "none"} onValueChange={(v) => void link(w.id, v)} disabled={busyId === w.id}>
                      <SelectTrigger className="h-7 w-[180px] text-xs"><SelectValue placeholder="Vincular…" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">— não vinculado —</SelectItem>
                        {equips.map((eq) => <SelectItem key={eq.id} value={eq.id}>{eq.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              ))}
              {sorted.length === 0 && !loading && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground text-xs">Nenhum poço de outorga nesta fazenda.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
