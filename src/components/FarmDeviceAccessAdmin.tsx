// Gerencia o fluxo manual de aprovação de dispositivos por IP + fazenda:
// 1) Solicitações pendentes (aprovar/rejeitar)
// 2) Dispositivos autorizados (revogar)
// 3) Toggle da proteção IP por fazenda
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Globe, ShieldAlert, Trash2, Check, X, Monitor, Smartphone } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { notify } from "@/lib/notify";

interface Farm { id: string; name: string; ip_restriction_enabled?: boolean | null; }
interface Request {
  id: string; farm_id: string; user_id: string | null; user_email: string;
  ip_address: string; user_agent: string | null; os: string | null;
  browser: string | null; platform: string | null; status: string; created_at: string;
}
interface ApprovedDevice {
  id: string; farm_id: string; ip_address: string; user_email: string | null;
  os: string | null; browser: string | null; platform: string | null;
  approved_at: string; approved_by: string | null;
}

const fmt = (d: string) => new Date(d).toLocaleString("pt-BR");

export default function FarmDeviceAccessAdmin({ farms, onChanged }: { farms: Farm[]; onChanged?: () => void }) {
  const { user } = useAuth();
  const [requests, setRequests] = useState<Request[]>([]);
  const [devices, setDevices] = useState<ApprovedDevice[]>([]);
  const [loading, setLoading] = useState(true);

  const farmName = (id: string) => farms.find(f => f.id === id)?.name ?? "—";

  const reload = async () => {
    setLoading(true);
    const [{ data: r }, { data: d }] = await Promise.all([
      supabase.from("farm_access_requests" as any).select("*").eq("status", "pending").order("created_at", { ascending: false }),
      supabase.from("farm_approved_devices" as any).select("*").order("approved_at", { ascending: false }),
    ]);
    setRequests((r as any) ?? []);
    setDevices((d as any) ?? []);
    setLoading(false);
  };
  useEffect(() => { void reload(); }, []);

  const pendingCount = requests.length;

  const approve = async (req: Request) => {
    // Adiciona à lista de aprovados
    const { error: e1 } = await supabase.from("farm_approved_devices" as any).insert({
      farm_id: req.farm_id, ip_address: req.ip_address, user_email: req.user_email,
      user_agent: req.user_agent, os: req.os, browser: req.browser, platform: req.platform,
      approved_by: user?.id,
    } as any);
    if (e1 && !/duplicate/i.test(e1.message)) return notify.fail("Aprovação", e1.message);
    // Atualiza a solicitação
    const { error: e2 } = await supabase.from("farm_access_requests" as any)
      .update({ status: "approved", reviewed_at: new Date().toISOString(), reviewed_by: user?.id } as any)
      .eq("id", req.id);
    if (e2) return notify.fail("Aprovação", e2.message);
    notify.ok("Dispositivo aprovado", `${req.user_email} • ${req.ip_address}`);
    void reload(); onChanged?.();
  };

  const reject = async (req: Request) => {
    if (!confirm(`Rejeitar acesso de ${req.user_email} (${req.ip_address})?`)) return;
    const { error } = await supabase.from("farm_access_requests" as any)
      .update({ status: "rejected", reviewed_at: new Date().toISOString(), reviewed_by: user?.id } as any)
      .eq("id", req.id);
    if (error) return notify.fail("Rejeitar", error.message);
    try {
      await supabase.from("device_audit_log").insert({
        action: "ip_rejected", actor_id: user?.id, target_user_id: req.user_id ?? undefined,
        farm_id: req.farm_id, details: { ip: req.ip_address, email: req.user_email },
      } as any);
    } catch { /* ignore */ }
    notify.ok("Solicitação rejeitada", req.ip_address);
    void reload();
  };

  const revoke = async (dev: ApprovedDevice) => {
    if (!confirm(`Revogar acesso do IP ${dev.ip_address} para ${farmName(dev.farm_id)}?`)) return;
    const { error } = await supabase.from("farm_approved_devices" as any).delete().eq("id", dev.id);
    if (error) return notify.fail("Revogar", error.message);
    notify.ok("Acesso revogado", dev.ip_address);
    void reload();
  };

  const toggleFarm = async (farm: Farm, enabled: boolean) => {
    const { error } = await supabase.from("farms").update({ ip_restriction_enabled: enabled } as any).eq("id", farm.id);
    if (error) return notify.fail("Proteção IP", error.message);
    notify.ok("Proteção IP", enabled ? `Ativada para ${farm.name}` : `Desativada para ${farm.name}`);
    onChanged?.();
  };

  const devicesGrouped = useMemo(() => {
    const map = new Map<string, ApprovedDevice[]>();
    for (const d of devices) {
      if (!map.has(d.farm_id)) map.set(d.farm_id, []);
      map.get(d.farm_id)!.push(d);
    }
    return map;
  }, [devices]);

  return (
    <div className="space-y-4">
      {/* Solicitações pendentes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-destructive" />
            Solicitações de Acesso Pendentes
            {pendingCount > 0 && <Badge variant="destructive" className="ml-2">{pendingCount}</Badge>}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Novos dispositivos tentando acessar fazendas com proteção IP ativada.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fazenda</TableHead>
                <TableHead>Usuário</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Navegador</TableHead>
                <TableHead>SO</TableHead>
                <TableHead>Data</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">
                  Nenhuma solicitação pendente 🎉
                </TableCell></TableRow>
              )}
              {requests.map(req => (
                <TableRow key={req.id}>
                  <TableCell className="font-medium">{farmName(req.farm_id)}</TableCell>
                  <TableCell className="text-sm">{req.user_email}</TableCell>
                  <TableCell><code className="text-xs font-mono">{req.ip_address}</code></TableCell>
                  <TableCell className="text-xs">{req.browser ?? "—"}</TableCell>
                  <TableCell className="text-xs">{req.os ?? "—"}</TableCell>
                  <TableCell className="text-xs">{fmt(req.created_at)}</TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button size="sm" variant="outline" onClick={() => approve(req)} className="gap-1">
                      <Check className="w-4 h-4" /> Aprovar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => reject(req)} className="gap-1">
                      <X className="w-4 h-4" /> Rejeitar
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Dispositivos autorizados */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" /> Dispositivos Autorizados por Fazenda
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fazenda</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Usuário</TableHead>
                <TableHead>Navegador</TableHead>
                <TableHead>SO</TableHead>
                <TableHead>Aprovado em</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">
                  Nenhum dispositivo autorizado ainda.
                </TableCell></TableRow>
              )}
              {devices.map(d => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{farmName(d.farm_id)}</TableCell>
                  <TableCell><code className="text-xs font-mono">{d.ip_address}</code></TableCell>
                  <TableCell className="text-xs">{d.user_email ?? "—"}</TableCell>
                  <TableCell className="text-xs">{d.browser ?? "—"}</TableCell>
                  <TableCell className="text-xs">
                    <span className="inline-flex items-center gap-1">
                      {d.platform === "Mobile" ? <Smartphone className="w-3 h-3" /> : <Monitor className="w-3 h-3" />}
                      {d.os ?? "—"}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">{fmt(d.approved_at)}</TableCell>
                  <TableCell className="text-right">
                    <Button size="icon" variant="ghost" onClick={() => revoke(d)} title="Revogar">
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Toggle por fazenda */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" /> Proteção IP por Fazenda
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Quando ativado, apenas dispositivos aprovados manualmente conseguem acessar a fazenda.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fazenda</TableHead>
                <TableHead className="w-40">Dispositivos aprovados</TableHead>
                <TableHead className="w-40">Proteção IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {farms.map(f => (
                <TableRow key={f.id}>
                  <TableCell className="font-medium">{f.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {devicesGrouped.get(f.id)?.length ?? 0}
                  </TableCell>
                  <TableCell>
                    <Switch checked={!!f.ip_restriction_enabled} onCheckedChange={(v) => toggleFarm(f, v)} />
                  </TableCell>
                </TableRow>
              ))}
              {farms.length === 0 && (
                <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground py-4">Nenhuma fazenda</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {loading && <p className="text-xs text-muted-foreground">Carregando…</p>}
    </div>
  );
}

/** Exportado para exibir badge no menu superior. */
export function useFarmAccessPendingCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const { count: c } = await supabase
        .from("farm_access_requests" as any)
        .select("id", { count: "exact", head: true })
        .eq("status", "pending");
      if (mounted) setCount(c ?? 0);
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => { mounted = false; clearInterval(t); };
  }, []);
  return count;
}
