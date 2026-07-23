import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { notify } from "@/lib/notify";
import {
  Users, RefreshCw, Search, UserPlus, KeyRound, Trash2, Shield,
  ShieldCheck, Eye, X, Plus, Copy, Building2, Crown, Loader2,
} from "lucide-react";

interface UserRow {
  user_id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  is_platform_admin: boolean;
  is_platform_support: boolean;
  farms_count: number;
  farms: Array<{ farm_id: string; farm_name: string; role: string }>;
}

interface Farm { farm_id: string; name: string; }

const ROLE_LABELS: Record<string, string> = {
  owner: "Dono", admin: "Admin", operator: "Operador", viewer: "Visualizador",
};
const ROLE_COLORS: Record<string, "default" | "secondary" | "outline"> = {
  owner: "default", admin: "default", operator: "secondary", viewer: "outline",
};

function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export default function PlatformUsers({ isAdmin }: { isAdmin: boolean }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [farms, setFarms] = useState<Farm[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "admins" | "no-farm">("all");
  const [openInvite, setOpenInvite] = useState(false);
  const [detailUser, setDetailUser] = useState<UserRow | null>(null);

  const refresh = async () => {
    setLoading(true);
    const [usersRes, farmsRes] = await Promise.all([
      supabase.rpc("platform_users_overview" as any),
      supabase.rpc("platform_farms_overview" as any),
    ]);
    if (usersRes.error) notify.fail("Usuários", "Erro ao carregar usuários: " + usersRes.error.message);
    else setUsers((usersRes.data as any) ?? []);
    if (farmsRes.error) notify.fail("Usuários", "Erro ao carregar fazendas: " + farmsRes.error.message);
    else setFarms(((farmsRes.data as any) ?? []).map((f: any) => ({ farm_id: f.farm_id, name: f.name })));
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter(u => {
      if (filter === "admins" && !(u.is_platform_admin || u.is_platform_support)) return false;
      if (filter === "no-farm" && u.farms_count > 0) return false;
      if (!q) return true;
      return u.email.toLowerCase().includes(q)
          || (u.full_name ?? "").toLowerCase().includes(q);
    });
  }, [users, search, filter]);

  return (
    <div className="space-y-4">
      {/* Header com filtros */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="w-4 h-4 text-primary" />
                Usuários do sistema
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                {users.length} usuários · {users.filter(u => u.is_platform_admin).length} admins da plataforma
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Buscar email ou nome…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-9 w-64"
                />
              </div>
              <Select value={filter} onValueChange={(v: any) => setFilter(v)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="admins">Plataforma</SelectItem>
                  <SelectItem value="no-farm">Sem fazenda</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
                <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              </Button>
              {isAdmin && (
                <Button size="sm" onClick={() => setOpenInvite(true)}>
                  <UserPlus className="w-4 h-4 mr-1.5" />
                  Novo usuário
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Usuário</TableHead>
                  <TableHead>Plataforma</TableHead>
                  <TableHead>Fazendas / Papéis</TableHead>
                  <TableHead>Último login</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      {loading ? "Carregando…" : "Nenhum usuário encontrado."}
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map(u => (
                  <TableRow key={u.user_id}>
                    <TableCell>
                      <div className="font-medium text-sm">{u.full_name || <span className="text-muted-foreground italic">Sem nome</span>}</div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </TableCell>
                    <TableCell>
                      {u.is_platform_admin && (
                        <Badge variant="default" className="mr-1 gap-1"><Crown className="w-3 h-3" />Admin</Badge>
                      )}
                      {u.is_platform_support && (
                        <Badge variant="secondary" className="gap-1"><ShieldCheck className="w-3 h-3" />Suporte</Badge>
                      )}
                      {!u.is_platform_admin && !u.is_platform_support && (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {u.farms_count === 0 ? (
                        <span className="text-xs text-muted-foreground">Sem fazendas</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {u.farms.slice(0, 3).map(f => (
                            <Badge key={f.farm_id} variant={ROLE_COLORS[f.role]} className="text-[10px]">
                              {f.farm_name} · {ROLE_LABELS[f.role] ?? f.role}
                            </Badge>
                          ))}
                          {u.farms_count > 3 && (
                            <Badge variant="outline" className="text-[10px]">+{u.farms_count - 3}</Badge>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmtDate(u.last_sign_in_at)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => setDetailUser(u)}>
                        <Eye className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <InviteDialog open={openInvite} onClose={() => setOpenInvite(false)} onCreated={refresh} />
      <UserDetailDialog
        user={detailUser}
        farms={farms}
        isAdmin={isAdmin}
        onClose={() => setDetailUser(null)}
        onChanged={() => { refresh(); }}
      />
    </div>
  );
}

function InviteDialog({ open, onClose, onCreated }: any) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  const submit = async () => {
    if (!email.includes("@")) return notify.fail("Usuários", "Email inválido.");
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("platform-user-admin", {
      body: { action: "invite", email, full_name: name || undefined, password: password || undefined },
    });
    setBusy(false);
    if (error || !data?.ok) {
      return notify.fail("Usuários", "Erro: " + (data?.error ?? error?.message ?? "desconhecido"));
    }
    setCreated({ email: data.email, password: data.provisional_password });
    onCreated();
  };

  const close = () => {
    setEmail(""); setName(""); setPassword(""); setCreated(null); onClose();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{created ? "Usuário criado!" : "Cadastrar novo usuário"}</DialogTitle>
        </DialogHeader>
        {created ? (
          <div className="space-y-3">
            <div className="rounded-lg border p-3 bg-muted/30 space-y-2">
              <div>
                <Label className="text-xs">Email</Label>
                <div className="font-mono text-sm">{created.email}</div>
              </div>
              <div>
                <Label className="text-xs">Senha provisória</Label>
                <div className="flex gap-2">
                  <Input value={created.password} readOnly className="font-mono text-sm" />
                  <Button size="sm" variant="outline" onClick={() => {
                    navigator.clipboard.writeText(created.password);
                    notify.ok("Usuários", "Senha copiada");
                  }}>
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Compartilhe com o usuário e peça para alterá-la no primeiro login.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={close}>Fechar</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label>Email *</Label>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="usuario@fazenda.com" />
            </div>
            <div>
              <Label>Nome completo</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="João da Silva" />
            </div>
            <div>
              <Label>Senha (opcional — se vazio gera automática)</Label>
              <Input type="text" value={password} onChange={e => setPassword(e.target.value)} placeholder="Mínimo 8 caracteres" />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Após criar, atribua o usuário a uma fazenda na tela de detalhes.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={close} disabled={busy}>Cancelar</Button>
              <Button onClick={submit} disabled={busy}>
                {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <UserPlus className="w-4 h-4 mr-1.5" />}
                Criar usuário
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UserDetailDialog({ user, farms, isAdmin, onClose, onChanged }: any) {
  const [addFarmId, setAddFarmId] = useState("");
  const [addRole, setAddRole] = useState("operator");
  const [busy, setBusy] = useState(false);
  const [resetResult, setResetResult] = useState<string | null>(null);

  if (!user) return null;
  const u: UserRow = user;
  const availableFarms = farms.filter((f: Farm) => !u.farms.find(uf => uf.farm_id === f.farm_id));

  const togglePlatform = async (kind: "admin" | "support", value: boolean) => {
    setBusy(true);
    const fn = kind === "admin" ? "platform_set_admin" : "platform_set_support";
    const { error } = await supabase.rpc(fn as any, { _user_id: u.user_id, _enabled: value });
    setBusy(false);
    if (error) return notify.fail("Usuários", error.message);
    notify.ok("Usuários", "Atualizado.");
    onChanged();
  };

  const addRoleSubmit = async () => {
    if (!addFarmId) return notify.fail("Usuários", "Selecione uma fazenda.");
    setBusy(true);
    const { error } = await supabase.rpc("platform_assign_role" as any, {
      _user_id: u.user_id, _farm_id: addFarmId, _role: addRole,
    });
    setBusy(false);
    if (error) return notify.fail("Usuários", error.message);
    notify.ok("Usuários", "Papel atribuído.");
    setAddFarmId(""); setAddRole("operator");
    onChanged();
  };

  const removeRole = async (farmId: string) => {
    if (!confirm("Remover acesso desta fazenda?")) return;
    const { error } = await supabase.rpc("platform_remove_role" as any, {
      _user_id: u.user_id, _farm_id: farmId,
    });
    if (error) return notify.fail("Usuários", error.message);
    notify.ok("Usuários", "Acesso removido.");
    onChanged();
  };

  const resetPassword = async () => {
    if (!confirm(`Resetar senha de ${u.email}? Será gerada uma senha provisória.`)) return;
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("platform-user-admin", {
      body: { action: "reset_password", user_id: u.user_id },
    });
    setBusy(false);
    if (error || !data?.ok) return notify.fail("Usuários", data?.error ?? error?.message);
    setResetResult(data.new_password);
  };

  const deleteUser = async () => {
    if (!confirm(`EXCLUIR permanentemente ${u.email}? Esta ação não pode ser desfeita.`)) return;
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("platform-user-admin", {
      body: { action: "delete", user_id: u.user_id },
    });
    setBusy(false);
    if (error || !data?.ok) return notify.fail("Usuários", data?.error ?? error?.message);
    notify.ok("Usuários", "Usuário excluído.");
    onChanged();
    onClose();
  };

  return (
    <Dialog open={!!user} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            {u.full_name || u.email}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border p-3 bg-muted/30 text-sm space-y-1">
            <div><strong>Email:</strong> {u.email}</div>
            <div><strong>ID:</strong> <span className="font-mono text-xs">{u.user_id}</span></div>
            <div><strong>Criado em:</strong> {fmtDate(u.created_at)}</div>
            <div><strong>Último login:</strong> {fmtDate(u.last_sign_in_at)}</div>
          </div>

          {/* Papéis de plataforma */}
          <div className="rounded-md border p-3 space-y-3">
            <Label className="text-xs uppercase tracking-wider flex items-center gap-1.5">
              <Crown className="w-3.5 h-3.5" /> Permissões da Plataforma
            </Label>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Administrador</div>
                <div className="text-xs text-muted-foreground">Acesso total ao painel /platform</div>
              </div>
              <Switch checked={u.is_platform_admin} disabled={!isAdmin || busy}
                onCheckedChange={v => togglePlatform("admin", v)} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Suporte</div>
                <div className="text-xs text-muted-foreground">Acesso somente leitura ao painel /platform</div>
              </div>
              <Switch checked={u.is_platform_support} disabled={!isAdmin || busy}
                onCheckedChange={v => togglePlatform("support", v)} />
            </div>
          </div>

          {/* Fazendas */}
          <div className="rounded-md border p-3 space-y-3">
            <Label className="text-xs uppercase tracking-wider flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5" /> Fazendas vinculadas ({u.farms_count})
            </Label>
            <div className="space-y-2">
              {u.farms.length === 0 && (
                <div className="text-xs text-muted-foreground py-2">Sem fazendas vinculadas.</div>
              )}
              {u.farms.map(f => (
                <div key={f.farm_id} className="flex items-center justify-between text-sm border rounded p-2">
                  <div>
                    <div className="font-medium">{f.farm_name}</div>
                    <Badge variant={ROLE_COLORS[f.role]} className="text-[10px] mt-0.5">
                      {ROLE_LABELS[f.role] ?? f.role}
                    </Badge>
                  </div>
                  {isAdmin && (
                    <Button variant="ghost" size="sm" onClick={() => removeRole(f.farm_id)}>
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>

            {isAdmin && availableFarms.length > 0 && (
              <div className="flex gap-2 pt-2 border-t">
                <Select value={addFarmId} onValueChange={setAddFarmId}>
                  <SelectTrigger className="flex-1"><SelectValue placeholder="Fazenda…" /></SelectTrigger>
                  <SelectContent>
                    {availableFarms.map((f: Farm) =>
                      <SelectItem key={f.farm_id} value={f.farm_id}>{f.name}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <Select value={addRole} onValueChange={setAddRole}>
                  <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="owner">Administrador</SelectItem>
                    <SelectItem value="supervisor">Supervisor</SelectItem>
                    <SelectItem value="operator">Operador</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={addRoleSubmit} disabled={busy}>
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
            )}
          </div>

          {/* Reset senha */}
          {resetResult && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
              <Label className="text-xs">Nova senha provisória</Label>
              <div className="flex gap-2">
                <Input value={resetResult} readOnly className="font-mono text-sm" />
                <Button size="sm" variant="outline" onClick={() => {
                  navigator.clipboard.writeText(resetResult);
                  notify.ok("Usuários", "Copiada");
                }}>
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}

          {/* Ações destrutivas */}
          {isAdmin && (
            <div className="flex gap-2 pt-2 border-t">
              <Button variant="outline" size="sm" onClick={resetPassword} disabled={busy}>
                <KeyRound className="w-4 h-4 mr-1.5" />
                Resetar senha
              </Button>
              <Button variant="destructive" size="sm" onClick={deleteUser} disabled={busy} className="ml-auto">
                <Trash2 className="w-4 h-4 mr-1.5" />
                Excluir usuário
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
