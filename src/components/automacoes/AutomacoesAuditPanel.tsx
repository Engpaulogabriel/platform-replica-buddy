import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface Equipment { id: string; name: string; }

interface AuditRow {
  id: string;
  automation_id: string | null;
  event_type: string;
  equipment_ids: string[];
  action: string | null;
  performed_by_name: string | null;
  performed_by_phone: string | null;
  performed_by_email: string | null;
  performed_via: string;
  trigger_type: string | null;
  scheduled_time: string | null;
  actual_execution_time: string | null;
  result_details: any[];
  notes: string | null;
  created_at: string;
}

const EVENT_LABEL: Record<string, string> = {
  created: "Criada",
  updated: "Editada",
  deleted: "Excluída",
  activated: "Ativada",
  deactivated: "Desativada",
  executed: "Executada",
  failed: "Falha",
  expired: "Expirada",
};

const VIA_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  frontend: "Painel",
  api: "API",
  automation_engine: "Automação",
};

function statusBadge(row: AuditRow) {
  if (row.event_type === "failed") return <span className="text-rose-600">❌ Falha</span>;
  if (row.event_type === "expired") return <span className="text-amber-600">⏰ Expirada</span>;
  if (row.event_type === "executed") {
    const all = Array.isArray(row.result_details) ? row.result_details : [];
    const ok = all.filter((r: any) => r?.status === "success").length;
    return all.length
      ? <span className={ok === all.length ? "text-emerald-600" : "text-amber-600"}>{ok === all.length ? "✅" : "⚠️"} {ok}/{all.length}</span>
      : <span className="text-emerald-600">✅</span>;
  }
  return <span className="text-emerald-600">✅</span>;
}

function toCsv(rows: AuditRow[], autoNames: Map<string, string>, equipNames: Map<string, string>) {
  const head = [
    "Data/Hora", "Evento", "Automação", "Equipamentos", "Ação",
    "Operador", "Telefone", "E-mail", "Via", "Gatilho", "Horário", "Detalhes",
  ];
  const esc = (v: any) => {
    const s = v == null ? "" : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => [
    new Date(r.created_at).toLocaleString("pt-BR"),
    EVENT_LABEL[r.event_type] ?? r.event_type,
    r.automation_id ? autoNames.get(r.automation_id) ?? "—" : "— (avulso)",
    (r.equipment_ids || []).map((id) => equipNames.get(id) ?? id).join(" | "),
    r.action ?? "",
    r.performed_by_name ?? "",
    r.performed_by_phone ?? "",
    r.performed_by_email ?? "",
    VIA_LABEL[r.performed_via] ?? r.performed_via,
    r.trigger_type ?? "",
    r.scheduled_time ?? "",
    r.notes ?? "",
  ].map(esc).join(";"));
  return [head.join(";"), ...body].join("\n");
}

interface Props {
  farmId: string | null;
  equipments: Equipment[];
  automacaoNameById: Map<string, string>;
}

