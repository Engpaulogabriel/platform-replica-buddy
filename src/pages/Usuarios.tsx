import { useEffect, useMemo, useState } from "react";
import { notifyUser } from "@/lib/notify";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { usePermission } from "@/contexts/MasterManagerContext";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Loader2, Pencil, Plus, Shield, Trash2, User, UserPlus } from "lucide-react";

type Role = "owner" | "supervisor" | "operator";

interface Member {
  user_id: string;
  role: Role;
  email: string | null;
  full_name: string | null;
}

const roleLabel: Record<Role, string> = {
  owner: "Administrador",
  supervisor: "Supervisor",
  operator: "Operador",
};

const roleColor: Record<Role, string> = {
  owner: "bg-warning/15 text-warning",
  supervisor: "bg-primary/15 text-primary",
  operator: "bg-info/15 text-info",
};

const Usuarios = () => {
  const { user } = useAuth();
  const [farmId, setFarmId] = useState<string | null>(null);
  const [myRole, setMyRole] = useState<Role | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  // Edit dialog
  const [editTarget, setEditTarget] = useState<Member | null>(null);
  const [editForm, setEditForm] = useState({ full_name: "", role: "operator" as Role });
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<Member | null>(null);
  const [deleting, setDeleting] = useState(false);

  // New user dialog
  const [newOpen, setNewOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState({
    email: "", full_name: "", password: "", role: "operator" as Role,
  });

  // Apenas a Renov (platform_admin) pode criar/editar/remover usuários.
  // Os 'Administradores' (owner) de fazenda apenas visualizam quem tem acesso.
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  useEffect(() => {
    if (!user?.id) { setIsPlatformAdmin(false); return; }
    let cancelled = false;
    void supabase.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle()
      .then(({ data }) => { if (!cancelled) setIsPlatformAdmin(!!data); });
    return () => { cancelled = true; };
  }, [user?.id]);
  const isAdmin = isPlatformAdmin;
  const canManageOperationalUsers = usePermission("can_manage_operational_users");


  const loadAll = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("default_farm_id")
        .eq("id", user.id)
        .maybeSingle();

      const fid = profile?.default_farm_id;
      if (!fid) { setLoading(false); return; }
      setFarmId(fid);

      const { data: myRoleRow } = await supabase
        .from("user_roles")
        .select("role")
        .eq("farm_id", fid)
        .eq("user_id", user.id)
        .maybeSingle();
      setMyRole((myRoleRow?.role as Role) ?? null);

      const { data: roles } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .eq("farm_id", fid);

      // Esconde usuários platform_admin (equipe Renov) da listagem da fazenda
      const { data: padmins } = await supabase.rpc("get_platform_admin_ids");
      const hiddenIds = new Set((padmins ?? []) as string[]);

      const filteredRoles = (roles ?? []).filter((r) => !hiddenIds.has(r.user_id));
      const ids = filteredRoles.map((r) => r.user_id);
      let profs: { id: string; email: string | null; full_name: string | null }[] = [];
      if (ids.length) {
        const { data } = await supabase
          .from("profiles")
          .select("id, email, full_name")
          .in("id", ids);
        profs = data ?? [];
      }
      const map = new Map(profs.map((p) => [p.id, p]));
      setMembers(
        filteredRoles.map((r) => ({
          user_id: r.user_id,
          role: r.role as Role,
          email: map.get(r.user_id)?.email ?? null,
          full_name: map.get(r.user_id)?.full_name ?? null,
        })),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notifyUser.error(`falha ao carregar — ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); /* eslint-disable-next-line */ }, [user?.id]);

  const openEdit = (m: Member) => {
    setEditForm({ full_name: m.full_name ?? "", role: m.role });
    setEditTarget(m);
  };

  const submitEdit = async () => {
    if (!editTarget || !farmId) return;
    setSavingEdit(true);
    try {
      // Atualiza nome (se mudou) — RLS permite admin via profiles_select_farm_admins;
      // para UPDATE precisa ser o próprio dono do profile, então só salvamos se for o usuário logado.
      const isSelf = editTarget.user_id === user?.id;
      if (isSelf && editForm.full_name !== (editTarget.full_name ?? "")) {
        const { error } = await supabase
          .from("profiles")
          .update({ full_name: editForm.full_name || null })
          .eq("id", editTarget.user_id);
        if (error) throw error;
      }

      // Atualiza papel (se mudou e não é owner / não é o próprio usuário)
      if (
        editForm.role !== editTarget.role &&
        !isSelf &&
        editTarget.role !== "owner"
      ) {
        const { error } = await supabase
          .from("user_roles")
          .update({ role: editForm.role })
          .eq("farm_id", farmId)
          .eq("user_id", editTarget.user_id);
        if (error) throw error;
      }

      notifyUser.updated(editTarget?.email ?? "");
      setEditTarget(null);
      await loadAll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notifyUser.error(`falha ao salvar — ${msg}`);
    } finally {
      setSavingEdit(false);
    }
  };

  const submitDelete = async () => {
    if (!deleteTarget || !farmId) return;
    setDeleting(true);
    try {
      const { data, error } = await supabase.functions.invoke("delete-member", {
        body: { user_id: deleteTarget.user_id, farm_id: farmId },
      });
      if (error) throw error;
      if ((data as { error?: string })?.error) {
        throw new Error((data as { error: string }).error);
      }
      notifyUser.removed(deleteTarget?.email ?? "");
      setDeleteTarget(null);
      await loadAll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notifyUser.error(`falha ao remover — ${msg}`);
    } finally {
      setDeleting(false);
    }
  };

  const submitNew = async () => {
    if (!farmId) return;
    if (!newForm.email.trim()) { notifyUser.error("informe o email."); return; }
    if (newForm.password.length < 8) {
      notifyUser.error("senha precisa ter ao menos 8 caracteres."); return;
    }
    setCreating(true);
    try {
      const { data, error } = await supabase.functions.invoke("invite-member", {
        body: {
          mode: "direct",
          email: newForm.email.trim().toLowerCase(),
          full_name: newForm.full_name.trim() || undefined,
          password: newForm.password,
          role: newForm.role,
          farm_id: farmId,
        },
      });
      if (error) throw error;
      if ((data as { error?: string })?.error) {
        throw new Error((data as { error: string }).error);
      }
      notifyUser.created(newForm.email);
      setNewOpen(false);
      setNewForm({ email: "", full_name: "", password: "", role: "operator" });
      await loadAll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notifyUser.error(msg);
    } finally {
      setCreating(false);
    }
  };

  const sorted = useMemo(
    () => [...members].sort((a, b) => {
      const order: Record<Role, number> = { owner: 0, supervisor: 1, operator: 2 };
      return order[a.role] - order[b.role];
    }),
    [members],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!farmId) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="p-6 text-sm text-muted-foreground">
          Nenhuma fazenda padrão definida para este usuário.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Usuários</h1>
          <p className="text-sm text-muted-foreground mt-1">Gerencie os acessos ao sistema</p>
        </div>
        {isAdmin && canManageOperationalUsers && (
          <Button className="bg-primary text-primary-foreground gap-2" onClick={() => setNewOpen(true)}>
            <UserPlus className="w-4 h-4" /> Novo Usuário
          </Button>
        )}

      </div>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-secondary/50">
                <TableHead className="text-muted-foreground">Usuário</TableHead>
                <TableHead className="text-muted-foreground">E-mail</TableHead>
                <TableHead className="text-muted-foreground">Perfil</TableHead>
                {isAdmin && <TableHead className="text-muted-foreground text-right">Ações</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((m) => {
                const isSelf = m.user_id === user?.id;
                const isOwner = m.role === "owner";
                return (
                  <TableRow key={m.user_id} className="border-border hover:bg-secondary/50">
                    <TableCell className="text-foreground font-medium">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
                          {isOwner || m.role === "supervisor"
                            ? <Shield className="w-4 h-4 text-primary" />
                            : <User className="w-4 h-4 text-muted-foreground" />}
                        </div>
                        <span>{m.full_name || m.email || m.user_id.slice(0, 8)}</span>
                        {isSelf && <Badge variant="secondary" className="ml-1 text-[10px]">você</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{m.email ?? "—"}</TableCell>
                    <TableCell>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${roleColor[m.role]}`}>
                        {roleLabel[m.role]}
                      </span>
                    </TableCell>
                    {isAdmin && (
                      <TableCell className="text-right space-x-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => openEdit(m)}
                          disabled={isOwner && !isSelf}
                          title={isOwner && !isSelf ? "Não é possível editar o proprietário" : "Editar"}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteTarget(m)}
                          disabled={isSelf || isOwner}
                          title={isSelf ? "Você não pode remover a si mesmo" : isOwner ? "Não é possível remover o proprietário" : "Remover"}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
              {sorted.length === 0 && (
                <TableRow>
                  <TableCell colSpan={isAdmin ? 4 : 3} className="text-center text-sm text-muted-foreground py-8">
                    Nenhum usuário encontrado.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Edit dialog */}
      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-primary" /> Editar Usuário
            </DialogTitle>
            <DialogDescription>
              {editTarget?.email ?? editTarget?.user_id.slice(0, 8)}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label>Nome</Label>
              <Input
                className="mt-1"
                value={editForm.full_name}
                onChange={(e) => setEditForm((f) => ({ ...f, full_name: e.target.value }))}
                placeholder="Nome completo"
                disabled={editTarget?.user_id !== user?.id}
              />
              {editTarget && editTarget.user_id !== user?.id && (
                <p className="text-xs text-muted-foreground mt-1">
                  Apenas o próprio usuário pode alterar o nome.
                </p>
              )}
            </div>

            <div>
              <Label>Papel</Label>
              <Select
                value={editForm.role}
                onValueChange={(v) => setEditForm((f) => ({ ...f, role: v as Role }))}
                disabled={editTarget?.role === "owner" || editTarget?.user_id === user?.id}
              >
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="supervisor">Supervisor</SelectItem>
                  <SelectItem value="operator">Operador</SelectItem>
                </SelectContent>
              </Select>
              {editTarget?.user_id === user?.id && (
                <p className="text-xs text-muted-foreground mt-1">
                  Você não pode alterar o seu próprio papel.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)} disabled={savingEdit}>
              Cancelar
            </Button>
            <Button onClick={submitEdit} disabled={savingEdit} className="gap-2">
              {savingEdit && <Loader2 className="w-4 h-4 animate-spin" />}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover usuário?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteTarget?.email ?? deleteTarget?.full_name}</strong> perderá acesso a esta fazenda.
              Se ele não tiver outras fazendas, a conta será excluída permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={submitDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Remover"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* New user dialog */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="w-5 h-5 text-primary" /> Novo Usuário
            </DialogTitle>
            <DialogDescription>
              Cria um login direto. O usuário poderá acessar imediatamente.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label>Nome (opcional)</Label>
              <Input
                className="mt-1"
                value={newForm.full_name}
                onChange={(e) => setNewForm((f) => ({ ...f, full_name: e.target.value }))}
                placeholder="Ex: João Silva"
              />
            </div>
            <div>
              <Label>Email</Label>
              <Input
                type="email"
                className="mt-1"
                value={newForm.email}
                onChange={(e) => setNewForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="usuario@empresa.com"
              />
            </div>
            <div>
              <Label>Senha (mín. 8 caracteres)</Label>
              <Input
                type="text"
                className="mt-1"
                value={newForm.password}
                onChange={(e) => setNewForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="Senha temporária"
              />
            </div>
            <div>
              <Label>Papel</Label>
              <Select
                value={newForm.role}
                onValueChange={(v) => setNewForm((f) => ({ ...f, role: v as Role }))}
              >
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="owner">Administrador</SelectItem>
                  <SelectItem value="supervisor">Supervisor</SelectItem>
                  <SelectItem value="operator">Operador</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)} disabled={creating}>
              Cancelar
            </Button>
            <Button onClick={submitNew} disabled={creating} className="gap-2">
              {creating && <Loader2 className="w-4 h-4 animate-spin" />}
              Criar Usuário
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Usuarios;
