// Setor Técnico — aba MANUTENÇÃO (escopada na fazenda ativa).
// Gerencia maintenance_orders: criar, iniciar, concluir. O badge azul no
// dashboard (PumpCard) é automático enquanto houver ordem aberta (MaintenanceContext).
// Permissões: admin/owner (canEditConfig) criam/editam/concluem; operador só vê.
// Alertas: ordem aberta há > 7 dias = amarelo; > 15 dias = vermelho.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Wrench, Plus, CheckCircle2, RefreshCw, Filter, Lock, AlertTriangle } from "lucide-react";
import { notify } from "@/lib/notify";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useFarmAccess } from "@/hooks/useFarmAccess";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";
import {
  PROBLEM_TYPES, PRIORITY_LABEL, STATUS_LABEL, problemLabel, defaultPriorityFor,
  type MaintenanceOrder, type MaintenancePriority, type MaintenanceStatus,
} from "@/lib/maintenanceTypes";

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

const DAY_MS = 24 * 60 * 60 * 1000;
// Dias que uma ordem ABERTA está pendente (0 se concluída).
function daysOpen(o: MaintenanceOrder): number {
  if (o.status === "concluido") return 0;
  return Math.floor((Date.now() - new Date(o.created_at).getTime()) / DAY_MS);
}

