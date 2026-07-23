import { useEffect, useState, useMemo } from "react";
import { Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { usePlatformAccess } from "@/hooks/usePlatformAccess";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { notify } from "@/lib/notify";
import {
  Building2, Users, Cpu, Activity, Shield, Plus, RefreshCw, Search,
  CheckCircle2, XCircle, Eye, KeyRound, Pause, Play, Copy, ShieldCheck, Database, Bell, FileText, Power,
  Download, FileJson, Rocket, Wrench, Timer, Plug, Crown,
} from "lucide-react";
import PlatformMasterManagers from "@/components/platform/PlatformMasterManagers";
import PlatformDevices from "@/components/platform/PlatformDevices";
import PlatformBackups from "@/components/platform/PlatformBackups";
import PlatformUsers from "@/components/platform/PlatformUsers";
import PlatformTechnicians from "@/components/platform/PlatformTechnicians";
import PlatformAlerts from "@/components/platform/PlatformAlerts";
import PlatformReports from "@/components/platform/PlatformReports";
import PlatformRemoteControl from "@/components/platform/PlatformRemoteControl";
import PlatformDemoMenu from "@/components/platform/PlatformDemoMenu";
import PlatformFarmSwitcher from "@/components/platform/PlatformFarmSwitcher";
import PlatformUpdates from "@/components/platform/PlatformUpdates";
import PlatformServiceMode from "@/components/platform/PlatformServiceMode";
import PlatformMaintenance from "@/components/platform/PlatformMaintenance";
import PlatformTimings from "@/components/platform/PlatformTimings";
import PlatformAgentConfig from "@/components/platform/PlatformAgentConfig";

interface FarmRow {
  farm_id: string;
  name: string;
  city: string | null;
  state: string | null;
  plan: string;
  license_key: string | null;
  created_at: string;
  equipments_count: number;
  users_count: number;
  agent_status: string;
  last_heartbeat: string | null;
  com_connected: boolean;
  pending_commands: number;
}

interface Stats {
  total_farms: number;
  farms_lite: number;
  farms_pro: number;
  farms_suspended: number;
  agents_online: number;
  agents_offline: number;
  total_equipments: number;
  total_users: number;
  pending_commands: number;
}

function StatCard({ icon: Icon, label, value, hint, tone = "default" }: any) {
  const tones: Record<string, string> = {
    default: "text-foreground",
    success: "text-green-600",
    warning: "text-amber-600",
    danger: "text-destructive",
  };
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className="w-5 h-5 text-primary" />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">{label}</div>
          <div className={`text-2xl font-bold leading-tight ${tones[tone]}`}>{value}</div>
          {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

export default function PlatformAdmin() {
  const { role, loading: roleLoading, isAdmin } = usePlatformAccess();
  const [stats, setStats] = useState<Stats | null>(null);
  const [farms, setFarms] = useState<FarmRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [openCreate, setOpenCreate] = useState(false);
  const [detailFarm, setDetailFarm] = useState<FarmRow | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [editFarm, setEditFarm] = useState<FarmRow | null>(null);
  const [provisionFarm, setProvisionFarm] = useState<{ farm_id: string; name: string } | null>(null);

  const refresh = async () => {
    setLoading(true);
    const [statsRes, farmsRes] = await Promise.all([
      supabase.rpc("platform_overview_stats" as any),
      supabase.rpc("platform_farms_overview" as any),
    ]);
    if (statsRes.error) notify.fail("Plataforma", "Erro ao carregar métricas: " + statsRes.error.message);
    else setStats(statsRes.data as any);
    if (farmsRes.error) notify.fail("Plataforma", "Erro ao carregar fazendas: " + farmsRes.error.message);
    else setFarms((farmsRes.data as any) ?? []);
    setLoading(false);
  };

  useEffect(() => { if (role) void refresh(); }, [role]);

  useEffect(() => {
    if (!detailFarm) { setDetail(null); return; }
    void supabase.rpc("platform_farm_detail" as any, { _farm_id: detailFarm.farm_id })
      .then(({ data, error }) => {
        if (error) notify.fail("Plataforma", error.message);
        else setDetail(data);
      });
  }, [detailFarm]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return farms;
    return farms.filter(f =>
      f.name.toLowerCase().includes(q) ||
      (f.city ?? "").toLowerCase().includes(q) ||
      (f.state ?? "").toLowerCase().includes(q)
    );
  }, [farms, search]);

  if (roleLoading) return <div className="p-8 text-center text-muted-foreground">Verificando acesso…</div>;
  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="w-6 h-6 text-primary" />
            Painel da Plataforma
          </h1>
          <p className="text-sm text-muted-foreground">
            Gestão central de todas as fazendas Renov · {role === "admin" ? "Administrador" : "Suporte (somente leitura)"}
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <PlatformFarmSwitcher />
          <PlatformDemoMenu />
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Atualizar
          </Button>
          {isAdmin && (
            <Button size="sm" onClick={() => setOpenCreate(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Nova fazenda
            </Button>
          )}
        </div>
      </div>

      <Tabs defaultValue="farms" className="w-full min-w-0">
        <TabsList className="!grid grid-cols-2 w-full !h-auto gap-1 sm:!inline-flex sm:w-auto sm:flex-wrap sm:justify-start [&>*]:min-w-0 [&>*]:whitespace-normal [&>*]:text-center">
          <TabsTrigger value="farms"><Building2 className="w-4 h-4 mr-1.5" />Fazendas</TabsTrigger>
          <TabsTrigger value="alerts"><Bell className="w-4 h-4 mr-1.5" />Alertas</TabsTrigger>
          <TabsTrigger value="reports"><FileText className="w-4 h-4 mr-1.5" />Relatórios</TabsTrigger>
          <TabsTrigger value="remote"><Power className="w-4 h-4 mr-1.5" />Controle remoto</TabsTrigger>
          <TabsTrigger value="devices"><ShieldCheck className="w-4 h-4 mr-1.5" />Dispositivos &amp; Licenças</TabsTrigger>
          <TabsTrigger value="updates"><Rocket className="w-4 h-4 mr-1.5" />Atualizações</TabsTrigger>
          <TabsTrigger value="users"><Users className="w-4 h-4 mr-1.5" />Usuários</TabsTrigger>
          {isAdmin && <TabsTrigger value="master_managers"><Crown className="w-4 h-4 mr-1.5" />Gestores Master</TabsTrigger>}
          <TabsTrigger value="technicians"><Wrench className="w-4 h-4 mr-1.5" />Técnicos</TabsTrigger>
          <TabsTrigger value="backups"><Database className="w-4 h-4 mr-1.5" />Backups</TabsTrigger>
          <TabsTrigger value="timings"><Timer className="w-4 h-4 mr-1.5" />Tempos</TabsTrigger>
          <TabsTrigger value="agent_cfg"><Plug className="w-4 h-4 mr-1.5" />Agente (porta/timers)</TabsTrigger>
          {isAdmin && <TabsTrigger value="service"><Wrench className="w-4 h-4 mr-1.5" />Modo Serviço</TabsTrigger>}
          {isAdmin && <TabsTrigger value="maintenance"><Wrench className="w-4 h-4 mr-1.5" />Manutenção</TabsTrigger>}
        </TabsList>

        <TabsContent value="timings" className="mt-4">
          <PlatformTimings isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="agent_cfg" className="mt-4">
          <PlatformAgentConfig isAdmin={isAdmin} />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="service" className="mt-4">
            <PlatformServiceMode />
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="maintenance" className="mt-4">
            <PlatformMaintenance isAdmin={isAdmin} />
          </TabsContent>
        )}

        <TabsContent value="farms" className="space-y-6 mt-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
        <StatCard icon={Building2} label="Fazendas" value={stats?.total_farms ?? "—"} hint={`${stats?.farms_pro ?? 0} Pro · ${stats?.farms_lite ?? 0} Lite`} />
        <StatCard icon={CheckCircle2} label="Agentes online" value={stats?.agents_online ?? "—"} tone="success" hint="Heartbeat < 5 min" />
        <StatCard icon={XCircle} label="Agentes offline" value={stats?.agents_offline ?? "—"} tone="danger" />
        <StatCard icon={Cpu} label="Equipamentos" value={stats?.total_equipments ?? "—"} />
        <StatCard icon={Users} label="Usuários" value={stats?.total_users ?? "—"} />
        <StatCard icon={Pause} label="Suspensas" value={stats?.farms_suspended ?? "—"} tone="warning" hint="Sem licença" />
        <StatCard icon={Activity} label="Comandos pendentes" value={stats?.pending_commands ?? "—"} />
      </div>

      {/* Lista de fazendas */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-base">Fazendas cadastradas</CardTitle>
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Buscar por nome, cidade…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fazenda</TableHead>
                  <TableHead>Local</TableHead>
                  <TableHead>Plano</TableHead>
                  <TableHead>Licença</TableHead>
                  <TableHead>Agente</TableHead>
                  <TableHead className="text-center">Equip.</TableHead>
                  <TableHead className="text-center">Usuários</TableHead>
                  <TableHead className="text-center">Fila</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    {loading ? "Carregando…" : "Nenhuma fazenda encontrada."}
                  </TableCell></TableRow>
                )}
                {filtered.map(f => {
                  const online = f.last_heartbeat && (Date.now() - new Date(f.last_heartbeat).getTime() < 5 * 60_000);
                  const suspended = !f.license_key;
                  return (
                    <TableRow key={f.farm_id} className={suspended ? "opacity-60" : ""}>
                      <TableCell>
                        <div className="font-medium">{f.name}</div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(f.farm_id);
                            notify.ok("Plataforma", "Farm ID copiado!");
                          }}
                          title={`Farm ID: ${f.farm_id}\nClique para copiar`}
                          className="group inline-flex items-center gap-1 text-[10px] text-muted-foreground font-mono hover:text-foreground transition-colors"
                        >
                          <span className="select-all">{f.farm_id}</span>
                          <Copy className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100" />
                        </button>
                      </TableCell>
                      <TableCell className="text-sm">
                        {f.city ? `${f.city}${f.state ? "/" + f.state : ""}` : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={f.plan === "pro" ? "default" : "secondary"} className="uppercase">{f.plan}</Badge>
                        {suspended && <Badge variant="destructive" className="ml-1 text-[9px]">SUSP.</Badge>}
                      </TableCell>
                      <TableCell>
                        {f.license_key ? (
                          <div className="flex items-center gap-1.5">
                            <code className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono select-all">
                              {f.license_key}
                            </code>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0"
                              title="Copiar licença"
                              onClick={() => {
                                navigator.clipboard.writeText(f.license_key!);
                                notify.ok("Plataforma", "Licença copiada — cole no Electron do cliente");
                              }}
                            >
                              <Copy className="w-3 h-3" />
                            </Button>
                          </div>
                        ) : (
                          <span className="text-[10px] text-destructive uppercase font-semibold">sem licença</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {online ? (
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                            Online
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="w-2 h-2 rounded-full bg-muted-foreground/40" />
                            Offline
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">{f.equipments_count}</TableCell>
                      <TableCell className="text-center">{f.users_count}</TableCell>
                      <TableCell className="text-center">
                        {f.pending_commands > 0
                          ? <Badge variant="outline">{f.pending_commands}</Badge>
                          : <span className="text-muted-foreground">0</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => setDetailFarm(f)} title="Detalhes">
                          <Eye className="w-4 h-4" />
                        </Button>
                        {isAdmin && f.license_key && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setProvisionFarm({ farm_id: f.farm_id, name: f.name })}
                            title="Gerar provisioning.json (instalação automática)"
                          >
                            <FileJson className="w-4 h-4 text-emerald-500" />
                          </Button>
                        )}
                        {isAdmin && (
                          <Button variant="ghost" size="sm" onClick={() => setEditFarm(f)} title="Editar">
                            <KeyRound className="w-4 h-4" />
                          </Button>
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
        </TabsContent>

        <TabsContent value="alerts" className="mt-4">
          <PlatformAlerts isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="reports" className="mt-4">
          <PlatformReports isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="remote" className="mt-4">
          <PlatformRemoteControl isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="devices" className="mt-4">
          <PlatformDevices isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="updates" className="mt-4">
          <PlatformUpdates />
        </TabsContent>

        <TabsContent value="users" className="mt-4">
          <PlatformUsers isAdmin={isAdmin} />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="master_managers" className="mt-4">
            <PlatformMasterManagers isAdmin={isAdmin} />
          </TabsContent>
        )}

        <TabsContent value="technicians" className="mt-4">
          <PlatformTechnicians isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="backups" className="mt-4">
          <PlatformBackups isAdmin={isAdmin} />
        </TabsContent>
      </Tabs>

      <CreateFarmDialog open={openCreate} onClose={() => setOpenCreate(false)} onCreated={refresh} />
      <FarmDetailDialog farm={detailFarm} detail={detail} onClose={() => setDetailFarm(null)} />
      <EditFarmDialog farm={editFarm} onClose={() => setEditFarm(null)} onSaved={refresh} />
      <ProvisioningDialog farm={provisionFarm} onClose={() => setProvisionFarm(null)} />
    </div>
  );
}

function CreateFarmDialog({ open, onClose, onCreated }: any) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [plan, setPlan] = useState("lite");
  const [alertPhone, setAlertPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    name: string;
    license: string;
    ownerEmail?: string;
    ownerPassword?: string;
    userCreated?: boolean;
  } | null>(null);

  const reset = () => {
    setName(""); setEmail(""); setFullName(""); setPassword("");
    setCity(""); setState(""); setPlan("lite"); setAlertPhone(""); setCreated(null);
  };


  const callCreateFarm = async (farmName: string) =>
    supabase.rpc("platform_create_farm_full" as any, {
      _name: farmName,
      _owner_email: email.trim(),
      _city: city.trim() || null,
      _state: state.trim() || null,
      _plan: plan,
    });

  const submit = async () => {
    if (!name.trim() || !email.trim()) {
      notify.fail("Plataforma", "Informe nome da fazenda e email do dono.");
      return;
    }
    const phoneDigits = alertPhone.replace(/\D/g, "");
    if (phoneDigits.length < 10) {
      notify.fail("Plataforma", "Informe um número WhatsApp válido para alertas (com DDD).");
      return;
    }
    if (password && password.length < 8) {
      notify.fail("Plataforma", "Senha provisória precisa ter ao menos 8 caracteres.");
      return;
    }
    setBusy(true);

    const farmName = name.trim();
    let userCreated = false;
    let provisionalPassword: string | undefined;

    // 1ª tentativa: criar fazenda direto
    let { data, error } = await callCreateFarm(farmName);

    // Se o usuário não existe, cria automaticamente via edge function e tenta de novo
    if (error && error.message.includes("usuario_owner_nao_encontrado")) {
      const { data: userRes, error: userErr } = await supabase.functions.invoke(
        "platform-user-admin",
        {
          body: {
            action: "invite",
            email: email.trim().toLowerCase(),
            full_name: fullName.trim() || null,
            password: password || undefined,
          },
        },
      );
      if (userErr || !(userRes as any)?.ok) {
        setBusy(false);
        notify.fail("Plataforma", (userRes as any)?.error || userErr?.message || "Falha ao criar usuário do dono.");
        return;
      }
      userCreated = true;
      provisionalPassword = (userRes as any).provisional_password;
      // Reexecuta criação da fazenda
      const retry = await callCreateFarm(farmName);
      data = retry.data;
      error = retry.error;
    }

    if (error) {
      setBusy(false);
      notify.fail("Plataforma", error.message);
      return;
    }
    // Busca a license_key recém-gerada
    const farmId = data as string;
    const { data: farmData } = await supabase
      .from("farms")
      .select("license_key")
      .eq("id", farmId)
      .maybeSingle();

    // Cadastra o telefone WhatsApp do responsável — OBRIGATÓRIO para alertas.
    try {
      const digits = alertPhone.replace(/\D/g, "");
      const normalized = digits.startsWith("55") ? digits : `55${digits}`;
      const { error: opErr } = await (supabase as any)
        .from("whatsapp_operators")
        .insert({
          farm_id: farmId,
          phone: normalized,
          name: fullName.trim() || email.trim(),
          role: "farm_admin",
          is_active: true,
          receive_alerts: true,
          notification_preference: "default",
        });
      if (opErr) {
        console.error("[create-farm] whatsapp_operators insert failed", opErr);
        notify.fail("Plataforma", "Fazenda criada, mas falhou ao cadastrar telefone de alertas — cadastre manualmente em Integrações → WhatsApp.");
      }
    } catch (e) {
      console.error("[create-farm] whatsapp_operators insert threw", e);
    }

    setBusy(false);
    onCreated?.();

    if (farmData?.license_key) {
      setCreated({
        name: farmName,
        license: farmData.license_key,
        ownerEmail: email.trim().toLowerCase(),
        ownerPassword: provisionalPassword,
        userCreated,
      });
    } else {
      notify.ok("Plataforma", "Fazenda criada!");
      reset();
      onClose();
    }
  };

  const close = () => {
    reset();
    onClose();
  };

  // Tela 2: licença gerada — mostra em destaque para copiar e enviar ao cliente
  if (created) {
    return (
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              Fazenda "{created.name}" criada!
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border-2 border-primary bg-primary/5 p-4 space-y-3">
              <div className="text-[10px] uppercase tracking-wider text-primary font-bold">
                🔑 Chave de licença (envie ao cliente)
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-base font-mono font-bold bg-background border rounded px-3 py-2 select-all break-all">
                  {created.license}
                </code>
                <Button
                  size="lg"
                  onClick={() => {
                    navigator.clipboard.writeText(created.license);
                    notify.ok("Plataforma", "Licença copiada!");
                  }}
                >
                  <Copy className="w-4 h-4 mr-2" />
                  Copiar
                </Button>
              </div>
            </div>

            {created.userCreated && created.ownerPassword && (
              <div className="rounded-lg border-2 border-blue-500 bg-blue-500/5 p-4 space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-blue-600 font-bold">
                  👤 Credenciais do dono (usuário recém-criado)
                </div>
                <div className="text-xs space-y-1">
                  <div><span className="text-muted-foreground">Email:</span> <code className="font-mono select-all">{created.ownerEmail}</code></div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground shrink-0">Senha:</span>
                    <code className="flex-1 font-mono font-bold bg-background border rounded px-2 py-1 select-all break-all">
                      {created.ownerPassword}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        navigator.clipboard.writeText(created.ownerPassword!);
                        notify.ok("Plataforma", "Senha copiada!");
                      }}
                    >
                      <Copy className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
                <div className="text-[10px] text-blue-700 dark:text-blue-400">
                  Envie estas credenciais ao cliente. Ele poderá alterar a senha após o primeiro login.
                </div>
              </div>
            )}

            <div className="rounded-lg bg-muted/50 p-3 space-y-2">
              <div className="text-xs font-semibold">📋 Próximos passos:</div>
              <ol className="text-xs space-y-1 list-decimal list-inside text-muted-foreground">
                <li>Envie a chave acima ao cliente (WhatsApp, e-mail, etc.)</li>
                <li>O cliente instala o agente Electron no PC da fazenda</li>
                <li>No primeiro boot, ele faz login e cola a chave em <strong>Configurações → Licença</strong></li>
                <li>O agente vincula a chave ao hardware daquele PC (anticlone)</li>
                <li>O status da fazenda muda para 🟢 Ativo aqui no painel</li>
              </ol>
            </div>

            <div className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded p-2">
              ⚠️ Esta chave fica vinculada ao primeiro PC que ativar. Se o cliente trocar de máquina,
              use a aba <strong>Dispositivos</strong> para desvincular antes.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { reset(); onClose(); }}>
              Cadastrar outra fazenda
            </Button>
            <Button onClick={close}>Pronto</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Tela 1: formulário
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader><DialogTitle>Cadastrar nova fazenda</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Nome da fazenda *</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Fazenda São João" />
          </div>
          <div>
            <Label>Email do dono *</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="dono@fazenda.com" />
            <p className="text-[11px] text-muted-foreground mt-1">
              Se este email ainda não tiver usuário, ele será criado automaticamente abaixo.
            </p>
          </div>
          <div>

            <Label>WhatsApp para alertas críticos *</Label>
            <Input
              value={alertPhone}
              onChange={e => setAlertPhone(e.target.value)}
              placeholder="(11) 98765-4321"
              inputMode="tel"
            />
            <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">
              ⚠️ Obrigatório — receberá alertas de bomba offline, safety timer, comando não confirmado e outros eventos críticos de segurança. Sem este número, alertas irão apenas para o admin global.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Nome completo do dono</Label>
              <Input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="João da Silva" />
            </div>
            <div>
              <Label>Senha provisória (opcional)</Label>
              <Input
                type="text"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Deixe em branco para gerar"
                autoComplete="new-password"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground -mt-1">
            Se o usuário ainda não existir, criamos com a senha acima (mín. 8 caracteres) ou geramos uma e mostramos no final.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Cidade</Label>
              <Input value={city} onChange={e => setCity(e.target.value)} />
            </div>
            <div>
              <Label>UF</Label>
              <Input value={state} onChange={e => setState(e.target.value)} maxLength={2} />
            </div>
          </div>
          <div>
            <Label>Plano</Label>
            <Select value={plan} onValueChange={setPlan}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="lite">Lite</SelectItem>
                <SelectItem value="pro">Pro</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="text-[11px] text-muted-foreground bg-muted/40 rounded p-2">
            💡 Após criar, uma <strong>chave de licença</strong> será gerada automaticamente para você
            enviar ao cliente colar no agente Electron.
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancelar</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Criando…" : "Criar fazenda"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditFarmDialog({ farm, onClose, onSaved }: { farm: FarmRow | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [plan, setPlan] = useState("lite");
  const [busy, setBusy] = useState(false);
  // Trial / subscription
  const [trialStart, setTrialStart] = useState<string>("");
  const [trialEnd, setTrialEnd] = useState<string>("");
  const [subStatus, setSubStatus] = useState<string>("trial");
  // Módulos disponíveis (visibilidade por fazenda)
  const [modules, setModules] = useState<Record<string, boolean>>({
    energia: false, vazao_consumo: false, niveis: false,
  });
  const [moduleBusy, setModuleBusy] = useState<string | null>(null);

  useEffect(() => {
    if (farm) {
      setName(farm.name); setCity(farm.city ?? ""); setState(farm.state ?? ""); setPlan(farm.plan);
      // fetch trial info
      void supabase.rpc("platform_get_farm_trial" as any, { _farm_id: farm.farm_id })
        .then(({ data }) => {
          const row = Array.isArray(data) ? data[0] : data;
          if (row) {
            setTrialStart(row.trial_start_date ? new Date(row.trial_start_date).toISOString().slice(0, 10) : "");
            setTrialEnd(row.trial_end_date ? new Date(row.trial_end_date).toISOString().slice(0, 10) : "");
            setSubStatus(row.subscription_status ?? "trial");
          }
        });
      // fetch módulos atuais
      void supabase.from("farms").select("modules").eq("id", farm.farm_id).maybeSingle()
        .then(({ data }) => {
          const m = ((data?.modules ?? {}) as Record<string, unknown>);
          setModules({
            energia: m.energia !== false,
            vazao_consumo: m.vazao_consumo !== false,
            niveis: m.niveis !== false,
          });
        });
    }
  }, [farm]);

  const toggleModule = async (key: "energia" | "vazao_consumo" | "niveis", value: boolean) => {
    if (!farm) return;
    setModuleBusy(key);
    const { data, error } = await supabase.rpc("platform_set_farm_modules" as any, {
      _farm_id: farm.farm_id,
      _modules: { [key]: value },
    });
    setModuleBusy(null);
    if (error) return notify.fail("Plataforma", error.message);
    const m = (data ?? {}) as Record<string, unknown>;
    setModules((prev) => ({ ...prev, [key]: (m[key] ?? value) !== false }));
    notify.ok("Plataforma", `Módulo ${value ? "ativado" : "desativado"}.`);
  };

  if (!farm) return null;
  const suspended = !farm.license_key;

  const daysLeft = (() => {
    if (!trialEnd) return null;
    const ms = new Date(trialEnd).getTime() - Date.now();
    return Math.ceil(ms / 86400000);
  })();

  const save = async () => {
    setBusy(true);
    const { error } = await supabase.rpc("platform_update_farm" as any, {
      _farm_id: farm.farm_id, _name: name, _city: city || null, _state: state || null, _plan: plan,
    });
    if (!error) {
      const { error: errT } = await supabase.rpc("platform_set_farm_trial" as any, {
        _farm_id: farm.farm_id,
        _trial_start: trialStart ? new Date(trialStart).toISOString() : null,
        _trial_end: trialEnd ? new Date(trialEnd).toISOString() : null,
        _subscription_status: subStatus,
      });
      if (errT) { setBusy(false); return notify.fail("Plataforma", errT.message); }
    }
    setBusy(false);
    if (error) return notify.fail("Plataforma", error.message);
    notify.ok("Plataforma", "Fazenda atualizada.");
    onSaved(); onClose();
  };

  const regen = async () => {
    if (!confirm("Gerar nova licença? A licença atual será invalidada.")) return;
    const { data, error } = await supabase.rpc("platform_regen_license" as any, { _farm_id: farm.farm_id });
    if (error) return notify.fail("Plataforma", error.message);
    notify.ok("Plataforma", "Nova licença gerada: " + data);
    onSaved();
  };

  const toggleSuspend = async () => {
    const next = !suspended;
    if (next && !confirm("Suspender essa fazenda? O acesso ao sistema será bloqueado.")) return;
    const { error } = await supabase.rpc("platform_set_farm_suspended" as any, {
      _farm_id: farm.farm_id, _suspended: next,
    });
    if (error) return notify.fail("Plataforma", error.message);
    notify.ok("Plataforma", next ? "Fazenda suspensa." : "Fazenda reativada.");
    onSaved(); onClose();
  };



  return (
    <Dialog open={!!farm} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">

        <DialogHeader><DialogTitle>Editar fazenda</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Nome</Label><Input value={name} onChange={e => setName(e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Cidade</Label><Input value={city} onChange={e => setCity(e.target.value)} /></div>
            <div><Label>UF</Label><Input value={state} onChange={e => setState(e.target.value)} maxLength={2} /></div>
          </div>
          <div>
            <Label>Plano</Label>
            <Select value={plan} onValueChange={setPlan}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="lite">Lite</SelectItem>
                <SelectItem value="pro">Pro</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="rounded-lg border p-3 space-y-2">
            <Label className="text-xs uppercase tracking-wider">Licença</Label>
            <div className="flex items-center gap-2">
              <code className="text-xs bg-muted px-2 py-1 rounded flex-1 truncate">
                {farm.license_key ?? "— SUSPENSA —"}
              </code>
              {farm.license_key && (
                <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(farm.license_key!); notify.ok("Plataforma", "Copiado!"); }}>
                  <Copy className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={regen}><KeyRound className="w-3.5 h-3.5 mr-1" />Gerar nova</Button>
              <Button size="sm" variant={suspended ? "default" : "destructive"} onClick={toggleSuspend}>
                {suspended ? <><Play className="w-3.5 h-3.5 mr-1" />Reativar</> : <><Pause className="w-3.5 h-3.5 mr-1" />Suspender</>}
              </Button>
          </div>

          {/* Assinatura / Período de Teste */}
          <div className="rounded-lg border p-3 space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wider">Assinatura / Teste</Label>
              {daysLeft !== null && (
                <Badge variant={daysLeft < 0 ? "destructive" : daysLeft <= 3 ? "secondary" : "outline"}>
                  {daysLeft < 0 ? `Expirado há ${Math.abs(daysLeft)}d` : daysLeft === 0 ? "Expira hoje" : `${daysLeft} dias restantes`}
                </Badge>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Início do teste</Label>
                <Input type="date" value={trialStart} onChange={(e) => setTrialStart(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Fim do teste</Label>
                <Input type="date" value={trialEnd} onChange={(e) => setTrialEnd(e.target.value)} />
              </div>
            </div>
            <div>
              <Label className="text-xs">Status da assinatura</Label>
              <Select value={subStatus} onValueChange={setSubStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="trial">Em teste</SelectItem>
                  <SelectItem value="active">Ativo</SelectItem>
                  <SelectItem value="expired">Expirado</SelectItem>
                  <SelectItem value="cancelled">Cancelado</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Módulos Disponíveis (visibilidade por fazenda) */}
          <div className="rounded-lg border p-3 space-y-3">
            <div>
              <Label className="text-xs uppercase tracking-wider">⚙️ Módulos Disponíveis</Label>
              <p className="text-[11px] text-muted-foreground mt-1">
                Ative ou desative módulos para esta fazenda. Módulos desativados ficam completamente invisíveis para o cliente.
              </p>
            </div>
            {[
              { key: "energia" as const,       title: "Energia",          desc: "Demanda de energia, consumo, horários ponta/fora ponta" },
              { key: "vazao_consumo" as const, title: "Vazão e Consumo",  desc: "Relatório de vazão estimada e consumo de água (m³)" },
              { key: "niveis" as const,        title: "Níveis",           desc: "Monitoramento de nível dos reservatórios" },
            ].map(({ key, title, desc }) => (
              <div key={key} className="flex items-start justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{title}</div>
                  <div className="text-[11px] text-muted-foreground">{desc}</div>
                </div>
                <Switch
                  checked={!!modules[key]}
                  disabled={moduleBusy === key}
                  onCheckedChange={(v) => toggleModule(key, !!v)}
                />
              </div>
            ))}
          </div>
          </div>
        </div>


        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Salvando…" : "Salvar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FarmDetailDialog({ farm, detail, onClose }: any) {
  if (!farm) return null;
  return (
    <Dialog open={!!farm} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{farm.name}</DialogTitle>
          <p className="text-xs text-muted-foreground">{farm.city ?? "—"}{farm.state ? "/" + farm.state : ""} · Plano {farm.plan.toUpperCase()}</p>
        </DialogHeader>
        {!detail ? (
          <div className="text-center text-muted-foreground py-8">Carregando…</div>
        ) : (
          <Tabs defaultValue="equipments">
            <TabsList className="w-full">
              <TabsTrigger value="equipments" className="flex-1">Equipamentos ({detail.equipments?.length ?? 0})</TabsTrigger>
              <TabsTrigger value="users" className="flex-1">Usuários ({detail.users?.length ?? 0})</TabsTrigger>
              <TabsTrigger value="logs" className="flex-1">Logs recentes</TabsTrigger>
              <TabsTrigger value="health" className="flex-1">Agente</TabsTrigger>
            </TabsList>
            <TabsContent value="equipments">
              <Table>
                <TableHeader><TableRow><TableHead>Nome</TableHead><TableHead>Tipo</TableHead><TableHead>HW ID</TableHead><TableHead>Última com.</TableHead></TableRow></TableHeader>
                <TableBody>
                  {detail.equipments?.map((e: any) => (
                    <TableRow key={e.id}>
                      <TableCell>{e.name}</TableCell>
                      <TableCell><Badge variant="outline">{e.type}</Badge></TableCell>
                      <TableCell className="font-mono text-xs">{e.hw_id}</TableCell>
                      <TableCell className="text-xs">{e.last_communication ? new Date(e.last_communication).toLocaleString("pt-BR") : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="users">
              <Table>
                <TableHeader><TableRow><TableHead>Nome</TableHead><TableHead>Email</TableHead><TableHead>Papel</TableHead></TableRow></TableHeader>
                <TableBody>
                  {detail.users?.map((u: any) => (
                    <TableRow key={u.user_id + u.role}>
                      <TableCell>{u.full_name ?? "—"}</TableCell>
                      <TableCell className="text-xs">{u.email ?? "—"}</TableCell>
                      <TableCell><Badge>{u.role}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="logs">
              <div className="space-y-1 text-xs font-mono max-h-96 overflow-y-auto">
                {detail.recent_logs?.length === 0 && <div className="text-muted-foreground text-center py-4">Sem logs.</div>}
                {detail.recent_logs?.map((l: any) => (
                  <div key={l.id} className="border-l-2 border-primary/30 pl-2 py-1">
                    <span className="text-muted-foreground">{new Date(l.created_at).toLocaleString("pt-BR")}</span>
                    {" "}<Badge variant="outline" className="text-[9px] uppercase">{l.level}</Badge>
                    {" "}<span className="text-muted-foreground">[{l.category}]</span>
                    <div>{l.message}</div>
                  </div>
                ))}
              </div>
            </TabsContent>
            <TabsContent value="health">
              {detail.site_health ? (
                <div className="space-y-2 text-sm">
                  <div><strong>Status:</strong> {detail.site_health.agent_status}</div>
                  <div><strong>Última atividade:</strong> {new Date(detail.site_health.last_heartbeat).toLocaleString("pt-BR")}</div>
                  <div><strong>Porta COM:</strong> {detail.site_health.com_port ?? "—"} ({detail.site_health.com_connected ? "conectada" : "desconectada"})</div>
                  <div><strong>Versão agente:</strong> {detail.site_health.agent_version ?? "—"}</div>
                  <div><strong>Uptime:</strong> {detail.site_health.uptime_seconds ?? 0}s</div>
                  {detail.site_health.last_error && <div className="text-destructive"><strong>Último erro:</strong> {detail.site_health.last_error}</div>}
                </div>
              ) : <div className="text-muted-foreground text-center py-4">Agente nunca enviou heartbeat.</div>}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProvisioningDialog({ farm, onClose }: { farm: { farm_id: string; name: string } | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const generate = async () => {
    if (!farm) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("platform_generate_provisioning_token" as any, {
        _farm_id: farm.farm_id,
      });
      if (error) throw error;
      setResult(data);
      notify.ok("Plataforma", "Token de provisionamento gerado");
    } catch (e: any) {
      notify.fail("Plataforma", e.message || "Falha ao gerar token");
    } finally {
      setBusy(false);
    }
  };

  const downloadJson = () => {
    if (!result?.provisioning_json) return;
    const blob = new Blob([JSON.stringify(result.provisioning_json, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `provisioning-${farm?.name?.replace(/\s+/g, "-").toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify.ok("Plataforma", "Arquivo baixado — envie para o cliente");
  };

  const reset = () => { setResult(null); onClose(); };

  return (
    <Dialog open={!!farm} onOpenChange={(o) => !o && reset()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileJson className="w-5 h-5 text-emerald-500" />
            Gerar instalação automática — {farm?.name}
          </DialogTitle>
        </DialogHeader>

        {!result ? (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2 text-sm">
              <p className="font-medium">📦 O que vai acontecer:</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground text-xs leading-relaxed">
                <li>Gera um <strong>token único</strong> válido por 30 dias.</li>
                <li>Você baixa um arquivo <code className="text-emerald-500">provisioning.json</code>.</li>
                <li>Envia esse arquivo para o cliente (WhatsApp/email).</li>
                <li>Cliente coloca na pasta de instalação do agente Renov.</li>
                <li>Agente <strong>ativa sozinho</strong> contra o hardware do PC do cliente.</li>
                <li>Token é consumido — não funciona mais em lugar nenhum.</li>
              </ol>
            </div>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300">
              ⚠️ Esse arquivo é como uma chave: <strong>uso único</strong>. Se vazar e alguém ativar antes do cliente, o token não vale mais e você precisa gerar outro.
            </div>
            <Button onClick={generate} disabled={busy} className="w-full">
              {busy ? "Gerando…" : "Gerar token de provisionamento"}
            </Button>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4 space-y-3">
              <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                <CheckCircle2 className="w-4 h-4" />
                Token criado com sucesso
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase text-muted-foreground">Token (one-shot)</Label>
                <code className="block bg-background border border-border rounded px-3 py-2 font-mono text-sm select-all">
                  {result.token}
                </code>
              </div>
              <div className="text-xs text-muted-foreground">
                Expira em: {new Date(result.expires_at).toLocaleDateString("pt-BR")}
              </div>
            </div>

            <Button onClick={downloadJson} className="w-full" size="lg">
              <Download className="w-4 h-4 mr-2" />
              Baixar provisioning.json
            </Button>

            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs space-y-2">
              <p className="font-medium">📋 Instruções para o cliente:</p>
              <ol className="list-decimal list-inside space-y-0.5 text-muted-foreground">
                <li>Receber o arquivo <code>provisioning.json</code>.</li>
                <li>Instalar o <strong>Gestor de Bombas Renov</strong> normalmente.</li>
                <li>Copiar o arquivo para <code className="text-emerald-400">C:\ProgramData\Renov\</code>.</li>
                <li>Abrir o agente — ele detecta e ativa sozinho.</li>
              </ol>
            </div>

            <Button variant="outline" onClick={reset} className="w-full">Fechar</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
