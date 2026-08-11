// Setor Técnico — ordens de manutenção de equipamentos.
// Cria/lista/filtra/conclui ordens. O badge no dashboard é automático enquanto
// houver ordem aberta (ver MaintenanceContext). Não bloqueia a operação.
import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { notify } from "@/lib/notify";
import { Wrench, Plus, CheckCircle2, RefreshCw, Filter } from "lucide-react";
import OutorgaWellLinks from "@/components/inema/OutorgaWellLinks";
import {
  PROBLEM_TYPES, PRIORITY_LABEL, STATUS_LABEL, problemLabel, defaultPriorityFor,
  type MaintenanceOrder, type MaintenancePriority, type MaintenanceStatus,
} from "@/lib/maintenanceTypes";

interface Farm { id: string; name: string }
interface Equip { id: string; name: string; type: string | null }

const PRIORITY_BADGE: Record<MaintenancePriority, string> = {
  alta: "bg-destructive/20 text-destructive border-destructive/40",
  media: "bg-warning/20 text-warning border-warning/40",
  baixa: "bg-muted text-muted-foreground border-border",
};
const STATUS_BADGE: Record<MaintenanceStatus, string> = {
  aberto: "bg-destructive/15 text-destructive border-destructive/40",
  em_andamento: "bg-warning/15 text-warning border-warning/40",
  concluido: "bg-primary/15 text-primary border-primary/40",
};

