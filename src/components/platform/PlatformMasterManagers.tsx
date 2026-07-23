import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { notify } from "@/lib/notify";
import {
  Crown, RefreshCw, Search, Plus, KeyRound, Trash2, Copy, Loader2, Eye, X,
} from "lucide-react";

// --- helpers ---
const onlyDigits = (s: string) => (s ?? "").replace(/\D/g, "");
function maskCpf(v: string) {
  const d = onlyDigits(v).slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1-$2");
}
function maskPhone(v: string) {
  const d = onlyDigits(v).slice(0, 11);
  if (d.length <= 10) return d.replace(/^(\d{2})(\d{4})(\d)/, "($1) $2-$3");
  return d.replace(/^(\d{2})(\d{5})(\d)/, "($1) $2-$3");
}
function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

interface ManagerRow {
  id: string;
  user_id: string;
  full_name: string;
  cpf: string;
  email: string;
  whatsapp: string;
  status: "active" | "inactive";
  farms_count: number;
  created_at: string;
}
interface Farm { farm_id: string; name: string; }

interface Permissions {
  can_view_dashboard: boolean;
  can_view_reports: boolean;
  can_command_pumps: boolean;
  can_edit_schedules: boolean;
  can_manage_maintenance: boolean;
  can_view_financial: boolean;
  can_view_indicators: boolean;
  can_manage_operational_users: boolean;
}
const DEFAULT_PERMS: Permissions = {
  can_view_dashboard: true,
  can_view_reports: true,
  can_command_pumps: true,
  can_edit_schedules: true,
  can_manage_maintenance: true,
  can_view_financial: false,
  can_view_indicators: false,
  can_manage_operational_users: true,
};
const PERM_LABELS: Array<{ key: keyof Permissions; label: string; desc: string }> = [
  { key: "can_view_dashboard", label: "Visualizar Dashboard", desc: "Acesso ao painel principal com status das bombas" },
  { key: "can_view_indicators", label: "Visualizar Indicadores (ROI/Eficiência)", desc: "Aba de indicadores: ROI, economia, captação, score" },
  { key: "can_view_reports", label: "Visualizar Relatórios", desc: "Histórico e performance" },
  { key: "can_command_pumps", label: "Ligar/Desligar Bombas", desc: "Comandos remotos aos equipamentos" },
  { key: "can_edit_schedules", label: "Alterar Programação de Horários", desc: "Modificar regras de automação" },
  { key: "can_manage_maintenance", label: "Gerenciar Manutenções", desc: "Bloquear/desbloquear equipamentos" },
  { key: "can_view_financial", label: "Visualizar Dados Financeiros", desc: "Faturamento, ROI, economia" },
  { key: "can_manage_operational_users", label: "Cadastrar Usuários Operacionais", desc: "Supervisor/Operador nas fazendas vinculadas" },
];

