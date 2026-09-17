import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { notify } from "@/lib/notify";
import { Input } from "@/components/ui/input";
import {
  ShieldCheck, Unlink, Eye, RefreshCw, ShieldAlert, MonitorSmartphone,
  Unlock, History, AlertTriangle, ShieldX, Save, Infinity as InfinityIcon,
} from "lucide-react";

interface FarmLimit {
  id: string;
  name: string;
  max_devices: number | null;
  active_count: number;
}

interface DeviceRow {
  device_id: string;
  farm_id: string;
  farm_name: string;
  machine_id_hash: string;
  agent_version: string | null;
  ip_address: string | null;
  activated_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  fingerprint: any;
  is_online: boolean;
}

interface TamperRow {
  id: string;
  farm_id: string;
  kind: string;
  level: "info" | "warn" | "critical";
  details: any;
  reported_at: string;
  acknowledged_at: string | null;
  agent_version: string | null;
}

interface HardwareRow {
  farm_id: string;
  alert_level: string;
  changed_components: string[];
  last_check_at: string;
}

interface Props { isAdmin: boolean; }

const KIND_LABEL: Record<string, string> = {
  asar_modified: "ASAR adulterado",
  hardware_changed: "Hardware alterado",
  config_replaced: "Config substituída / licença",
  integrity_check_failed: "Update rejeitado (hash inválido)",
  unsigned_binary: "Código não-ofuscado",
  other: "Outro",
};

