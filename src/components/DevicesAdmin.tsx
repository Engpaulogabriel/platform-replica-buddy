// Aba "Dispositivos" do Suporte Técnico — apenas platform_admin.
// Lista dispositivos autorizados, tentativas pendentes, gera link de auto-registro.
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Smartphone, Monitor, Tablet, Trash2, PowerOff, Pencil, Check, X, Link as LinkIcon, Copy, Lock, RefreshCw, ShieldCheck, AlertTriangle } from "lucide-react";
import FarmDeviceAccessAdmin from "@/components/FarmDeviceAccessAdmin";
import { supabase } from "@/integrations/supabase/client";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";
import { useAuth } from "@/contexts/AuthContext";
import { notify } from "@/lib/notify";

interface Device {
  id: string;
  user_id: string;
  farm_id: string | null;
  device_fingerprint: string;
  device_name: string | null;
  device_type: string | null;
  browser: string | null;
  os: string | null;
  last_used_at: string;
  registered_at: string;
  is_active: boolean;
}
interface Attempt {
  id: string;
  user_id: string | null;
  device_fingerprint: string;
  device_info: any;
  attempted_at: string;
  status: string;
}
interface Farm { id: string; name: string; device_limit: number; ip_restriction_enabled?: boolean | null; }
interface Profile { id: string; email: string | null; full_name: string | null; default_farm_id: string | null; }

const fmt = (d: string) => new Date(d).toLocaleString("pt-BR");

function deviceIcon(t: string | null | undefined) {
  if (t === "mobile") return <Smartphone className="w-4 h-4" />;
  if (t === "tablet") return <Tablet className="w-4 h-4" />;
  return <Monitor className="w-4 h-4" />;
}

