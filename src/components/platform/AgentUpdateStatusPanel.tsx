import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { notify } from "@/lib/notify";
import {
  Activity, AlertTriangle, CheckCircle2, CircleDashed, Clock, Download,
  HardDriveDownload, Loader2, RefreshCw, RotateCcw, Undo2, XCircle,
} from "lucide-react";

interface UpdateStatusRow {
  farm_id: string;
  current_version: string | null;
  target_version: string | null;
  update_status: string;
  download_progress: number;
  error_message: string | null;
  force_update: boolean;
  requested_at: string | null;
  completed_at: string | null;
  updated_at: string;
  auto_rollback_detected?: boolean | null;
}
interface HistoryRow {
  id: string;
  farm_id: string;
  from_version: string | null;
  to_version: string;
  status: string;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
}
interface FarmInfo { id: string; name: string }

const STATUS_CFG: Record<string, { label: string; icon: any; cls: string }> = {
  idle:        { label: "Atualizado",      icon: CheckCircle2,      cls: "text-green-600" },
  pending:     { label: "Pendente",        icon: Clock,             cls: "text-amber-600" },
  downloading: { label: "Baixando",        icon: HardDriveDownload, cls: "text-blue-600" },
  downloaded:  { label: "Baixado",         icon: Download,          cls: "text-blue-600" },
  installing:  { label: "Instalando",      icon: Loader2,           cls: "text-orange-600" },
  success:     { label: "Sucesso",         icon: CheckCircle2,      cls: "text-green-600" },
  failed:      { label: "Falhou",          icon: XCircle,           cls: "text-destructive" },
  rolled_back: { label: "Revertido",       icon: RotateCcw,         cls: "text-amber-600" },
};

export default function AgentUpdateStatusPanel() {
  const [rows, setRows] = useState<UpdateStatusRow[]>([]);
  const [farms, setFarms] = useState<FarmInfo[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  const farmName = useMemo(() => {
    const m = new Map<string, string>();
    farms.forEach((f) => m.set(f.id, f.name));
    return m;
  }, [farms]);

  const load = async () => {
    setLoading(true);
    const [{ data: status }, { data: fs }, { data: hist }] = await Promise.all([
      supabase.from("agent_update_status").select("*"),
      supabase.from("farms").select("id,name").order("name"),
      supabase
        .from("agent_update_history")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(30),
    ]);
    setRows((status as UpdateStatusRow[]) ?? []);
    setFarms((fs as FarmInfo[]) ?? []);
    setHistory((hist as HistoryRow[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel("agent_update_status_live")
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_update_status" }, (payload) => {
        setRows((prev) => {
          const next = [...prev];
          const row = (payload.new ?? payload.old) as UpdateStatusRow;
          if (!row?.farm_id) return prev;
          const idx = next.findIndex((r) => r.farm_id === row.farm_id);
          if (payload.eventType === "DELETE") {
            return idx >= 0 ? next.filter((r) => r.farm_id !== row.farm_id) : prev;
          }
          if (idx >= 0) next[idx] = row as UpdateStatusRow;
          else next.push(row as UpdateStatusRow);
          return next;
        });
      })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, []);

  const clearStatus = async (farmId: string) => {
    const { error } = await supabase.rpc("clear_agent_update" as any, { _farm_id: farmId });
    if (error) notify.fail("Atualização do Agente", error.message);
    else notify.ok("Atualização do Agente", "Status reiniciado");
  };

  const active = rows.filter((r) => r.update_status !== "idle" && r.update_status !== "success");
  const recent = rows
    .filter((r) => r.update_status === "success" || r.update_status === "failed" || r.update_status === "idle")
    .slice(0, 20);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            Atualizações em andamento
            {active.length > 0 && <Badge variant="default">{active.length}</Badge>}
          </CardTitle>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Atualizar
          </Button>
        </CardHeader>
        <CardContent>
          {active.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center flex items-center justify-center gap-2">
              <CircleDashed className="w-4 h-4" /> Nenhuma atualização em andamento.
            </div>
          ) : (
            <div className="space-y-3">
              {active.map((r) => {
                const cfg = STATUS_CFG[r.update_status] ?? STATUS_CFG.idle;
                const Icon = cfg.icon;
                return (
                  <div key={r.farm_id} className="rounded-md border p-3 space-y-2">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon className={`w-4 h-4 ${cfg.cls} ${r.update_status === "installing" ? "animate-spin" : ""}`} />
                        <span className="font-medium truncate">{farmName.get(r.farm_id) ?? r.farm_id}</span>
                        <Badge variant="outline" className={cfg.cls}>{cfg.label}</Badge>
                        {r.force_update && <Badge variant="secondary" className="text-[10px]">forçada</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {r.current_version ?? "?"} → {r.target_version ?? "?"}
                      </div>
                    </div>
                    {r.update_status === "downloading" && (
                      <div className="space-y-1">
                        <Progress value={r.download_progress} className="h-2" />
                        <div className="text-[11px] text-muted-foreground text-right">{r.download_progress}%</div>
                      </div>
                    )}
                    {r.error_message && (
                      <div className="flex items-start gap-1.5 text-xs text-destructive">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>{r.error_message}</span>
                      </div>
                    )}
                    <div className="flex justify-end">
                      <Button variant="ghost" size="sm" onClick={() => clearStatus(r.farm_id)}>
                        <RotateCcw className="w-3.5 h-3.5 mr-1" /> Resetar
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status finalizado por fazenda</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">Sem registros.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fazenda</TableHead>
                  <TableHead>Versão</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Atualizado em</TableHead>
                  <TableHead className="text-right">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((r) => {
                  const cfg = STATUS_CFG[r.update_status] ?? STATUS_CFG.idle;
                  return (
                    <TableRow key={r.farm_id}>
                      <TableCell className="font-medium">{farmName.get(r.farm_id) ?? r.farm_id}</TableCell>
                      <TableCell className="text-xs font-mono">{r.current_version ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cfg.cls}>{cfg.label}</Badge>
                        {r.auto_rollback_detected && (
                          <Badge variant="outline" className="ml-1 border-amber-500 text-amber-600 gap-1" title="Versão nova pode ter problema — verifique logs">
                            <Undo2 className="w-3 h-3" />Rollback automático
                          </Badge>
                        )}
                        {r.error_message && (
                          <div className="text-[11px] text-destructive mt-1">{r.error_message}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(r.updated_at).toLocaleString("pt-BR")}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.update_status !== "idle" && (
                          <Button variant="ghost" size="sm" onClick={() => clearStatus(r.farm_id)}>
                            Limpar
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
        <CardHeader>
          <CardTitle className="text-base">Histórico (últimas 30)</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">Nenhum histórico ainda.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quando</TableHead>
                  <TableHead>Fazenda</TableHead>
                  <TableHead>De</TableHead>
                  <TableHead>Para</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duração</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(h.created_at).toLocaleString("pt-BR")}
                    </TableCell>
                    <TableCell className="text-sm">{farmName.get(h.farm_id) ?? "—"}</TableCell>
                    <TableCell className="text-xs font-mono">{h.from_version ?? "—"}</TableCell>
                    <TableCell className="text-xs font-mono">{h.to_version}</TableCell>
                    <TableCell>
                      <Badge variant={h.status === "success" ? "default" : "destructive"}>
                        {h.status}
                      </Badge>
                      {h.error_message && (
                        <div className="text-[11px] text-destructive mt-1">{h.error_message}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {h.duration_ms ? `${(h.duration_ms / 1000).toFixed(1)}s` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
