// PlatformTechnicians — Aba dedicada para gerenciar técnicos (Admin / Suporte)
// autorizados a acessar o painel /platform da Renov.
//
// Funcionalidades:
// - Lista somente quem tem permissão de plataforma (admin OU support)
// - Cadastro rápido (cria usuário + já promove ao papel escolhido)
// - Promover qualquer usuário existente a técnico
// - Alterar papel (Admin ↔ Suporte) com 1 clique
// - Revogar acesso de plataforma
// - Resetar senha

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { notify } from "@/lib/notify";
import {
  Wrench, RefreshCw, UserPlus, Crown, ShieldCheck, X, KeyRound, Loader2, Copy, Search, ChevronsUpDown,
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

type TechRole = "admin" | "support";

function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export default function PlatformTechnicians({ isAdmin }: { isAdmin: boolean }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [openCreate, setOpenCreate] = useState(false);
  const [openPromote, setOpenPromote] = useState(false);

  const refresh = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("platform_users_overview" as any);
    if (error) notify.fail("Técnicos", "Erro ao carregar: " + error.message);
    else setUsers((data as any) ?? []);
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, []);

  const technicians = useMemo(
    () => users.filter(u => u.is_platform_admin || u.is_platform_support),
    [users],
  );
  const otherUsers = useMemo(
    () => users.filter(u => !u.is_platform_admin && !u.is_platform_support),
    [users],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return technicians;
    return technicians.filter(u =>
      u.email.toLowerCase().includes(q) || (u.full_name ?? "").toLowerCase().includes(q),
    );
  }, [technicians, search]);

  const setRole = async (userId: string, role: TechRole, enabled: boolean) => {
    const fn = role === "admin" ? "platform_set_admin" : "platform_set_support";
    const { error } = await supabase.rpc(fn as any, { _user_id: userId, _enabled: enabled });
    if (error) { notify.fail("Técnicos", error.message); return false; }
    return true;
  };

  const switchRole = async (u: UserRow, target: TechRole) => {
    if (target === "admin" && u.is_platform_admin) return;
    if (target === "support" && u.is_platform_support && !u.is_platform_admin) return;
    // Liga o novo, depois desliga o outro
    const ok1 = await setRole(u.user_id, target, true);
    if (!ok1) return;
    const other: TechRole = target === "admin" ? "support" : "admin";
    if ((other === "admin" && u.is_platform_admin) || (other === "support" && u.is_platform_support)) {
      await setRole(u.user_id, other, false);
    }
    notify.ok("Técnicos", `${u.email} agora é ${target === "admin" ? "Administrador" : "Suporte Técnico"}.`);
    void refresh();
  };

  const revoke = async (u: UserRow) => {
    if (!confirm(`Revogar acesso de plataforma de ${u.email}?`)) return;
    if (u.is_platform_admin) await setRole(u.user_id, "admin", false);
    if (u.is_platform_support) await setRole(u.user_id, "support", false);
    notify.ok("Técnicos", "Acesso revogado.");
    void refresh();
  };

  const resetPwd = async (u: UserRow) => {
    if (!confirm(`Resetar senha de ${u.email}? Será gerada uma senha provisória.`)) return;
    const { data, error } = await supabase.functions.invoke("platform-user-admin", {
      body: { action: "reset_password", user_id: u.user_id },
    });
    if (error || !data?.ok) return notify.fail("Técnicos", data?.error ?? error?.message);
    await navigator.clipboard.writeText(data.new_password);
    notify.ok("Técnicos", `Nova senha copiada: ${data.new_password}`);
  };

  return (
    <div className="space-y-4">
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Wrench className="w-4 h-4 text-primary" />
                Técnicos da Renov
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Pessoas autorizadas a acessar o painel da plataforma como suporte técnico.
                <br />
                <span className="font-semibold text-foreground">{technicians.length}</span> técnicos ·{" "}
                {technicians.filter(t => t.is_platform_admin).length} admins ·{" "}
                {technicians.filter(t => t.is_platform_support && !t.is_platform_admin).length} suporte
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Buscar técnico…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-9 w-56"
                />
              </div>
              <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
                <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              </Button>
              {isAdmin && (
                <>
                  <Button variant="outline" size="sm" onClick={() => setOpenPromote(true)}>
                    <Crown className="w-4 h-4 mr-1.5" />
                    Promover existente
                  </Button>
                  <Button size="sm" onClick={() => setOpenCreate(true)}>
                    <UserPlus className="w-4 h-4 mr-1.5" />
                    Novo técnico
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Técnico</TableHead>
                  <TableHead>Papel</TableHead>
                  <TableHead>Último login</TableHead>
                  <TableHead>Cadastrado em</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-10">
                      {loading
                        ? "Carregando…"
                        : technicians.length === 0
                          ? "Nenhum técnico cadastrado. Use o botão 'Novo técnico' para começar."
                          : "Nenhum técnico encontrado para a busca."}
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map(u => (
                  <TableRow key={u.user_id}>
                    <TableCell>
                      <div className="font-medium text-sm">
                        {u.full_name || <span className="text-muted-foreground italic">Sem nome</span>}
                      </div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </TableCell>
                    <TableCell>
                      {u.is_platform_admin ? (
                        <Badge variant="default" className="gap-1">
                          <Crown className="w-3 h-3" />Administrador
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="gap-1">
                          <ShieldCheck className="w-3 h-3" />Suporte
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmtDate(u.last_sign_in_at)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmtDate(u.created_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {isAdmin && !u.is_platform_admin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Promover a Administrador"
                            onClick={() => switchRole(u, "admin")}
                          >
                            <Crown className="w-4 h-4 text-amber-500" />
                          </Button>
                        )}
                        {isAdmin && u.is_platform_admin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Rebaixar para Suporte"
                            onClick={() => switchRole(u, "support")}
                          >
                            <ShieldCheck className="w-4 h-4 text-primary" />
                          </Button>
                        )}
                        {isAdmin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Resetar senha"
                            onClick={() => resetPwd(u)}
                          >
                            <KeyRound className="w-4 h-4" />
                          </Button>
                        )}
                        {isAdmin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Revogar acesso de plataforma"
                            onClick={() => revoke(u)}
                          >
                            <X className="w-4 h-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <CreateTechDialog
        open={openCreate}
        onClose={() => setOpenCreate(false)}
        onCreated={refresh}
      />
      <PromoteExistingDialog
        open={openPromote}
        onClose={() => setOpenPromote(false)}
        users={otherUsers}
        onPromoted={refresh}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CreateTechDialog — cria usuário novo já com papel de plataforma
// ─────────────────────────────────────────────────────────────────────────────

function CreateTechDialog({
  open, onClose, onCreated,
}: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<TechRole>("support");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string; role: TechRole } | null>(null);

  const close = () => {
    setEmail(""); setName(""); setPassword(""); setRole("support"); setCreated(null);
    onClose();
  };

  const submit = async () => {
    if (!email.includes("@")) return notify.fail("Técnicos", "Email inválido.");
    setBusy(true);

    // 1) Criar usuário via edge function
    const { data: invite, error: invErr } = await supabase.functions.invoke("platform-user-admin", {
      body: { action: "invite", email, full_name: name || undefined, password: password || undefined },
    });
    if (invErr || !invite?.ok) {
      setBusy(false);
      return notify.fail("Técnicos", "Erro ao criar: " + (invite?.error ?? invErr?.message ?? "desconhecido"));
    }

    // 2) Buscar user_id recém criado
    const { data: usersList } = await supabase.rpc("platform_users_overview" as any);
    const newUser = ((usersList as any) ?? []).find((u: UserRow) => u.email === invite.email);
    if (!newUser) {
      setBusy(false);
      notify.fail("Técnicos", "Usuário criado mas não localizado para promover. Faça manualmente.");
      onCreated();
      close();
      return;
    }

    // 3) Promover
    const fn = role === "admin" ? "platform_set_admin" : "platform_set_support";
    const { error: roleErr } = await supabase.rpc(fn as any, { _user_id: newUser.user_id, _enabled: true });
    setBusy(false);
    if (roleErr) {
      notify.fail("Técnicos", "Usuário criado mas falha ao promover: " + roleErr.message);
    }

    setCreated({ email: invite.email, password: invite.provisional_password, role });
    onCreated();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="w-5 h-5 text-primary" />
            {created ? "Técnico criado!" : "Cadastrar novo técnico"}
          </DialogTitle>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <div className="rounded-lg border p-3 bg-muted/30 space-y-2">
              <div>
                <Label className="text-xs">Email</Label>
                <div className="font-mono text-sm">{created.email}</div>
              </div>
              <div>
                <Label className="text-xs">Papel</Label>
                <div>
                  <Badge variant={created.role === "admin" ? "default" : "secondary"} className="gap-1">
                    {created.role === "admin"
                      ? <><Crown className="w-3 h-3" />Administrador</>
                      : <><ShieldCheck className="w-3 h-3" />Suporte Técnico</>}
                  </Badge>
                </div>
              </div>
              <div>
                <Label className="text-xs">Senha provisória</Label>
                <div className="flex gap-2">
                  <Input value={created.password} readOnly className="font-mono text-sm" />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      navigator.clipboard.writeText(created.password);
                      notify.ok("Técnicos", "Senha copiada");
                    }}
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Compartilhe com o técnico e peça para alterar no primeiro login.
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
              <Input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="tecnico@renov.com.br"
              />
            </div>
            <div>
              <Label>Nome completo</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="João da Silva" />
            </div>
            <div>
              <Label>Papel na plataforma *</Label>
              <Select value={role} onValueChange={(v: TechRole) => setRole(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="support">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>Suporte — acesso somente leitura</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="admin">
                    <div className="flex items-center gap-2">
                      <Crown className="w-3.5 h-3.5" />
                      <span>Administrador — acesso total</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Senha (opcional — vazio gera automática)</Label>
              <Input
                type="text"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Mínimo 8 caracteres"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close} disabled={busy}>Cancelar</Button>
              <Button onClick={submit} disabled={busy}>
                {busy
                  ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                  : <UserPlus className="w-4 h-4 mr-1.5" />}
                Criar técnico
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PromoteExistingDialog — promove usuário já existente a técnico
// ─────────────────────────────────────────────────────────────────────────────

function PromoteExistingDialog({
  open, onClose, users, onPromoted,
}: { open: boolean; onClose: () => void; users: UserRow[]; onPromoted: () => void }) {
  const [selected, setSelected] = useState<UserRow | null>(null);
  const [role, setRole] = useState<TechRole>("support");
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const close = () => {
    setSelected(null); setRole("support"); setPickerOpen(false); onClose();
  };

  const submit = async () => {
    if (!selected) return notify.fail("Técnicos", "Selecione um usuário.");
    setBusy(true);
    const fn = role === "admin" ? "platform_set_admin" : "platform_set_support";
    const { error } = await supabase.rpc(fn as any, { _user_id: selected.user_id, _enabled: true });
    setBusy(false);
    if (error) return notify.fail("Técnicos", error.message);
    notify.ok("Técnicos", `${selected.email} promovido a ${role === "admin" ? "Administrador" : "Suporte Técnico"}.`);
    onPromoted();
    close();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crown className="w-5 h-5 text-primary" />
            Promover usuário existente a técnico
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Usuário *</Label>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
                  {selected
                    ? <span className="truncate">{selected.full_name || selected.email}</span>
                    : <span className="text-muted-foreground">Selecione um usuário…</span>}
                  <ChevronsUpDown className="w-4 h-4 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Buscar email ou nome…" />
                  <CommandList>
                    <CommandEmpty>Nenhum usuário disponível.</CommandEmpty>
                    <CommandGroup>
                      {users.map(u => (
                        <CommandItem
                          key={u.user_id}
                          value={`${u.email} ${u.full_name ?? ""}`}
                          onSelect={() => { setSelected(u); setPickerOpen(false); }}
                        >
                          <div className="flex flex-col">
                            <span className="text-sm">{u.full_name || u.email}</span>
                            {u.full_name && (
                              <span className="text-xs text-muted-foreground">{u.email}</span>
                            )}
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <div>
            <Label>Papel *</Label>
            <Select value={role} onValueChange={(v: TechRole) => setRole(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="support">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Suporte — somente leitura
                  </div>
                </SelectItem>
                <SelectItem value="admin">
                  <div className="flex items-center gap-2">
                    <Crown className="w-3.5 h-3.5" />
                    Administrador — acesso total
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={busy}>Cancelar</Button>
            <Button onClick={submit} disabled={busy || !selected}>
              {busy
                ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                : <Crown className="w-4 h-4 mr-1.5" />}
              Promover
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
