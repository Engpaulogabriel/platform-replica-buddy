import { useEffect, useMemo, useState } from "react";
import { notify } from "@/lib/notify";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import RestrictedAuth from "@/components/RestrictedAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, KeyRound, Eye, EyeOff, Loader2, RefreshCw, Copy } from "lucide-react";

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

function genPassword(length = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  let out = "";
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  for (let i = 0; i < length; i++) out += chars[arr[i] % chars.length];
  return out;
}

export const CadastroLoginInner = () => {
  const { user } = useAuth();
  const [farmId, setFarmId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Member | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState({ nome: "", email: "", senha: "", perfil: "operator" as Role });

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

      const { data: roles, error: rErr } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .eq("farm_id", fid);
      if (rErr) throw rErr;

      const ids = (roles ?? []).map((r) => r.user_id);
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
        (roles ?? []).map((r) => ({
          user_id: r.user_id,
          role: r.role as Role,
          email: map.get(r.user_id)?.email ?? null,
          full_name: map.get(r.user_id)?.full_name ?? null,
        })),
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.fail("Cadastro/Login", "Falha ao carregar: " + msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); /* eslint-disable-next-line */ }, [user?.id]);

  const openNew = () => {
    setForm({ nome: "", email: "", senha: genPassword(), perfil: "operator" });
    setShowPassword(true);
    setDialogOpen(true);
  };

  const save = async () => {
    if (!farmId) return;
    if (!form.email.trim()) { notify.fail("Cadastro/Login", "Informe o email"); return; }
    if (form.senha.length < 8) { notify.fail("Cadastro/Login", "Senha precisa ter ao menos 8 caracteres"); return; }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("invite-member", {
        body: {
          mode: "direct",
          email: form.email.trim().toLowerCase(),
          full_name: form.nome.trim() || undefined,
          password: form.senha,
          role: form.perfil,
          farm_id: farmId,
        },
      });
      if (error) throw error;
      const errPayload = (data as { error?: string })?.error;
      if (errPayload) throw new Error(errPayload);
      notify.ok("Cadastro/Login", "Login criado com sucesso!");
      setDialogOpen(false);
      await loadAll();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.fail("Cadastro/Login", "Falha: " + msg);
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || !farmId) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("delete-member", {
        body: { user_id: deleteTarget.user_id, farm_id: farmId },
      });
      if (error) throw error;
      const errPayload = (data as { error?: string })?.error;
      if (errPayload) throw new Error(errPayload);
      notify.ok("Cadastro/Login", "Login removido");
      setMembers((prev) => prev.filter((m) => m.user_id !== deleteTarget.user_id));
      setDeleteTarget(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.fail("Cadastro/Login", "Falha: " + msg);
    } finally {
      setSubmitting(false);
    }
  };

  const updateRole = async (m: Member, newRole: Role) => {
    if (!farmId || m.user_id === user?.id || m.role === "owner") return;
    const { error } = await supabase
      .from("user_roles")
      .update({ role: newRole })
      .eq("farm_id", farmId)
      .eq("user_id", m.user_id);
    if (error) { notify.fail("Cadastro/Login", error.message); return; }
    notify.ok("Cadastro/Login", "Perfil atualizado");
    setMembers((prev) => prev.map((x) => (x.user_id === m.user_id ? { ...x, role: newRole } : x)));
  };

  const sortedMembers = useMemo(() => {
    const order: Record<Role, number> = { owner: 0, supervisor: 1, operator: 2 };
    return [...members].sort((a, b) => order[a.role] - order[b.role]);
  }, [members]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Cadastro de Login</h1>
          <p className="text-sm text-muted-foreground mt-1">Gerencie credenciais de acesso ao sistema</p>
        </div>
        <Button className="bg-primary text-primary-foreground gap-2" onClick={openNew} disabled={!farmId}>
          <Plus className="w-4 h-4" /> Novo Login
        </Button>
      </div>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-secondary/50">
                  <TableHead className="text-muted-foreground">Nome</TableHead>
                  <TableHead className="text-muted-foreground">Email</TableHead>
                  <TableHead className="text-muted-foreground">Perfil</TableHead>
                  <TableHead className="text-muted-foreground text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedMembers.map((m) => {
                  const isSelf = m.user_id === user?.id;
                  const isOwner = m.role === "owner";
                  return (
                    <TableRow key={m.user_id} className="border-border hover:bg-secondary/30">
                      <TableCell className="font-medium text-foreground">
                        {m.full_name || "—"}
                        {isSelf && <Badge variant="secondary" className="ml-2 text-[10px]">você</Badge>}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{m.email ?? "—"}</TableCell>
                      <TableCell>
                        {!isSelf && !isOwner ? (
                          <Select value={m.role} onValueChange={(v) => updateRole(m, v as Role)}>
                            <SelectTrigger className="w-[160px] bg-secondary border-border">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="supervisor">Supervisor</SelectItem>
                              <SelectItem value="operator">Operador</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge variant="secondary" className={roleColor[m.role]}>{roleLabel[m.role]}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {!isSelf && !isOwner && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget(m)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {sortedMembers.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                      Nenhum login cadastrado.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <KeyRound className="w-5 h-5 text-primary" /> Novo Login
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-foreground">Nome</Label>
              <Input
                className="bg-secondary border-border mt-1"
                value={form.nome}
                onChange={e => setForm(f => ({ ...f, nome: e.target.value }))}
                placeholder="Ex: João Silva"
              />
            </div>
            <div>
              <Label className="text-foreground">Email</Label>
              <Input
                className="bg-secondary border-border mt-1"
                type="email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="usuario@empresa.com"
              />
            </div>
            <div>
              <Label className="text-foreground">Senha (mín. 8 caracteres)</Label>
              <div className="relative mt-1 flex gap-2">
                <div className="relative flex-1">
                  <Input
                    className="bg-secondary border-border pr-10"
                    type={showPassword ? "text" : "password"}
                    value={form.senha}
                    onChange={e => setForm(f => ({ ...f, senha: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setForm(f => ({ ...f, senha: genPassword() }))}
                  title="Gerar nova senha"
                >
                  <RefreshCw className="w-4 h-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => { navigator.clipboard.writeText(form.senha); notify.ok("Cadastro/Login", "Senha copiada"); }}
                  title="Copiar senha"
                >
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-foreground">Perfil</Label>
              <Select value={form.perfil} onValueChange={v => setForm(f => ({ ...f, perfil: v as Role }))}>
                <SelectTrigger className="bg-secondary border-border mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="owner">Administrador</SelectItem>
                  <SelectItem value="supervisor">Supervisor</SelectItem>
                  <SelectItem value="operator">Operador</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>Cancelar</Button>
            <Button className="bg-primary text-primary-foreground gap-2" onClick={save} disabled={submitting}>
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Criar Login
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-foreground">Confirmar Exclusão</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <strong>{deleteTarget?.email}</strong> perderá acesso a esta fazenda. Se este for o único vínculo da conta, o usuário será removido completamente do sistema.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={submitting}>Cancelar</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={submitting} className="gap-2">
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const CadastroLogin = () => (
  <RestrictedAuth title="Cadastro de Login" description="Gerenciamento de credenciais requer autenticação restrita">
    <CadastroLoginInner />
  </RestrictedAuth>
);

export default CadastroLogin;