export default function PlatformMasterManagers({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<ManagerRow[]>([]);
  const [farms, setFarms] = useState<Farm[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [openDialog, setOpenDialog] = useState(false);
  const [editing, setEditing] = useState<ManagerRow | null>(null);
  const [provisionalPassword, setProvisionalPassword] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    const [managersRes, farmsRes] = await Promise.all([
      supabase.rpc("master_managers_overview" as any),
      supabase.rpc("platform_farms_overview" as any),
    ]);
    if (managersRes.error) notify.fail("Gestores Master", managersRes.error.message);
    else setRows((managersRes.data as any) ?? []);
    if (!farmsRes.error) setFarms(((farmsRes.data as any) ?? []).map((f: any) => ({ farm_id: f.farm_id, name: f.name })));
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.full_name.toLowerCase().includes(q) ||
      r.email.toLowerCase().includes(q) ||
      r.cpf.includes(onlyDigits(q))
    );
  }, [rows, search]);

  const handleNew = () => { setEditing(null); setOpenDialog(true); };
  const handleEdit = (m: ManagerRow) => { setEditing(m); setOpenDialog(true); };

  const handleDelete = async (m: ManagerRow) => {
    if (!confirm(`Excluir Gestor Master "${m.full_name}"? Isto remove o acesso e apaga o cadastro.`)) return;
    // remove auth user via edge fn (cascade limpa master_managers e vínculos)
    const { data, error } = await supabase.functions.invoke("platform-user-admin", {
      body: { action: "delete", user_id: m.user_id },
    });
    if (error || !(data as any)?.ok) {
      notify.fail("Gestores Master", (data as any)?.error ?? error?.message ?? "Falha ao excluir");
      return;
    }
    notify.ok("Gestores Master", "Excluído.");
    void refresh();
  };

  const handleResetPassword = async (m: ManagerRow) => {
    if (!confirm(`Resetar senha de "${m.full_name}"?`)) return;
    const { data, error } = await supabase.functions.invoke("platform-user-admin", {
      body: { action: "reset_password", user_id: m.user_id },
    });
    if (error || !(data as any)?.ok) {
      notify.fail("Gestores Master", (data as any)?.error ?? error?.message ?? "Falha");
      return;
    }
    // Força troca de senha no próximo login
    await supabase
      .from("master_managers" as any)
      .update({ must_change_password: true })
      .eq("id", m.id);
    setProvisionalPassword((data as any).new_password);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-base flex items-center gap-2">
              <Crown className="w-4 h-4 text-primary" />
              Gestores Master
              <Badge variant="secondary" className="text-[10px]">{rows.length}</Badge>
            </CardTitle>
            <div className="flex gap-2 items-center flex-wrap">
              <div className="relative w-full sm:w-72">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input placeholder="Buscar por nome, e-mail ou CPF…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
              </div>
              <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
                <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Atualizar
              </Button>
              {isAdmin && (
                <Button size="sm" onClick={handleNew}>
                  <Plus className="w-4 h-4 mr-1.5" /> Novo Gestor Master
                </Button>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Perfil de alto nível para donos de grupo ou gestores gerais com acesso a múltiplas fazendas.
            Todas as ações são registradas em auditoria.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>CPF</TableHead>
                  <TableHead>E-mail</TableHead>
                  <TableHead>WhatsApp</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="text-center">Fazendas</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    {loading ? "Carregando…" : "Nenhum gestor cadastrado."}
                  </TableCell></TableRow>
                )}
                {filtered.map(m => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">{m.full_name}</TableCell>
                    <TableCell className="font-mono text-xs">{maskCpf(m.cpf)}</TableCell>
                    <TableCell className="text-sm">{m.email}</TableCell>
                    <TableCell className="text-sm">{maskPhone(m.whatsapp)}</TableCell>
                    <TableCell className="text-center">
                      <Badge variant={m.status === "active" ? "default" : "secondary"}>
                        {m.status === "active" ? "Ativo" : "Inativo"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="outline">{m.farms_count}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {isAdmin && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => handleEdit(m)} title="Editar">
                            <Eye className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleResetPassword(m)} title="Resetar senha">
                            <KeyRound className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleDelete(m)} title="Excluir">
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {openDialog && (
        <MasterManagerDialog
          open={openDialog}
          onOpenChange={setOpenDialog}
          editing={editing}
          farms={farms}
          onSaved={(pwd) => {
            setOpenDialog(false);
            if (pwd) setProvisionalPassword(pwd);
            void refresh();
          }}
        />
      )}

      {provisionalPassword && (
        <Dialog open onOpenChange={() => setProvisionalPassword(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Senha provisória</DialogTitle>
              <DialogDescription>Copie agora — ela não será exibida novamente.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 p-3 bg-muted rounded font-mono text-sm">
              <span className="flex-1 select-all">{provisionalPassword}</span>
              <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(provisionalPassword); notify.ok("Gestores Master", "Senha copiada."); }}>
                <Copy className="w-4 h-4" />
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => setProvisionalPassword(null)}>Fechar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ============ Dialog ============
function MasterManagerDialog({
  open, onOpenChange, editing, farms, onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: ManagerRow | null;
  farms: Farm[];
  onSaved: (provisionalPassword?: string) => void;
}) {
  const isEdit = !!editing;
  const [saving, setSaving] = useState(false);
  const [fullName, setFullName] = useState("");
  const [cpf, setCpf] = useState("");
  const [email, setEmail] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [selectedFarms, setSelectedFarms] = useState<Set<string>>(new Set());
  const [perms, setPerms] = useState<Permissions>(DEFAULT_PERMS);
  const [loadingInitial, setLoadingInitial] = useState(false);

  useEffect(() => {
    if (!editing) {
      setFullName(""); setCpf(""); setEmail(""); setWhatsapp("");
      setStatus("active"); setSelectedFarms(new Set()); setPerms(DEFAULT_PERMS);
      return;
    }
    setFullName(editing.full_name);
    setCpf(editing.cpf);
    setEmail(editing.email);
    setWhatsapp(editing.whatsapp);
    setStatus(editing.status);
    setLoadingInitial(true);
    (async () => {
      const [farmsRes, permsRes] = await Promise.all([
        supabase.from("master_manager_farms" as any).select("farm_id").eq("manager_id", editing.id),
        supabase.from("master_manager_permissions" as any).select("*").eq("manager_id", editing.id).maybeSingle(),
      ]);
      if (!farmsRes.error) setSelectedFarms(new Set(((farmsRes.data as any) ?? []).map((r: any) => r.farm_id)));
      if (!permsRes.error && permsRes.data) {
        const p = permsRes.data as any;
        setPerms({
          can_view_dashboard: p.can_view_dashboard,
          can_view_reports: p.can_view_reports,
          can_command_pumps: p.can_command_pumps,
          can_edit_schedules: p.can_edit_schedules,
          can_manage_maintenance: p.can_manage_maintenance,
          can_view_financial: p.can_view_financial,
          can_view_indicators: p.can_view_indicators ?? false,
          can_manage_operational_users: p.can_manage_operational_users,
        });
      }
      setLoadingInitial(false);
    })();
  }, [editing]);

  const toggleFarm = (farmId: string) => {
    setSelectedFarms(prev => {
      const next = new Set(prev);
      if (next.has(farmId)) next.delete(farmId); else next.add(farmId);
      return next;
    });
  };

  const validate = () => {
    if (!fullName.trim() || fullName.trim().length < 3) return "Informe o nome completo.";
    if (onlyDigits(cpf).length !== 11) return "CPF inválido.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "E-mail inválido.";
    if (onlyDigits(whatsapp).length < 10) return "WhatsApp inválido.";
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) { notify.fail("Validação", err); return; }
    setSaving(true);
    try {
      let userId = editing?.user_id;
      let provisionalPwd: string | undefined;

      if (!isEdit) {
        const { data, error } = await supabase.functions.invoke("platform-user-admin", {
          body: { action: "invite", email: email.trim().toLowerCase(), full_name: fullName.trim() },
        });
        if (error || !(data as any)?.ok) {
          throw new Error((data as any)?.error ?? error?.message ?? "Falha ao criar usuário");
        }
        userId = (data as any).user_id;
        provisionalPwd = (data as any).provisional_password;

        const { data: inserted, error: insErr } = await supabase.from("master_managers" as any).insert({
          user_id: userId,
          full_name: fullName.trim(),
          cpf: onlyDigits(cpf),
          email: email.trim().toLowerCase(),
          whatsapp: onlyDigits(whatsapp),
          status,
        }).select("id").single();
        if (insErr) throw insErr;
        const managerId = (inserted as any).id;

        // permissions
        const { error: pErr } = await supabase.from("master_manager_permissions" as any).insert({
          manager_id: managerId, ...perms,
        });
        if (pErr) throw pErr;

        // farm links
        if (selectedFarms.size > 0) {
          const links = Array.from(selectedFarms).map(farm_id => ({ manager_id: managerId, farm_id }));
          const { error: lErr } = await supabase.from("master_manager_farms" as any).insert(links);
          if (lErr) throw lErr;
        }
      } else {
        // update manager
        const { error: uErr } = await supabase.from("master_managers" as any).update({
          full_name: fullName.trim(),
          cpf: onlyDigits(cpf),
          email: email.trim().toLowerCase(),
          whatsapp: onlyDigits(whatsapp),
          status,
        }).eq("id", editing!.id);
        if (uErr) throw uErr;

        // upsert permissions
        const { error: pErr } = await supabase.from("master_manager_permissions" as any)
          .upsert({ manager_id: editing!.id, ...perms });
        if (pErr) throw pErr;

        // replace farm links
        await supabase.from("master_manager_farms" as any).delete().eq("manager_id", editing!.id);
        if (selectedFarms.size > 0) {
          const links = Array.from(selectedFarms).map(farm_id => ({ manager_id: editing!.id, farm_id }));
          const { error: lErr } = await supabase.from("master_manager_farms" as any).insert(links);
          if (lErr) throw lErr;
        }
      }

      notify.ok("Gestores Master", isEdit ? "Atualizado." : "Cadastrado com sucesso.");
      onSaved(provisionalPwd);
    } catch (e: any) {
      notify.fail("Gestores Master", e?.message ?? "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crown className="w-5 h-5 text-primary" />
            {isEdit ? "Editar Gestor Master" : "Novo Gestor Master"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Atualize dados, fazendas vinculadas e permissões."
              : "Cadastro de proprietário de grupo ou gestor geral. Uma senha provisória será gerada."}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 pr-3">
          {loadingInitial ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando…
            </div>
          ) : (
            <div className="space-y-6 pb-2">
              {/* Dados pessoais */}
              <section className="space-y-3">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Dados pessoais</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2">
                    <Label>Nome completo *</Label>
                    <Input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="João da Silva" />
                  </div>
                  <div>
                    <Label>CPF *</Label>
                    <Input value={maskCpf(cpf)} onChange={e => setCpf(e.target.value)} placeholder="000.000.000-00" maxLength={14} disabled={isEdit} />
                  </div>
                  <div>
                    <Label>E-mail (login) *</Label>
                    <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="gestor@empresa.com" disabled={isEdit} />
                  </div>
                  <div>
                    <Label>WhatsApp *</Label>
                    <Input value={maskPhone(whatsapp)} onChange={e => setWhatsapp(e.target.value)} placeholder="(77) 99999-8888" />
                  </div>
                  <div>
                    <Label>Status</Label>
                    <div className="flex items-center gap-3 h-10">
                      <Switch checked={status === "active"} onCheckedChange={v => setStatus(v ? "active" : "inactive")} />
                      <span className="text-sm">{status === "active" ? "Ativo" : "Inativo"}</span>
                    </div>
                  </div>
                </div>
              </section>

              {/* Fazendas vinculadas */}
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Fazendas vinculadas</h3>
                  <Badge variant="outline">{selectedFarms.size} de {farms.length}</Badge>
                </div>
                <div className="border rounded-lg p-3 max-h-56 overflow-y-auto space-y-2">
                  {farms.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma fazenda cadastrada.</p>}
                  {farms.map(f => (
                    <label key={f.farm_id} className="flex items-center gap-2 cursor-pointer hover:bg-muted/50 p-1 rounded">
                      <Checkbox checked={selectedFarms.has(f.farm_id)} onCheckedChange={() => toggleFarm(f.farm_id)} />
                      <span className="text-sm">{f.name}</span>
                    </label>
                  ))}
                </div>
              </section>

              {/* Permissões */}
              <section className="space-y-3">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Permissões de acesso</h3>
                <div className="space-y-2">
                  {PERM_LABELS.map(p => (
                    <div key={p.key} className="flex items-start justify-between gap-3 p-3 border rounded-lg">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{p.label}</div>
                        <div className="text-xs text-muted-foreground">{p.desc}</div>
                      </div>
                      <Switch
                        checked={perms[p.key]}
                        onCheckedChange={v => setPerms(prev => ({ ...prev, [p.key]: v }))}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Etapa 1: cadastro e persistência. A aplicação das permissões nas telas do cliente e a auditoria completa entram na próxima etapa.
                </p>
              </section>
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="mt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            <X className="w-4 h-4 mr-1.5" /> Cancelar
          </Button>
          <Button onClick={handleSave} disabled={saving || loadingInitial}>
            {saving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Plus className="w-4 h-4 mr-1.5" />}
            {isEdit ? "Salvar alterações" : "Cadastrar Gestor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
