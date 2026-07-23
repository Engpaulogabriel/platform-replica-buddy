import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { History, PlayCircle, RefreshCcw } from "lucide-react";

type ExecRow = {
  id: string;
  equipment_id: string | null;
  action: "liga" | "desliga";
  scheduled_time: string | null;
  executed_at: string;
  status: string;
  origin: string;
};

type AuditRow = {
  id: string;
  equipment_id: string | null;
  action: string;
  performed_by: string | null;
  performed_via: string | null;
  old_values: any;
  new_values: any;
  created_at: string;
};

function fmt(dt: string) {
  try {
    return new Date(dt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return dt;
  }
}

function viaLabel(v: string | null | undefined) {
  if (!v) return "—";
  if (v === "whatsapp") return "WhatsApp";
  if (v === "frontend") return "Usuário Web";
  return v;
}

function describeAudit(row: AuditRow): string {
  const v = row.new_values ?? row.old_values ?? {};
  const parts: string[] = [];
  if (v.mode === "on-only" && v.time_on) parts.push(`Liga ${String(v.time_on).slice(0, 5)}`);
  if (v.mode === "off-only" && v.time_off) parts.push(`Desliga ${String(v.time_off).slice(0, 5)}`);
  if (Array.isArray(v.days) && v.days.length) parts.push(`(${v.days.join(",")})`);
  return parts.join(" ") || "—";
}

export default function AuditoriaPanel() {
  const farmId = useDefaultFarmId();
  const [tab, setTab] = useState<"exec" | "audit">("exec");
  const [exec, setExec] = useState<ExecRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [eqMap, setEqMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    if (!farmId) return;
    setLoading(true);
    const [execRes, auditRes, eqRes] = await Promise.all([
      supabase
        .from("automation_execution_log")
        .select("id, equipment_id, action, scheduled_time, executed_at, status, origin")
        .eq("farm_id", farmId)
        .order("executed_at", { ascending: false })
        .limit(100),
      supabase
        .from("automation_schedules_audit")
        .select("id, equipment_id, action, performed_by, performed_via, old_values, new_values, created_at")
        .eq("farm_id", farmId)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase.from("equipments").select("id, name").eq("farm_id", farmId),
    ]);
    setExec((execRes.data ?? []) as ExecRow[]);
    setAudit((auditRes.data ?? []) as AuditRow[]);
    const m: Record<string, string> = {};
    (eqRes.data ?? []).forEach((e: any) => { m[e.id] = e.name; });
    setEqMap(m);
    setLoading(false);
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [farmId]);

  const items = tab === "exec" ? exec : audit;

  return (
    <Card className="p-4 mt-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-primary" />
          <h3 className="font-semibold text-foreground">Auditoria da Automação</h3>
        </div>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCcw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="flex gap-2 mb-3">
        <Button size="sm" variant={tab === "exec" ? "default" : "outline"} onClick={() => setTab("exec")}>
          <PlayCircle className="w-3.5 h-3.5 mr-1" /> Execuções ({exec.length})
        </Button>
        <Button size="sm" variant={tab === "audit" ? "default" : "outline"} onClick={() => setTab("audit")}>
          Alterações ({audit.length})
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">Nenhum registro.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground border-b">
              {tab === "exec" ? (
                <tr>
                  <th className="text-left py-2 pr-2">Data/Hora</th>
                  <th className="text-left py-2 pr-2">Equipamento</th>
                  <th className="text-left py-2 pr-2">Ação</th>
                  <th className="text-left py-2 pr-2">Programado</th>
                  <th className="text-left py-2">Status</th>
                </tr>
              ) : (
                <tr>
                  <th className="text-left py-2 pr-2">Data</th>
                  <th className="text-left py-2 pr-2">Ação</th>
                  <th className="text-left py-2 pr-2">Equipamento</th>
                  <th className="text-left py-2 pr-2">Detalhes</th>
                  <th className="text-left py-2 pr-2">Quem</th>
                  <th className="text-left py-2">Via</th>
                </tr>
              )}
            </thead>
            <tbody>
              {tab === "exec"
                ? (exec.map((r) => (
                  <tr key={r.id} className="border-b border-border/40">
                    <td className="py-1.5 pr-2 whitespace-nowrap">{fmt(r.executed_at)}</td>
                    <td className="py-1.5 pr-2">{eqMap[r.equipment_id ?? ""] ?? "—"}</td>
                    <td className="py-1.5 pr-2">
                      <Badge variant={r.action === "liga" ? "default" : "secondary"} className="text-[10px]">
                        {r.action.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="py-1.5 pr-2">{r.scheduled_time ?? "—"}</td>
                    <td className="py-1.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                        r.status === "success" ? "bg-emerald-500/15 text-emerald-500" :
                        r.status === "failed" ? "bg-destructive/15 text-destructive" :
                        "bg-muted text-muted-foreground"}`}>{r.status}</span>
                    </td>
                  </tr>
                )))
                : (audit.map((r) => (
                  <tr key={r.id} className="border-b border-border/40">
                    <td className="py-1.5 pr-2 whitespace-nowrap">{fmt(r.created_at)}</td>
                    <td className="py-1.5 pr-2"><Badge variant="outline" className="text-[10px]">{r.action}</Badge></td>
                    <td className="py-1.5 pr-2">{eqMap[r.equipment_id ?? ""] ?? "—"}</td>
                    <td className="py-1.5 pr-2">{describeAudit(r)}</td>
                    <td className="py-1.5 pr-2">{r.performed_by ?? "—"}</td>
                    <td className="py-1.5">{viaLabel(r.performed_via)}</td>
                  </tr>
                )))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