export default function PlatformTecnico({ isAdmin: _isAdmin }: { isAdmin: boolean }) {
  const [farms, setFarms] = useState<Farm[]>([]);
  const [orders, setOrders] = useState<MaintenanceOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Filtros
  const [fFarm, setFFarm] = useState<string>("all");
  const [fStatus, setFStatus] = useState<string>("open"); // open = aberto+andamento
  const [fPriority, setFPriority] = useState<string>("all");
  const [fType, setFType] = useState<string>("all");

  // Form de criação
  const [newFarm, setNewFarm] = useState<string>("");
  const [equips, setEquips] = useState<Equip[]>([]);
  const [newEquip, setNewEquip] = useState<string>("");
  const [newType, setNewType] = useState<string>("nivel_zerado");
  const [newDesc, setNewDesc] = useState<string>("");
  const [newPriority, setNewPriority] = useState<MaintenancePriority>("alta");
  const [creating, setCreating] = useState(false);

  const loadFarms = useCallback(async () => {
    const { data } = await supabase.from("farms").select("id, name").order("name");
    setFarms(((data ?? []) as any[]).filter((f) => f?.id && f?.name));
  }, []);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    let q = supabase.from("maintenance_orders").select("*").order("created_at", { ascending: false });
    if (fFarm !== "all") q = q.eq("farm_id", fFarm);
    if (fPriority !== "all") q = q.eq("priority", fPriority);
    if (fType !== "all") q = q.eq("problem_type", fType);
    if (fStatus === "open") q = q.neq("status", "concluido");
    else if (fStatus !== "all") q = q.eq("status", fStatus);
    const { data } = await q;
    setOrders((data ?? []) as MaintenanceOrder[]);
    setLoading(false);
  }, [fFarm, fStatus, fPriority, fType]);

  useEffect(() => { void loadFarms(); }, [loadFarms]);
  useEffect(() => { void loadOrders(); }, [loadOrders]);

  // Equipamentos da fazenda selecionada no form.
  useEffect(() => {
    if (!newFarm) { setEquips([]); setNewEquip(""); return; }
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("equipments").select("id, name, type").eq("farm_id", newFarm).eq("active", true).order("name");
      if (cancelled) return;
      setEquips((data ?? []) as Equip[]);
    })();
    return () => { cancelled = true; };
  }, [newFarm]);

  // Prioridade default segue o tipo (nível zerado = ALTA), mas o usuário pode mudar.
  useEffect(() => { setNewPriority(defaultPriorityFor(newType)); }, [newType]);

  const farmName = (id: string) => farms.find((f) => f.id === id)?.name ?? "—";

  const create = async () => {
    if (!newFarm || !newType) { notify.fail("Manutenção", "Selecione fazenda e tipo de problema."); return; }
    setCreating(true);
    const { data: userRes } = await supabase.auth.getUser();
    const eq = equips.find((e) => e.id === newEquip);
    const { error } = await supabase.from("maintenance_orders").insert({
      farm_id: newFarm,
      equipment_id: newEquip || null,
      equipment_name: eq?.name ?? null,
      problem_type: newType,
      description: newDesc.trim() || null,
      priority: newPriority,
      status: "aberto",
      created_by: userRes?.user?.id ?? null,
      created_by_name: userRes?.user?.email ?? null,
    } as any);
    setCreating(false);
    if (error) { notify.fail("Manutenção", "Não foi possível registrar a ordem."); return; }
    notify.ok("Manutenção", `Ordem registrada: ${eq?.name ?? "equipamento"} — ${problemLabel(newType)}.`);
    setNewEquip(""); setNewDesc("");
    void loadOrders();
  };

  const setStatus = async (o: MaintenanceOrder, status: MaintenanceStatus) => {
    setBusyId(o.id);
    const { data: userRes } = await supabase.auth.getUser();
    const patch: any = { status, updated_at: new Date().toISOString() };
    if (status === "concluido") { patch.completed_at = new Date().toISOString(); patch.completed_by = userRes?.user?.id ?? null; }
    const { error } = await supabase.from("maintenance_orders").update(patch).eq("id", o.id);
    setBusyId(null);
    if (error) { notify.fail("Manutenção", "Falha ao atualizar a ordem."); return; }
    void loadOrders();
  };

  const openCount = useMemo(() => orders.filter((o) => o.status !== "concluido").length, [orders]);

  return (
    <div className="space-y-4">
      {/* Criar ordem */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Wrench className="w-4 h-4 text-primary" /> Nova ordem de manutenção
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Fazenda</label>
              <Select value={newFarm} onValueChange={setNewFarm}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione a fazenda" /></SelectTrigger>
                <SelectContent>
                  {farms.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Equipamento</label>
              <Select value={newEquip} onValueChange={setNewEquip} disabled={!newFarm}>
                <SelectTrigger className="mt-1"><SelectValue placeholder={newFarm ? "Selecione (opcional)" : "Escolha a fazenda"} /></SelectTrigger>
                <SelectContent>
                  {equips.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Tipo de problema</label>
              <Select value={newType} onValueChange={setNewType}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROBLEM_TYPES.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Prioridade</label>
              <Select value={newPriority} onValueChange={(v) => setNewPriority(v as MaintenancePriority)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="alta">Alta</SelectItem>
                  <SelectItem value="media">Média</SelectItem>
                  <SelectItem value="baixa">Baixa</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <label className="text-xs text-muted-foreground">Descrição</label>
              <Textarea className="mt-1" rows={2} value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Detalhe o problema (opcional)" />
            </div>
          </div>
          <div className="mt-3">
            <Button onClick={create} disabled={creating || !newFarm}>
              <Plus className="w-4 h-4 mr-1.5" /> {creating ? "Registrando…" : "Registrar manutenção"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Lista + filtros */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span className="flex items-center gap-2"><Filter className="w-4 h-4 text-primary" /> Ordens ({openCount} abertas)</span>
            <Button variant="outline" size="sm" onClick={() => void loadOrders()} disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Atualizar
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 mb-3">
            <Select value={fFarm} onValueChange={setFFarm}>
              <SelectTrigger className="h-8 w-full sm:w-[180px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as fazendas</SelectItem>
                {farms.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={fStatus} onValueChange={setFStatus}>
              <SelectTrigger className="h-8 w-full sm:w-[150px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Abertas + andamento</SelectItem>
                <SelectItem value="aberto">Aberto</SelectItem>
                <SelectItem value="em_andamento">Em andamento</SelectItem>
                <SelectItem value="concluido">Concluído</SelectItem>
                <SelectItem value="all">Todos os status</SelectItem>
              </SelectContent>
            </Select>
            <Select value={fPriority} onValueChange={setFPriority}>
              <SelectTrigger className="h-8 w-full sm:w-[130px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Toda prioridade</SelectItem>
                <SelectItem value="alta">Alta</SelectItem>
                <SelectItem value="media">Média</SelectItem>
                <SelectItem value="baixa">Baixa</SelectItem>
              </SelectContent>
            </Select>
            <Select value={fType} onValueChange={setFType}>
              <SelectTrigger className="h-8 w-full sm:w-[170px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todo tipo</SelectItem>
                {PROBLEM_TYPES.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <p className="text-[10px] text-muted-foreground mb-1 sm:hidden">← deslize para ver todas as colunas →</p>
          <div className="overflow-x-auto -mx-2 px-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fazenda</TableHead>
                  <TableHead>Equipamento</TableHead>
                  <TableHead>Problema</TableHead>
                  <TableHead>Prioridade</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Aberta em</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.length === 0 && !loading && (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground text-sm">Nenhuma ordem.</TableCell></TableRow>
                )}
                {orders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="text-xs">{farmName(o.farm_id)}</TableCell>
                    <TableCell className="text-xs font-medium">{o.equipment_name ?? "—"}</TableCell>
                    <TableCell className="text-xs">
                      {problemLabel(o.problem_type)}
                      {o.description && <span className="block text-[10px] text-muted-foreground">{o.description}</span>}
                    </TableCell>
                    <TableCell><Badge variant="outline" className={PRIORITY_BADGE[o.priority]}>{PRIORITY_LABEL[o.priority]}</Badge></TableCell>
                    <TableCell><Badge variant="outline" className={STATUS_BADGE[o.status]}>{STATUS_LABEL[o.status]}</Badge></TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">
                      {new Date(o.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {o.status !== "concluido" ? (
                        <div className="flex gap-1 justify-end">
                          {o.status === "aberto" && (
                            <Button size="sm" variant="outline" disabled={busyId === o.id} onClick={() => void setStatus(o, "em_andamento")}>Iniciar</Button>
                          )}
                          <Button size="sm" disabled={busyId === o.id} onClick={() => void setStatus(o, "concluido")}>
                            <CheckCircle2 className="w-4 h-4 mr-1" /> Concluir
                          </Button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">
                          {o.completed_at ? new Date(o.completed_at).toLocaleDateString("pt-BR") : "✓"}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Vínculos de Outorga (poço ↔ equipamento) — edição restrita ao Setor Técnico */}
      <OutorgaWellLinks />
    </div>
  );
}