export function AutomacoesAuditPanel({ farmId, equipments, automacaoNameById }: Props) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);

  // filters
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const defaultTo = today.toISOString().slice(0, 10);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [equipmentId, setEquipmentId] = useState<string>("all");
  const [operator, setOperator] = useState<string>("all");
  const [eventType, setEventType] = useState<string>("all");
  const [via, setVia] = useState<string>("all");

  const equipmentNames = useMemo(() => {
    const m = new Map<string, string>();
    equipments.forEach((e) => m.set(e.id, e.name));
    return m;
  }, [equipments]);

  const reload = async () => {
    if (!farmId) return;
    setLoading(true);
    try {
      let q = supabase
        .from("automation_audit_log")
        .select("*")
        .eq("farm_id", farmId)
        .gte("created_at", `${from}T00:00:00`)
        .lte("created_at", `${to}T23:59:59`)
        .order("created_at", { ascending: false })
        .limit(500);
      if (eventType !== "all") q = q.eq("event_type", eventType);
      if (via !== "all") q = q.eq("performed_via", via);
      const { data, error } = await q;
      if (error) throw error;
      let list = (data ?? []) as AuditRow[];
      if (operator !== "all") list = list.filter((r) => (r.performed_by_name ?? "") === operator);
      if (equipmentId !== "all") {
        list = list.filter((r) => Array.isArray(r.equipment_ids) && r.equipment_ids.includes(equipmentId));
      }
      setRows(list);
    } catch (e: any) {
      console.error("[audit] reload", e);
      toast.error("Falha ao carregar histórico");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmId, from, to, eventType, via]);

  const operators = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => r.performed_by_name && s.add(r.performed_by_name));
    return Array.from(s).sort();
  }, [rows]);

  const filteredByLocal = useMemo(() => {
    let list = rows;
    if (operator !== "all") list = list.filter((r) => (r.performed_by_name ?? "") === operator);
    if (equipmentId !== "all") {
      list = list.filter((r) => Array.isArray(r.equipment_ids) && r.equipment_ids.includes(equipmentId));
    }
    return list;
  }, [rows, operator, equipmentId]);

  const exportCsv = () => {
    const csv = toCsv(filteredByLocal, automacaoNameById, equipmentNames);
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `auditoria-automacoes-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="font-semibold">Histórico Completo (Auditoria)</h3>
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={filteredByLocal.length === 0}>
          <Download className="w-4 h-4 mr-1" /> Exportar CSV
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">De</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Até</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Equipamento</Label>
          <Select value={equipmentId} onValueChange={setEquipmentId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {equipments.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Operador</Label>
          <Select value={operator} onValueChange={setOperator}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {operators.map((o) => (
                <SelectItem key={o} value={o}>{o}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Evento</Label>
          <Select value={eventType} onValueChange={setEventType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="created">Criada</SelectItem>
              <SelectItem value="updated">Editada</SelectItem>
              <SelectItem value="deleted">Excluída</SelectItem>
              <SelectItem value="activated">Ativada</SelectItem>
              <SelectItem value="deactivated">Desativada</SelectItem>
              <SelectItem value="executed">Executada</SelectItem>
              <SelectItem value="failed">Falha</SelectItem>
              <SelectItem value="expired">Expirada</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Via</Label>
          <Select value={via} onValueChange={setVia}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="whatsapp">WhatsApp</SelectItem>
              <SelectItem value="frontend">Painel</SelectItem>
              <SelectItem value="automation_engine">Automação</SelectItem>
              <SelectItem value="api">API</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="text-left px-2 py-2">Data/Hora</th>
              <th className="text-left px-2 py-2">Evento</th>
              <th className="text-left px-2 py-2">Automação</th>
              <th className="text-left px-2 py-2">Equipamentos</th>
              <th className="text-left px-2 py-2">Ação</th>
              <th className="text-left px-2 py-2">Operador</th>
              <th className="text-left px-2 py-2">Via</th>
              <th className="text-left px-2 py-2">Status</th>
              <th className="text-left px-2 py-2">Detalhes</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-2 py-6 text-center text-muted-foreground">Carregando…</td></tr>
            ) : filteredByLocal.length === 0 ? (
              <tr><td colSpan={9} className="px-2 py-6 text-center text-muted-foreground">Nenhum registro no período.</td></tr>
            ) : (
              filteredByLocal.map((r) => {
                const equipText = (r.equipment_ids || [])
                  .slice(0, 4)
                  .map((id) => equipmentNames.get(id) ?? id)
                  .join(", ") + ((r.equipment_ids?.length ?? 0) > 4 ? ` +${(r.equipment_ids?.length ?? 0) - 4}` : "");
                return (
                  <tr key={r.id} className="border-t align-top">
                    <td className="px-2 py-2 whitespace-nowrap">{new Date(r.created_at).toLocaleString("pt-BR")}</td>
                    <td className="px-2 py-2">{EVENT_LABEL[r.event_type] ?? r.event_type}</td>
                    <td className="px-2 py-2">{r.automation_id ? automacaoNameById.get(r.automation_id) ?? "—" : "— (avulso)"}</td>
                    <td className="px-2 py-2">{equipText || "—"}</td>
                    <td className="px-2 py-2 capitalize">{r.action ?? "—"}</td>
                    <td className="px-2 py-2">{r.performed_by_name ?? "—"}{r.performed_by_phone ? <div className="text-[10px] text-muted-foreground">{r.performed_by_phone}</div> : null}</td>
                    <td className="px-2 py-2">{VIA_LABEL[r.performed_via] ?? r.performed_via}</td>
                    <td className="px-2 py-2">{statusBadge(r)}</td>
                    <td className="px-2 py-2 text-muted-foreground">{r.notes ?? ""}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