export default function PlatformDevices({ isAdmin }: Props) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [tampers, setTampers] = useState<TamperRow[]>([]);
  const [hardware, setHardware] = useState<Record<string, HardwareRow>>({});
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<DeviceRow | null>(null);
  const [historyFarm, setHistoryFarm] = useState<DeviceRow | null>(null);
  const [deviceAuthEnabled, setDeviceAuthEnabled] = useState<boolean>(true);
  const [deviceAuthTargeted, setDeviceAuthTargeted] = useState<boolean>(false);
  const [savingSetting, setSavingSetting] = useState(false);
  const [farmLimits, setFarmLimits] = useState<FarmLimit[]>([]);
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({});
  const [savingFarmId, setSavingFarmId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    const [devRes, tampRes, hwRes, settingRes, farmsRes, licRes] = await Promise.all([
      supabase.rpc("platform_get_devices_overview" as any),
      supabase.from("tampering_events")
        .select("id, farm_id, kind, level, details, reported_at, acknowledged_at, agent_version")
        .order("reported_at", { ascending: false })
        .limit(500),
      supabase.from("agent_hardware")
        .select("farm_id, alert_level, changed_components, last_check_at"),
      supabase.from("platform_settings").select("value").eq("key", "device_auth").maybeSingle(),
      supabase.from("farms").select("id, name, max_devices" as any).order("name"),
      supabase.from("device_licenses").select("farm_id, revoked_at"),
    ]);
    if (devRes.error) notify.fail("Dispositivos", "Erro: " + devRes.error.message);
    else setDevices((devRes.data as any) ?? []);
    setTampers(((tampRes.data as any) ?? []) as TamperRow[]);
    const hwMap: Record<string, HardwareRow> = {};
    for (const r of ((hwRes.data as any) ?? []) as HardwareRow[]) hwMap[r.farm_id] = r;
    setHardware(hwMap);
    const deviceAuthValue = (((settingRes.data as any)?.value as any) ?? {});
    setDeviceAuthEnabled(deviceAuthValue.enabled === true);
    setDeviceAuthTargeted(
      (Array.isArray(deviceAuthValue.farm_ids) && deviceAuthValue.farm_ids.length > 0) ||
      (Array.isArray(deviceAuthValue.user_ids) && deviceAuthValue.user_ids.length > 0)
    );

    const activeByFarm: Record<string, number> = {};
    for (const r of ((licRes.data as any) ?? []) as { farm_id: string; revoked_at: string | null }[]) {
      if (!r.revoked_at) activeByFarm[r.farm_id] = (activeByFarm[r.farm_id] ?? 0) + 1;
    }
    const farmsArr = (((farmsRes.data as any) ?? []) as { id: string; name: string; max_devices: number | null }[])
      .map(f => ({ id: f.id, name: f.name, max_devices: f.max_devices ?? null, active_count: activeByFarm[f.id] ?? 0 }));
    setFarmLimits(farmsArr);
    setLimitDrafts(Object.fromEntries(farmsArr.map(f => [f.id, f.max_devices != null ? String(f.max_devices) : ""])));

    setLoading(false);
  };


  useEffect(() => {
    void refresh();
    // Realtime: novo evento de tampering → toast + refresh
    const ch = supabase
      .channel("platform-tampering")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "tampering_events" },
        (payload) => {
          const ev = payload.new as any;
          const farm = devices.find(d => d.farm_id === ev.farm_id)?.farm_name || "Fazenda";
          const label = KIND_LABEL[ev.kind] || ev.kind;
          if (ev.level === "critical") notify.fail(farm, `[Segurança] ${label}`);
          else notify.warn(farm, `[Segurança] ${label}`);
          void refresh();
        })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleDeviceAuth = async (next: boolean) => {
    if (!isAdmin) return;
    if (!next && !confirm(
      "DESATIVAR a autorização por dispositivo?\n\n" +
      "Qualquer usuário poderá entrar de QUALQUER computador ou celular usando apenas email e senha. " +
      "O bloqueio anticlone do Electron continua valendo, mas o acesso pelo interface web fica liberado.\n\n" +
      "Confirma?"
    )) return;
    setSavingSetting(true);
    const { error } = await supabase
      .from("platform_settings")
      .upsert({ key: "device_auth", value: { enabled: next }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    setSavingSetting(false);
    if (error) return notify.fail("Dispositivos", error.message);
    setDeviceAuthEnabled(next);
    notify.ok("Dispositivos", next ? "Autorização por dispositivo ATIVADA" : "Autorização por dispositivo DESATIVADA — acesso liberado por email/senha");
  };

  const unbind = async (d: DeviceRow) => {
    if (!confirm(
      `Desvincular o PC da fazenda "${d.farm_name}"?\n\n` +
      `O Electron vai parar de funcionar nesse computador. ` +
      `O cliente poderá reativar a licença em outro PC depois.`
    )) return;
    const { error } = await supabase.rpc("platform_unbind_device" as any, {
      _device_id: d.device_id, _reason: "admin_unbind",
    });
    if (error) return notify.fail("Dispositivos", error.message);
    notify.ok("Dispositivos", "Dispositivo desvinculado. Cliente pode ativar em outro PC.");
    void refresh();
  };

  const saveFarmLimit = async (farmId: string) => {
    if (!isAdmin) return;
    const raw = (limitDrafts[farmId] ?? "").trim();
    const parsed = raw === "" ? null : Number(raw);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed))) {
      return notify.fail("Limite por fazenda", "Informe um número inteiro ≥ 0 ou deixe vazio.");
    }
    setSavingFarmId(farmId);
    const { error } = await supabase
      .from("farms")
      .update({ max_devices: parsed } as any)
      .eq("id", farmId);
    setSavingFarmId(null);
    if (error) return notify.fail("Limite por fazenda", error.message);
    setFarmLimits(prev => prev.map(f => f.id === farmId ? { ...f, max_devices: parsed } : f));
    notify.ok("Limite por fazenda", parsed == null || parsed === 0 ? "Limite removido (ilimitado)." : `Limite salvo: ${parsed}.`);
  };

  // Badges de segurança calculados por dispositivo
  function securityBadgesFor(d: DeviceRow) {
    const out: { label: string; tone: "danger" | "warn" }[] = [];
    if (d.revoked_at) out.push({ label: "Licença revogada", tone: "danger" });
    const hw = hardware[d.farm_id];
    if (hw?.alert_level === "blocked") out.push({ label: "Máquina não autorizada", tone: "danger" });
    else if (hw?.alert_level === "warning") out.push({ label: "Hardware alterado", tone: "warn" });
    const farmTampers = tampers.filter(t =>
      t.farm_id === d.farm_id && !t.acknowledged_at &&
      Date.now() - new Date(t.reported_at).getTime() < 7 * 24 * 3600 * 1000
    );
    if (farmTampers.some(t => t.kind === "unsigned_binary"))
      out.push({ label: "Código não-ofuscado", tone: "warn" });
    if (farmTampers.some(t => t.kind === "integrity_check_failed"))
      out.push({ label: "Update rejeitado (hash inválido)", tone: "warn" });
    return out;
  }

  const active = devices.filter(d => !d.revoked_at);
  const revoked = devices.filter(d => d.revoked_at);
  const online = active.filter(d => d.is_online).length;
  const criticalUnack = tampers.filter(t => !t.acknowledged_at && t.level === "critical").length;
  const farmHistory = historyFarm
    ? tampers.filter(t => t.farm_id === historyFarm.farm_id)
    : [];

  return (
    <div className="space-y-4">
      <Card className={deviceAuthEnabled || deviceAuthTargeted ? "" : "border-amber-500/50 bg-amber-500/5"}>
        <CardContent className="p-4 flex items-start gap-4">
            <div className={`shrink-0 rounded-lg p-2.5 ${deviceAuthEnabled || deviceAuthTargeted ? "bg-primary/10" : "bg-amber-500/10"}`}>
              {deviceAuthEnabled || deviceAuthTargeted ? <ShieldCheck className="w-6 h-6 text-primary" /> : <Unlock className="w-6 h-6 text-amber-500" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold">Autorização por dispositivo</span>
              {deviceAuthEnabled
                ? <Badge className="bg-green-600 hover:bg-green-700">Ativada</Badge>
                : deviceAuthTargeted
                  ? <Badge className="bg-green-600 hover:bg-green-700">Parcial</Badge>
                : <Badge variant="outline" className="border-amber-500 text-amber-600">Desativada</Badge>}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {deviceAuthEnabled
                ? "Cada usuário precisa autorizar o computador/celular antes de acessar o interface web."
                : deviceAuthTargeted
                  ? "Autorização por dispositivo ativa apenas para fazendas/usuários selecionados."
                : "Qualquer dispositivo é permitido — usuários entram só com email e senha. (O bloqueio anticlone do Electron continua valendo.)"}
            </p>
          </div>
          <Switch
            checked={deviceAuthEnabled}
            onCheckedChange={toggleDeviceAuth}
            disabled={!isAdmin || savingSetting}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <MonitorSmartphone className="w-4 h-4 text-primary" />
            Limites por Fazenda
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Defina o número máximo de dispositivos (Electron) permitidos por fazenda. Deixe vazio para ilimitado.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fazenda</TableHead>
                  <TableHead className="w-[160px]">Dispositivos Ativos</TableHead>
                  <TableHead className="w-[160px]">Limite Máx.</TableHead>
                  <TableHead className="text-right w-[120px]">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {farmLimits.length === 0 && (
                  <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                    {loading ? "Carregando…" : "Nenhuma fazenda encontrada."}
                  </TableCell></TableRow>
                )}
                {farmLimits.map(f => {
                  const limit = f.max_devices ?? 0;
                  const hasLimit = limit > 0;
                  const atLimit = hasLimit && f.active_count >= limit;
                  const draft = limitDrafts[f.id] ?? "";
                  const dirty = (draft.trim() === "" ? null : Number(draft)) !== (f.max_devices ?? null);
                  return (
                    <TableRow key={f.id}>
                      <TableCell className="font-medium">{f.name}</TableCell>
                      <TableCell>
                        {hasLimit ? (
                          <Badge className={atLimit ? "bg-destructive hover:bg-destructive" : "bg-green-600 hover:bg-green-700"}>
                            {f.active_count}/{limit}
                            {atLimit && " • Limite atingido"}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="gap-1">
                            {f.active_count} <InfinityIcon className="w-3 h-3" />
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          placeholder="∞"
                          value={draft}
                          disabled={!isAdmin}
                          onChange={(e) => setLimitDrafts(prev => ({ ...prev, [f.id]: e.target.value }))}
                          className="h-8 w-24"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant={dirty ? "default" : "outline"}
                          disabled={!isAdmin || !dirty || savingFarmId === f.id}
                          onClick={() => saveFarmLimit(f.id)}
                        >
                          <Save className="w-3.5 h-3.5 mr-1" />
                          Salvar
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>



      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <ShieldCheck className="w-8 h-8 text-green-600" />
            <div>
              <div className="text-[11px] uppercase text-muted-foreground">Ativos</div>
              <div className="text-2xl font-bold">{active.length}</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <MonitorSmartphone className="w-8 h-8 text-primary" />
            <div>
              <div className="text-[11px] uppercase text-muted-foreground">Online agora</div>
              <div className="text-2xl font-bold">{online}</div>
              <div className="text-[10px] text-muted-foreground">Heartbeat &lt; 2h</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <ShieldAlert className="w-8 h-8 text-destructive" />
            <div>
              <div className="text-[11px] uppercase text-muted-foreground">Revogados</div>
              <div className="text-2xl font-bold">{revoked.length}</div>
            </div>
          </CardContent>
        </Card>
        <Card className={criticalUnack > 0 ? "border-destructive/60 bg-destructive/5" : ""}>
          <CardContent className="p-4 flex items-center gap-3">
            <ShieldX className={`w-8 h-8 ${criticalUnack > 0 ? "text-destructive" : "text-muted-foreground"}`} />
            <div>
              <div className="text-[11px] uppercase text-muted-foreground">Alertas críticos</div>
              <div className="text-2xl font-bold">{criticalUnack}</div>
              <div className="text-[10px] text-muted-foreground">Não-confirmados</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-center">
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
              Atualizar
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" />
            Dispositivos licenciados
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Cada licença está vinculada a UM PC físico (anticlone). Badges vermelhos indicam bloqueio crítico;
            amarelos são alertas que ainda permitem operação.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fazenda</TableHead>
                  <TableHead>Hash do hardware</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Segurança</TableHead>
                  <TableHead>Última conexão</TableHead>
                  <TableHead>Versão</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    {loading ? "Carregando…" : "Nenhum dispositivo ativado ainda."}
                  </TableCell></TableRow>
                )}
                {devices.map(d => {
                  const sec = securityBadgesFor(d);
                  return (
                    <TableRow key={d.device_id} className={d.revoked_at ? "opacity-60" : ""}>
                      <TableCell>
                        <div className="font-medium flex items-center gap-1.5 flex-wrap">
                          {d.farm_name}
                          {(() => {
                            const fl = farmLimits.find(f => f.id === d.farm_id);
                            if (!fl) return null;
                            const lim = fl.max_devices ?? 0;
                            if (lim <= 0) return null;
                            const atLimit = fl.active_count >= lim;
                            return (
                              <Badge
                                variant={atLimit ? "destructive" : "outline"}
                                className={atLimit ? "" : "border-green-600/40 text-green-700"}
                              >
                                {atLimit ? "Limite atingido" : `${fl.active_count}/${lim}`}
                              </Badge>
                            );
                          })()}
                        </div>
                        <div className="text-[10px] text-muted-foreground font-mono">{d.farm_id.slice(0, 8)}…</div>
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">{d.machine_id_hash.slice(0, 16)}…</TableCell>
                      <TableCell>
                        {d.revoked_at ? (
                          <Badge variant="destructive">Revogado</Badge>
                        ) : d.is_online ? (
                          <Badge className="bg-green-600 hover:bg-green-700">Online</Badge>
                        ) : (
                          <Badge variant="secondary">Offline</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1 max-w-[260px]">
                          {sec.length === 0 ? (
                            <Badge variant="outline" className="border-green-600/40 text-green-700">OK</Badge>
                          ) : sec.map((b, i) => (
                            <Badge key={i} variant={b.tone === "danger" ? "destructive" : "outline"}
                              className={b.tone === "warn" ? "border-amber-500 text-amber-600" : ""}>
                              <AlertTriangle className="w-3 h-3 mr-1" />
                              {b.label}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">{new Date(d.last_seen_at).toLocaleString("pt-BR")}</TableCell>
                      <TableCell className="text-xs">{d.agent_version ?? "—"}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <Button variant="ghost" size="sm" onClick={() => setHistoryFarm(d)} title="Histórico de segurança">
                          <History className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDetail(d)}>
                          <Eye className="w-4 h-4" />
                        </Button>
                        {isAdmin && !d.revoked_at && (
                          <Button variant="ghost" size="sm" onClick={() => unbind(d)} title="Desvincular">
                            <Unlink className="w-4 h-4 text-destructive" />
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

      <Dialog open={!!detail} onOpenChange={() => setDetail(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Detalhes do dispositivo</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-2 text-sm">
              <div><strong>Fazenda:</strong> {detail.farm_name}</div>
              <div><strong>IP:</strong> <span className="font-mono">{detail.ip_address ?? "—"}</span></div>
              <div><strong>Ativado em:</strong> {new Date(detail.activated_at).toLocaleString("pt-BR")}</div>
              <div><strong>Hash completo:</strong></div>
              <code className="block text-[10px] bg-muted p-2 rounded break-all">{detail.machine_id_hash}</code>
              <div><strong>Fingerprint:</strong></div>
              <pre className="text-[10px] bg-muted p-2 rounded overflow-auto max-h-48">
                {JSON.stringify(detail.fingerprint, null, 2)}
              </pre>
              {detail.revoked_at && (
                <div className="text-destructive">
                  <strong>Revogado em:</strong> {new Date(detail.revoked_at).toLocaleString("pt-BR")}<br />
                  <strong>Motivo:</strong> {detail.revoked_reason ?? "—"}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!historyFarm} onOpenChange={() => setHistoryFarm(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="w-4 h-4" />
              Histórico de Segurança — {historyFarm?.farm_name}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            {farmHistory.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">
                Nenhum evento de segurança registrado.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Quando</TableHead>
                    <TableHead>Evento</TableHead>
                    <TableHead>Severidade</TableHead>
                    <TableHead>Versão</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {farmHistory.map(t => (
                    <TableRow key={t.id}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {new Date(t.reported_at).toLocaleString("pt-BR")}
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="font-medium">{KIND_LABEL[t.kind] || t.kind}</div>
                        {t.details?.reason && (
                          <div className="text-[10px] text-muted-foreground font-mono">{String(t.details.reason)}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        {t.level === "critical" ? (
                          <Badge variant="destructive">Crítico</Badge>
                        ) : t.level === "warn" ? (
                          <Badge variant="outline" className="border-amber-500 text-amber-600">Aviso</Badge>
                        ) : (
                          <Badge variant="secondary">Info</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{t.agent_version ?? "—"}</TableCell>
                      <TableCell>
                        {t.acknowledged_at ? (
                          <Badge variant="outline">Confirmado</Badge>
                        ) : (
                          <Badge className="bg-orange-600 hover:bg-orange-700">Pendente</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryFarm(null)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