export default function DevicesAdmin() {
  const { isPlatformAdmin, loading: adminLoading } = usePlatformAdmin();
  const { user } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [farms, setFarms] = useState<Farm[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [farmFilter, setFarmFilter] = useState<string>("all");
  const [renaming, setRenaming] = useState<Device | null>(null);
  const [newName, setNewName] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUserId, setLinkUserId] = useState("");
  const [linkDeviceName, setLinkDeviceName] = useState("");
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    const [{ data: dev }, { data: att }, { data: f }, { data: p }] = await Promise.all([
      supabase.from("authorized_devices").select("*").order("last_used_at", { ascending: false }),
      supabase.from("device_access_attempts").select("*").eq("status", "blocked").order("attempted_at", { ascending: false }).limit(100),
      supabase.from("farms").select("id,name,device_limit,ip_restriction_enabled"),
      supabase.from("profiles").select("id,email,full_name,default_farm_id"),
    ]);
    setDevices((dev as Device[]) ?? []);
    setAttempts((att as Attempt[]) ?? []);
    setFarms((f as Farm[]) ?? []);
    const map: Record<string, Profile> = {};
    (p as Profile[] ?? []).forEach(x => { map[x.id] = x; });
    setProfiles(map);
    setLoading(false);
  };

  useEffect(() => {
    if (isPlatformAdmin) void reload();
  }, [isPlatformAdmin]);

  const filteredDevices = useMemo(() => {
    if (farmFilter === "all") return devices;
    if (farmFilter === "none") return devices.filter(d => !d.farm_id);
    return devices.filter(d => d.farm_id === farmFilter);
  }, [devices, farmFilter]);

  if (adminLoading) return <div className="p-6 text-sm text-muted-foreground">Carregando…</div>;
  if (!isPlatformAdmin) {
    return (
      <Alert variant="destructive">
        <Lock className="h-4 w-4" />
        <AlertDescription>Acesso restrito a administradores da plataforma Renov.</AlertDescription>
      </Alert>
    );
  }

  const userLabel = (uid: string | null) => {
    if (!uid) return "—";
    const p = profiles[uid];
    return p?.full_name || p?.email || uid.slice(0, 8);
  };

  const deactivate = async (d: Device) => {
    const { error } = await supabase.from("authorized_devices").update({ is_active: false }).eq("id", d.id);
    if (error) return notify.fail("Dispositivos", error.message);
    await supabase.from("device_audit_log").insert({ action: "deactivate", actor_id: user?.id, target_user_id: d.user_id, device_id: d.id });
    notify.ok("Dispositivos", "Dispositivo desativado");
    void reload();
  };
  const remove = async (d: Device) => {
    if (!confirm(`Remover dispositivo "${d.device_name ?? d.device_fingerprint.slice(-8)}"?`)) return;
    const { error } = await supabase.from("authorized_devices").delete().eq("id", d.id);
    if (error) return notify.fail("Dispositivos", error.message);
    await supabase.from("device_audit_log").insert({ action: "remove", actor_id: user?.id, target_user_id: d.user_id, details: { device_name: d.device_name } });
    notify.ok("Dispositivos", "Dispositivo removido");
    void reload();
  };
  const reactivate = async (d: Device) => {
    const { error } = await supabase.from("authorized_devices").update({ is_active: true }).eq("id", d.id);
    if (error) return notify.fail("Dispositivos", error.message);
    void reload();
  };
  const saveRename = async () => {
    if (!renaming) return;
    const { error } = await supabase.from("authorized_devices").update({ device_name: newName }).eq("id", renaming.id);
    if (error) return notify.fail("Dispositivos", error.message);
    await supabase.from("device_audit_log").insert({ action: "rename", actor_id: user?.id, target_user_id: renaming.user_id, device_id: renaming.id, details: { new_name: newName } });
    setRenaming(null);
    void reload();
  };

  const approveAttempt = async (a: Attempt) => {
    if (!a.user_id) return;
    const info = a.device_info ?? {};
    const profile = profiles[a.user_id];
    const farmLimit = farms.find(f => f.id === profile?.default_farm_id)?.device_limit ?? 1;
    const activeForUser = devices.filter(d => d.user_id === a.user_id && d.is_active).length;
    if (activeForUser >= farmLimit) {
      return notify.fail("Dispositivos", `Este usuário já atingiu o limite de ${farmLimit} dispositivo(s). Remova ou desative o atual antes de aprovar outro.`);
    }
    const { data: ins, error } = await supabase
      .from("authorized_devices")
      .insert({
        user_id: a.user_id,
        farm_id: profile?.default_farm_id ?? null,
        device_fingerprint: a.device_fingerprint,
        device_name: `${info.os ?? "?"} • ${info.browser ?? "?"}`,
        device_type: info.device_type ?? "desktop",
        browser: info.browser,
        os: info.os,
        registered_by: user?.id,
      })
      .select("id")
      .single();
    if (error) return notify.fail("Dispositivos", error.message);
    await supabase.from("device_access_attempts").update({ status: "approved", reviewed_by: user?.id, reviewed_at: new Date().toISOString() }).eq("id", a.id);
    await supabase.from("device_audit_log").insert({ action: "authorize", actor_id: user?.id, target_user_id: a.user_id, device_id: ins?.id, details: { from: "attempt" } });
    notify.ok("Dispositivos", "Dispositivo autorizado");
    void reload();
  };
  const rejectAttempt = async (a: Attempt) => {
    const { error } = await supabase.from("device_access_attempts").update({ status: "ignored", reviewed_by: user?.id, reviewed_at: new Date().toISOString() }).eq("id", a.id);
    if (error) return notify.fail("Dispositivos", error.message);
    void reload();
  };

  const generateLink = async () => {
    if (!linkUserId) return notify.fail("Dispositivos", "Selecione um usuário");
    const token = crypto.randomUUID().replace(/-/g, "");
    const { error } = await supabase.from("device_register_links").insert({
      token, target_user_id: linkUserId, created_by: user?.id, device_name: linkDeviceName || null,
    });
    if (error) return notify.fail("Dispositivos", error.message);
    const url = `${window.location.origin}/login?register=${token}`;
    setGeneratedLink(url);
    notify.ok("Dispositivos", "Link gerado (válido por 15 min)");
  };

  const updateFarmLimit = async (farmId: string, limit: number) => {
    const { error } = await supabase.from("farms").update({ device_limit: limit }).eq("id", farmId);
    if (error) return notify.fail("Dispositivos", error.message);
    await supabase.from("device_audit_log").insert({ action: "limit_change", actor_id: user?.id, farm_id: farmId, details: { new_limit: limit } });
    notify.ok("Dispositivos", "Limite atualizado");
    void reload();
  };

  const profileOptions = Object.values(profiles).sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-primary" /> Controle de Dispositivos</h2>
          <p className="text-sm text-muted-foreground">Cada usuário só acessa dos dispositivos liberados aqui.</p>
        </div>
        <Button variant="outline" size="sm" onClick={reload} disabled={loading} className="gap-2">
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /> Atualizar
        </Button>
      </div>

      <Tabs defaultValue="devices">
        <TabsList>
          <TabsTrigger value="devices">Autorizados ({devices.length})</TabsTrigger>
          <TabsTrigger value="pending">
            Pendentes {attempts.length > 0 && <Badge variant="destructive" className="ml-2">{attempts.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="register">Cadastro Rápido</TabsTrigger>
          <TabsTrigger value="limits">Limites</TabsTrigger>
        </TabsList>

        <TabsContent value="devices" className="mt-4 space-y-3">
          <div className="flex items-center gap-2">
            <Label className="text-sm">Filtrar por fazenda:</Label>
            <Select value={farmFilter} onValueChange={setFarmFilter}>
              <SelectTrigger className="w-[260px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas</SelectItem>
                <SelectItem value="none">Sem fazenda</SelectItem>
                {farms.map(f => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Usuário</TableHead>
                    <TableHead>Dispositivo</TableHead>
                    <TableHead>OS / Navegador</TableHead>
                    <TableHead>Código</TableHead>
                    <TableHead>Último uso</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredDevices.length === 0 && (
                    <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">Nenhum dispositivo</TableCell></TableRow>
                  )}
                  {filteredDevices.map(d => (
                    <TableRow key={d.id}>
                      <TableCell className="text-sm">{userLabel(d.user_id)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-sm">
                          {deviceIcon(d.device_type)} <span className="font-medium">{d.device_name ?? "(sem nome)"}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{d.os} • {d.browser}</TableCell>
                      <TableCell><code className="text-xs">{d.device_fingerprint.slice(-8).toUpperCase()}</code></TableCell>
                      <TableCell className="text-xs">{fmt(d.last_used_at)}</TableCell>
                      <TableCell>
                        {d.is_active
                          ? <Badge variant="outline" className="border-green-500 text-green-600">Ativo</Badge>
                          : <Badge variant="secondary">Inativo</Badge>}
                      </TableCell>
                      <TableCell className="text-right space-x-1">
                        <Button size="icon" variant="ghost" onClick={() => { setRenaming(d); setNewName(d.device_name ?? ""); }} title="Renomear"><Pencil className="w-4 h-4" /></Button>
                        {d.is_active
                          ? <Button size="icon" variant="ghost" onClick={() => deactivate(d)} title="Desativar"><PowerOff className="w-4 h-4" /></Button>
                          : <Button size="icon" variant="ghost" onClick={() => reactivate(d)} title="Reativar"><Check className="w-4 h-4" /></Button>}
                        <Button size="icon" variant="ghost" onClick={() => remove(d)} title="Remover"><Trash2 className="w-4 h-4 text-destructive" /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pending" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Quando</TableHead>
                    <TableHead>Usuário</TableHead>
                    <TableHead>Dispositivo</TableHead>
                    <TableHead>Código</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attempts.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">Sem solicitações pendentes 🎉</TableCell></TableRow>
                  )}
                  {attempts.map(a => (
                    <TableRow key={a.id}>
                      <TableCell className="text-xs">{fmt(a.attempted_at)}</TableCell>
                      <TableCell className="text-sm">{userLabel(a.user_id)}</TableCell>
                      <TableCell className="text-xs">{a.device_info?.os} • {a.device_info?.browser} • {a.device_info?.device_type}</TableCell>
                      <TableCell><code className="text-xs">{a.device_fingerprint.slice(-8).toUpperCase()}</code></TableCell>
                      <TableCell className="text-right space-x-1">
                        <Button size="sm" variant="outline" onClick={() => approveAttempt(a)} className="gap-1"><Check className="w-4 h-4" /> Aprovar</Button>
                        <Button size="sm" variant="ghost" onClick={() => rejectAttempt(a)} className="gap-1"><X className="w-4 h-4" /> Rejeitar</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="register" className="mt-4">
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><LinkIcon className="w-4 h-4" /> Gerar link de auto-registro (15 min)</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label>Usuário</Label>
                <Select value={linkUserId} onValueChange={setLinkUserId}>
                  <SelectTrigger><SelectValue placeholder="Selecione…" /></SelectTrigger>
                  <SelectContent>
                    {profileOptions.map(p => <SelectItem key={p.id} value={p.id}>{p.full_name || p.email}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Nome do dispositivo (opcional)</Label>
                <Input value={linkDeviceName} onChange={e => setLinkDeviceName(e.target.value)} placeholder='Ex: "PC Escritório"' />
              </div>
              <Button onClick={generateLink} className="gap-2"><LinkIcon className="w-4 h-4" /> Gerar link</Button>
              {generatedLink && (
                <Alert>
                  <AlertDescription className="space-y-2">
                    <p className="text-xs">Envie este link ao cliente. Ao abrir e fazer login no dispositivo desejado, será autorizado automaticamente.</p>
                    <div className="flex items-center gap-2">
                      <code className="text-xs flex-1 break-all bg-muted p-2 rounded">{generatedLink}</code>
                      <Button size="icon" variant="outline" onClick={() => { navigator.clipboard.writeText(generatedLink); notify.ok("Dispositivos", "Link copiado"); }}><Copy className="w-4 h-4" /></Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="limits" className="mt-4 space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-warning" /> Limite de dispositivos por usuário (por fazenda)</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Fazenda</TableHead><TableHead className="w-32">Limite</TableHead></TableRow></TableHeader>
                <TableBody>
                  {farms.map(f => (
                    <TableRow key={f.id}>
                      <TableCell>{f.name}</TableCell>
                      <TableCell>
                        <Input type="number" min={1} max={20} defaultValue={f.device_limit}
                          onBlur={(e) => { const v = Number(e.target.value); if (v && v !== f.device_limit) updateFarmLimit(f.id, v); }} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <FarmDeviceAccessAdmin farms={farms} onChanged={reload} />
        </TabsContent>
      </Tabs>

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Renomear dispositivo</DialogTitle></DialogHeader>
          <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Ex: PC Escritório, Celular Robson…" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(null)}>Cancelar</Button>
            <Button onClick={saveRename}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