export default function MaintenanceTab() {
  const farmId = useDefaultFarmId();
  const { canEditConfig } = useFarmAccess();
  const { isPlatformAdmin } = usePlatformAdmin();
  const canEdit = canEditConfig || isPlatformAdmin; // admin/owner criam/editam; operador só vê

  const [orders, setOrders] = useState<MaintenanceOrder[]>([]);
  const [equips, setEquips] = useState<Equip[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Filtros
  const [fStatus, setFStatus] = useState<string>("open"); // open = aberto+andamento
  const [fPriority, setFPriority] = useState<string>("all");
  const [fType, setFType] = useState<string>("all");

  // Form de criação
  const [newEquip, setNewEquip] = useState<string>("");
  const [newType, setNewType] = useState<string>("nivel_zerado");
  const [newDesc, setNewDesc] = useState<string>("");
  const [newPriority, setNewPriority] = useState<MaintenancePriority>("alta");
  const [creating, setCreating] = useState(false);

  const loadOrders = useCallback(async () => {
    if (!farmId) { setOrders([]); setLoading(false); return; }
    setLoading(true);
    let q = supabase.from("maintenance_orders").select("*").eq("farm_id", farmId).order("created_at", { ascending: false });
    if (fPriority !== "all") q = q.eq("priority", fPriority);
    if (fType !== "all") q = q.eq("problem_type", fType);
    if (fStatus === "open") q = q.neq("status", "concluido");
    else if (fStatus !== "all") q = q.eq("status", fStatus);
    const { data } = await q;
    setOrders((data ?? []) as MaintenanceOrder[]);
    setLoading(false);
  }, [farmId, fStatus, fPriority, fType]);

  useEffect(() => { void loadOrders(); }, [loadOrders]);

  // Equipamentos da fazenda ativa (para o form).
  useEffect(() => {
    if (!farmId) { setEquips([]); return; }
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("equipments").select("id, name, type").eq("farm_id", farmId).eq("active", true).order("name");
      if (cancelled) return;
      setEquips((data ?? []) as Equip[]);
    })();
    return () => { cancelled = true; };
  }, [farmId]);

  // Prioridade default segue o tipo (nível zerado = ALTA), mas o usuário pode mudar.
  useEffect(() => { setNewPriority(defaultPriorityFor(newType)); }, [newType]);

  const create = async () => {
    if (!farmId || !newType) { notify.fail("Manutenção", "Selecione o tipo de problema."); return; }
    setCreating(true);
    const { data: userRes } = await supabase.auth.getUser();
    const eq = equips.find((e) => e.id === newEquip);
    const { error } = await supabase.from("maintenance_orders").insert({
      farm_id: farmId,
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
  const overdue7 = useMemo(() => orders.filter((o) => o.status !== "concluido" && daysOpen(o) > 7 && daysOpen(o) <= 15).length, [orders]);
  const overdue15 = useMemo(() => orders.filter((o) => o.status !== "concluido" && daysOpen(o) > 15).length, [orders]);

  return (
    <div className="space-y-4">
      {/* Banner de alertas (pendências antigas) */}
      {(overdue15 > 0 || overdue7 > 0) && (
        <div className="flex flex-col sm:flex-row gap-2">
          {overdue15 > 0 && (
            <div className="flex-1 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span><strong>{overdue15}</strong> manutenção(ões) pendente(s) há mais de <strong>15 dias</strong>.</span>
            </div>
          )}
          {overdue7 > 0 && (
            <div className="flex-1 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span><strong>{overdue7}</strong> manutenção(ões) pendente(s) há mais de <strong>7 dias</strong>.</span>
            </div>
          )}
        </div>
      )}

      {/* Criar ordem — só admin/owner */}
      {canEdit ? (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Wrench className="w-4 h-4 text-info" /> Adicionar manutenção
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Equipamento</label>
                <Select value={newEquip} onValueChange={setNewEquip}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione (opcional)" /></SelectTrigger>
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
              <Button onClick={create} disabled={creating || !farmId}>
                <Plus className="w-4 h-4 mr-1.5" /> {creating ? "Registrando…" : "Adicionar Manutenção"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Lock className="w-3.5 h-3.5" /> Somente leitura — apenas administradores podem adicionar ou concluir manutenções.
        </div>
      )}

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
            <Select value={fStatus} onValueChange={setFStatus}>
              <SelectTrigger className="h-8 w-full sm:w-[160px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Abertas + andamento</SelectItem>
                <SelectItem value="aberto">Pendente</SelectItem>
                <SelectItem value="em_andamento">Em andamento</SelectItem>
                <SelectItem value="concluido">Concluída</SelectItem>
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
            <Table className="md:text-xs md:[&_th]:px-2 md:[&_th]:h-9 md:[&_td]:px-2 md:[&_td]:py-1.5">
              <TableHeader>
                <TableRow>
                  <TableHead>Equipamento</TableHead>
                  <TableHead>Problema</TableHead>
                  <TableHead>Prioridade</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Aberta em</TableHead>
                  <TableHead>Pendência</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.length === 0 && !loading && (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground text-sm">Nenhuma ordem de manutenção.</TableCell></TableRow>
                )}
                {orders.map((o) => {
                  const d = daysOpen(o);
                  const overdue = o.status !== "concluido" && d > 7;
                  return (
                    <TableRow key={o.id}>
                      <TableCell className="text-xs font-medium">{o.equipment_name ?? "—"}</TableCell>
                      <TableCell className="text-xs">
                        {problemLabel(o.problem_type)}
                        {o.description && <span className="block text-[10px] text-muted-foreground">{o.description}</span>}
                      </TableCell>
                      <TableCell><Badge variant="outline" className={PRIORITY_BADGE[o.priority]}>{PRIORITY_LABEL[o.priority]}</Badge></TableCell>
                      <TableCell><Badge variant="outline" className={STATUS_BADGE[o.status]}>{STATUS_LABEL[o.status]}</Badge></TableCell>
                      <TableCell className="text-[11px] text-muted-foreground whitespace-nowrap">
                        {new Date(o.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {o.status === "concluido" ? (
                          <span className="text-[11px] text-muted-foreground">—</span>
                        ) : overdue ? (
                          <Badge variant="outline" className={d > 15 ? "bg-destructive/15 text-destructive border-destructive/40" : "bg-warning/15 text-warning border-warning/40"}>
                            <AlertTriangle className="w-3 h-3 mr-1" /> há {d} dias
                          </Badge>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">há {d} {d === 1 ? "dia" : "dias"}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {o.status !== "concluido" ? (
                          canEdit ? (
                            <div className="flex gap-1 justify-end">
                              {o.status === "aberto" && (
                                <Button size="sm" variant="outline" disabled={busyId === o.id} onClick={() => void setStatus(o, "em_andamento")}>Iniciar</Button>
                              )}
                              <Button size="sm" disabled={busyId === o.id} onClick={() => void setStatus(o, "concluido")}>
                                <CheckCircle2 className="w-4 h-4 mr-1" /> Concluir
                              </Button>
                            </div>
                          ) : (
                            <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Lock className="w-3 h-3" /> —</span>
                          )
                        ) : (
                          <span className="text-[11px] text-muted-foreground">
                            {o.completed_at ? `✓ ${new Date(o.completed_at).toLocaleDateString("pt-BR")}` : "✓"}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
