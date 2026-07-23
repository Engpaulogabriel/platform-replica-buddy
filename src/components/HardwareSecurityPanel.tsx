import { notify } from "@/lib/notify";
// Painel de segurança do hardware do agente Electron por fazenda.
// Mostra status (ok/warning/blocked), componentes alterados, histórico,
// e permite que platform_admin reautorize o hardware.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ShieldCheck, ShieldAlert, ShieldX, RotateCcw, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";

interface AgentHardware {
  farm_id: string;
  fingerprint: any;
  registered_at: string;
  last_check_at: string;
  alert_level: "ok" | "warning" | "blocked";
  changed_components: string[];
  last_change_at: string | null;
  agent_version: string | null;
  farm_name?: string;
}

interface HistoryRow {
  id: string;
  farm_id: string;
  changed_components: string[];
  alert_level: string;
  agent_version: string | null;
  created_at: string;
  farm_name?: string;
}

const LEVEL_BADGE: Record<string, { label: string; className: string; icon: any }> = {
  ok: { label: "OK", className: "bg-emerald-600 hover:bg-emerald-600", icon: ShieldCheck },
  warning: { label: "Atenção", className: "bg-amber-500 hover:bg-amber-500 text-black", icon: ShieldAlert },
  blocked: { label: "Bloqueado", className: "bg-red-600 hover:bg-red-600", icon: ShieldX },
};

export default function HardwareSecurityPanel() {
  const { isPlatformAdmin } = usePlatformAdmin();
  const [rows, setRows] = useState<AgentHardware[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const [{ data: hw }, { data: hist }, { data: farms }] = await Promise.all([
      supabase.from("agent_hardware").select("*").order("alert_level", { ascending: false }),
      supabase.from("agent_hardware_history").select("*").order("created_at", { ascending: false }).limit(50),
      supabase.from("farms").select("id, name"),
    ]);
    const byId = new Map((farms || []).map((f: any) => [f.id, f.name]));
    setRows(((hw as any[]) || []).map((r) => ({ ...r, farm_name: byId.get(r.farm_id) ?? r.farm_id.slice(0, 8) })));
    setHistory(((hist as any[]) || []).map((r) => ({ ...r, farm_name: byId.get(r.farm_id) ?? r.farm_id.slice(0, 8) })));
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function reauthorize(farmId: string, farmName?: string) {
    if (!confirm(`Reautorizar hardware da fazenda "${farmName ?? farmId}"?\n\nNo próximo boot, o agente vai gravar o fingerprint atual como o novo registro.`)) return;
    setResetting(farmId);
    const { error } = await supabase.rpc("reset_agent_hardware", { _farm_id: farmId });
    setResetting(null);
    if (error) { notify.fail("Segurança de Hardware", "Falha ao reautorizar" + " — " + (error.message)); return; }
    notify.ok("Segurança de Hardware", "Hardware reautorizado" + " — " + ("O agente vai re-registrar no próximo boot."));
    await load();
  }

  if (loading) return (
    <div className="flex items-center gap-2 text-muted-foreground py-8">
      <Loader2 className="w-4 h-4 animate-spin" /> Carregando segurança de hardware…
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" /> Segurança de Hardware (Anti-Clone)
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Verifica MAC, disco, BIOS e CPU do PC onde o agente roda. 1 mudança gera atenção; 2+ bloqueiam o agente.
          </p>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">Nenhum agente registrou hardware ainda.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fazenda</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Componentes alterados</TableHead>
                  <TableHead>Última verificação</TableHead>
                  <TableHead>Versão</TableHead>
                  <TableHead className="text-right">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const cfg = LEVEL_BADGE[r.alert_level] ?? LEVEL_BADGE.ok;
                  const Icon = cfg.icon;
                  return (
                    <TableRow key={r.farm_id}>
                      <TableCell className="font-medium">{r.farm_name}</TableCell>
                      <TableCell>
                        <Badge className={cfg.className}><Icon className="w-3 h-3 mr-1" /> {cfg.label}</Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.changed_components?.length ? r.changed_components.join(", ") : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(r.last_check_at).toLocaleString("pt-BR")}
                      </TableCell>
                      <TableCell className="text-xs">{r.agent_version ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {isPlatformAdmin && (r.alert_level !== "ok" || true) && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={resetting === r.farm_id}
                            onClick={() => reauthorize(r.farm_id, r.farm_name)}
                          >
                            {resetting === r.farm_id
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <><RotateCcw className="w-3 h-3 mr-1" /> Reautorizar</>}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Histórico de alterações</CardTitle></CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem alterações registradas.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quando</TableHead>
                  <TableHead>Fazenda</TableHead>
                  <TableHead>Nível</TableHead>
                  <TableHead>Componentes</TableHead>
                  <TableHead>Versão</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h) => {
                  const cfg = LEVEL_BADGE[h.alert_level] ?? LEVEL_BADGE.ok;
                  return (
                    <TableRow key={h.id}>
                      <TableCell className="text-xs">{new Date(h.created_at).toLocaleString("pt-BR")}</TableCell>
                      <TableCell>{h.farm_name}</TableCell>
                      <TableCell><Badge className={cfg.className}>{cfg.label}</Badge></TableCell>
                      <TableCell className="text-xs">{h.changed_components.join(", ")}</TableCell>
                      <TableCell className="text-xs">{h.agent_version ?? "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
