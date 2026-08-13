// Setor Técnico — painel de eventos de segurança do agente (FASE 2/3).
// Lê agent_security_events da fazenda ativa: contadores por tipo, últimos 20
// eventos e alerta se houver clone_detected / fase3_fallback nas últimas 24h.
// Visível só para platform_admin e owner (RLS já limita leitura a has_farm_access).
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ShieldAlert, ShieldCheck, RefreshCw, Lock, AlertTriangle } from "lucide-react";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useFarmAccess } from "@/hooks/useFarmAccess";

interface SecEvent {
  id: string;
  event_type: string;
  details: any;
  agent_version: string | null;
  created_at: string;
}

const EVENT_TYPES: Array<{ key: string; label: string; cls: string }> = [
  { key: "clone_detected", label: "Clone detectado", cls: "bg-destructive/15 text-destructive border-destructive/40" },
  { key: "fingerprint_mismatch", label: "Fingerprint divergente", cls: "bg-warning/15 text-warning border-warning/40" },
  { key: "dpapi_failed", label: "Falha DPAPI", cls: "bg-warning/15 text-warning border-warning/40" },
  { key: "token_expired", label: "Token expirado", cls: "bg-muted text-muted-foreground border-border" },
  { key: "fase3_fallback", label: "FASE 3 fallback", cls: "bg-info/15 text-info border-info/40" },
];
const LABEL_BY_KEY: Record<string, string> = Object.fromEntries(EVENT_TYPES.map((e) => [e.key, e.label]));
const CLS_BY_KEY: Record<string, string> = Object.fromEntries(EVENT_TYPES.map((e) => [e.key, e.cls]));

const PERIODS: Array<{ key: string; label: string; days: number }> = [
  { key: "today", label: "Hoje", days: 0 },
  { key: "7d", label: "7 dias", days: 7 },
  { key: "30d", label: "30 dias", days: 30 },
];
const DAY_MS = 24 * 60 * 60 * 1000;

function periodStart(key: string): number {
  const now = Date.now();
  if (key === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  const p = PERIODS.find((x) => x.key === key);
  return now - (p?.days ?? 7) * DAY_MS;
}

function reasonOf(details: any): string {
  if (!details || typeof details !== "object") return "—";
  if (details.reason) return String(details.reason);
  // sem reason explícito → resumo compacto dos campos relevantes
  const parts: string[] = [];
  if (details.divergence != null) parts.push(`divergência ${details.divergence}`);
  if (details.error) parts.push(String(details.error));
  if (details.command_status) parts.push(`cmd ${details.command_status}`);
  return parts.length ? parts.join(" · ") : "—";
}

export default function SecurityEventsPanel() {
  const farmId = useDefaultFarmId();
  const { role } = useFarmAccess();
  const canView = role === "platform_admin" || role === "owner";

  const [period, setPeriod] = useState<string>("7d");
  const [rows, setRows] = useState<SecEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!farmId || !canView) { setRows([]); setLoading(false); return; }
    setLoading(true);
    // Busca desde o MENOR entre (início do período) e (agora-24h), para o alerta
    // de 24h ficar correto mesmo com o filtro em "Hoje". Uma query só.
    const fromMs = Math.min(periodStart(period), Date.now() - DAY_MS);
    const { data } = await supabase
      .from("agent_security_events")
      .select("id, event_type, details, agent_version, created_at")
      .eq("farm_id", farmId)
      .gte("created_at", new Date(fromMs).toISOString())
      .order("created_at", { ascending: false })
      .limit(1000);
    setRows((data ?? []) as SecEvent[]);
    setLoading(false);
  }, [farmId, canView, period]);

  useEffect(() => { void load(); }, [load]);

  // Linhas dentro do período selecionado (contadores + tabela)
  const inPeriod = useMemo(() => {
    const start = periodStart(period);
    return rows.filter((r) => new Date(r.created_at).getTime() >= start);
  }, [rows, period]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of EVENT_TYPES) m[e.key] = 0;
    for (const r of inPeriod) m[r.event_type] = (m[r.event_type] ?? 0) + 1;
    return m;
  }, [inPeriod]);

  // Alerta: clone_detected / fase3_fallback nas últimas 24h (independe do filtro)
  const last24 = useMemo(() => {
    const since = Date.now() - DAY_MS;
    const r24 = rows.filter((r) => new Date(r.created_at).getTime() >= since);
    return {
      clone: r24.filter((r) => r.event_type === "clone_detected").length,
      fallback: r24.filter((r) => r.event_type === "fase3_fallback").length,
    };
  }, [rows]);

  const last20 = useMemo(() => inPeriod.slice(0, 20), [inPeriod]);

  if (!canView) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
        <Lock className="w-4 h-4" /> Painel de segurança restrito a administradores (platform_admin / owner).
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Alerta 24h */}
      {(last24.clone > 0 || last24.fallback > 0) ? (
        <div className="space-y-2">
          {last24.clone > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span><strong>{last24.clone}</strong> evento(s) de <strong>clone detectado</strong> nas últimas 24h — verifique o PC do agente.</span>
            </div>
          )}
          {last24.fallback > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-sm text-info">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span><strong>{last24.fallback}</strong> evento(s) de <strong>FASE 3 fallback</strong> nas últimas 24h — o loader não fechou a decifragem (agente segue operando).</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">
          <ShieldCheck className="w-4 h-4 shrink-0" /> Sem eventos críticos (clone / FASE 3) nas últimas 24h.
        </div>
      )}

      {/* Contadores por tipo */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
            <span className="flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-primary" /> Eventos de segurança do agente</span>
            <div className="flex items-center gap-2">
              <Select value={period} onValueChange={setPeriod}>
                <SelectTrigger className="h-8 w-[120px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PERIODS.map((p) => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
                <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Atualizar
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {EVENT_TYPES.map((e) => (
              <div key={e.key} className={`rounded-lg border p-3 text-center ${counts[e.key] > 0 ? e.cls : "bg-muted/30 text-muted-foreground border-border"}`}>
                <p className="text-2xl font-bold tabular-nums">{counts[e.key] ?? 0}</p>
                <p className="text-[11px] font-medium leading-tight mt-0.5">{e.label}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Últimos 20 eventos */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Últimos eventos ({last20.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-[10px] text-muted-foreground mb-1 sm:hidden">← deslize para ver todas as colunas →</p>
          <div className="overflow-x-auto -mx-2 px-2">
            <Table className="md:text-xs md:[&_th]:px-2 md:[&_th]:h-9 md:[&_td]:px-2 md:[&_td]:py-1.5">
              <TableHeader>
                <TableRow>
                  <TableHead>Data/Hora</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Detalhe (reason)</TableHead>
                  <TableHead>Versão</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {last20.length === 0 && !loading && (
                  <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground text-sm">Nenhum evento no período.</TableCell></TableRow>
                )}
                {last20.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-[11px] text-muted-foreground whitespace-nowrap">
                      {new Date(r.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={CLS_BY_KEY[r.event_type] ?? "bg-muted text-muted-foreground border-border"}>
                        {LABEL_BY_KEY[r.event_type] ?? r.event_type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs max-w-[360px] truncate" title={reasonOf(r.details)}>{reasonOf(r.details)}</TableCell>
                    <TableCell className="text-[11px] text-muted-foreground whitespace-nowrap">{r.agent_version ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
