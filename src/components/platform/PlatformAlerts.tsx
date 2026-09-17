import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { notify } from "@/lib/notify";
import {
  AlertTriangle, AlertOctagon, Info, RefreshCw, CheckCheck, Check, Search, Bell, Filter,
} from "lucide-react";

interface AlertRow {
  source: "agent_logs" | "automation_log";
  alert_id: string;
  farm_id: string;
  farm_name: string | null;
  occurred_at: string;
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  message: string;
  details: any;
  is_read: boolean;
}

interface Stats {
  total_7d: number;
  unread: number;
  critical_today: number;
  warning_24h: number;
}

interface Farm { farm_id: string; name: string }

export default function PlatformAlerts({ isAdmin: _isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [farms, setFarms] = useState<Farm[]>([]);

  const [farmId, setFarmId] = useState<string>("all");
  const [severity, setSeverity] = useState<string>("all");
  const [category, setCategory] = useState<string>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [periodDays, setPeriodDays] = useState<string>("7");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<AlertRow | null>(null);

  const loadFarms = useCallback(async () => {
    const { data } = await supabase.rpc("platform_farms_overview" as any);
    setFarms(((data as any) ?? []).map((f: any) => ({ farm_id: f.farm_id, name: f.name })));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    const since = new Date(Date.now() - Number(periodDays) * 86400_000).toISOString();
    const [feedRes, statsRes] = await Promise.all([
      supabase.rpc("platform_alerts_feed" as any, {
        p_farm_id: farmId === "all" ? null : farmId,
        p_severity: severity === "all" ? null : severity,
        p_category: category === "all" ? null : category,
        p_unread_only: unreadOnly,
        p_since: since,
        p_limit: 300,
      }),
      supabase.rpc("platform_alerts_stats" as any),
    ]);
    if (feedRes.error) notify.fail("Alertas", "Erro ao carregar alertas: " + feedRes.error.message);
    else setRows((feedRes.data as any) ?? []);
    if (!statsRes.error) setStats(statsRes.data as any);
    setLoading(false);
  }, [farmId, severity, category, unreadOnly, periodDays]);

  useEffect(() => { void loadFarms(); }, [loadFarms]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Realtime: re-busca a cada novo alerta
  useEffect(() => {
    const ch = supabase
      .channel("platform-alerts")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_logs" }, () => void refresh())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "automation_log" }, () => void refresh())
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.title.toLowerCase().includes(q) ||
      r.message.toLowerCase().includes(q) ||
      (r.farm_name ?? "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  const categories = useMemo(() => {
    const s = new Set<string>();
    rows.forEach(r => r.category && s.add(r.category));
    return Array.from(s).sort();
  }, [rows]);

  const markRead = async (r: AlertRow) => {
    const { error } = await supabase.rpc("platform_alerts_mark_read" as any, {
      p_source: r.source, p_alert_id: r.alert_id,
    });
    if (error) return notify.fail("Alertas", error.message);
    setRows(prev => prev.map(x => x.alert_id === r.alert_id && x.source === r.source ? { ...x, is_read: true } : x));
    setStats(s => s ? { ...s, unread: Math.max(0, s.unread - (r.is_read ? 0 : 1)) } : s);
  };

  const markAllRead = async () => {
    if (!confirm("Marcar todos os alertas dos últimos 30 dias como lidos?")) return;
    const { data, error } = await supabase.rpc("platform_alerts_mark_all_read" as any, { p_until: new Date().toISOString() });
    if (error) return notify.fail("Alertas", error.message);
    notify.ok("Alertas", `${data ?? 0} alertas marcados como lidos.`);
    void refresh();
  };

  const sevIcon = (s: string) => s === "critical"
    ? <AlertOctagon className="w-4 h-4 text-destructive" />
    : s === "warning"
      ? <AlertTriangle className="w-4 h-4 text-amber-500" />
      : <Info className="w-4 h-4 text-muted-foreground" />;

  const sevBadge = (s: string) => {
    const variant = s === "critical" ? "destructive" : s === "warning" ? "outline" : "secondary";
    const label = s === "critical" ? "Crítico" : s === "warning" ? "Aviso" : "Info";
    return <Badge variant={variant as any} className={s === "warning" ? "border-amber-500 text-amber-600" : ""}>{label}</Badge>;
  };

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center"><Bell className="w-5 h-5 text-primary" /></div>
          <div><div className="text-[11px] uppercase tracking-wider text-muted-foreground">Alertas (7d)</div>
            <div className="text-2xl font-bold">{stats?.total_7d ?? "—"}</div></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center"><AlertTriangle className="w-5 h-5 text-amber-500" /></div>
          <div><div className="text-[11px] uppercase tracking-wider text-muted-foreground">Não lidos</div>
            <div className="text-2xl font-bold text-amber-600">{stats?.unread ?? "—"}</div></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-destructive/10 flex items-center justify-center"><AlertOctagon className="w-5 h-5 text-destructive" /></div>
          <div><div className="text-[11px] uppercase tracking-wider text-muted-foreground">Críticos hoje</div>
            <div className="text-2xl font-bold text-destructive">{stats?.critical_today ?? "—"}</div></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center"><AlertTriangle className="w-5 h-5 text-amber-500" /></div>
          <div><div className="text-[11px] uppercase tracking-wider text-muted-foreground">Avisos 24h</div>
            <div className="text-2xl font-bold">{stats?.warning_24h ?? "—"}</div></div>
        </CardContent></Card>
      </div>

      {/* Filtros */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <CardTitle className="text-base flex items-center gap-2"><Filter className="w-4 h-4" />Feed cross-farm</CardTitle>
            <div className="flex gap-2 ml-auto flex-wrap">
              <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
                <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />Atualizar
              </Button>
              <Button variant="outline" size="sm" onClick={markAllRead}>
                <CheckCheck className="w-4 h-4 mr-1.5" />Marcar todos como lidos
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <Select value={farmId} onValueChange={setFarmId}>
              <SelectTrigger><SelectValue placeholder="Fazenda" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as fazendas</SelectItem>
                {farms.map(f => <SelectItem key={f.farm_id} value={f.farm_id}>{f.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Toda severidade</SelectItem>
                <SelectItem value="critical">Críticos</SelectItem>
                <SelectItem value="warning">Avisos</SelectItem>
                <SelectItem value="info">Info</SelectItem>
              </SelectContent>
            </Select>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Toda categoria</SelectItem>
                {categories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={periodDays} onValueChange={setPeriodDays}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Últimas 24h</SelectItem>
                <SelectItem value="7">Últimos 7 dias</SelectItem>
                <SelectItem value="30">Últimos 30 dias</SelectItem>
              </SelectContent>
            </Select>
            <Select value={unreadOnly ? "unread" : "all"} onValueChange={(v) => setUnreadOnly(v === "unread")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="unread">Apenas não lidos</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Buscar texto…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
            </div>
          </div>

          <div className="overflow-x-auto border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Severidade</TableHead>
                  <TableHead className="w-[160px]">Quando</TableHead>
                  <TableHead>Fazenda</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Mensagem</TableHead>
                  <TableHead className="text-right w-[120px]">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    {loading ? "Carregando…" : "Nenhum alerta encontrado para os filtros atuais."}
                  </TableCell></TableRow>
                )}
                {filtered.map(r => (
                  <TableRow
                    key={`${r.source}-${r.alert_id}`}
                    className={r.is_read ? "opacity-60" : "font-medium"}
                  >
                    <TableCell>
                      <div className="flex items-center gap-1.5">{sevIcon(r.severity)}{sevBadge(r.severity)}</div>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {new Date(r.occurred_at).toLocaleString("pt-BR")}
                    </TableCell>
                    <TableCell className="text-sm">{r.farm_name ?? <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell><Badge variant="outline" className="text-[10px]">{r.category}</Badge></TableCell>
                    <TableCell className="max-w-[400px] truncate text-sm" title={r.message}>{r.title}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => setSelected(r)}>Ver</Button>
                      {!r.is_read && (
                        <Button variant="ghost" size="sm" onClick={() => markRead(r)} title="Marcar como lido">
                          <Check className="w-4 h-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selected && sevIcon(selected.severity)}
              {selected?.title}
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div><div className="text-xs text-muted-foreground">Fazenda</div><div>{selected.farm_name ?? "—"}</div></div>
                <div><div className="text-xs text-muted-foreground">Quando</div><div>{new Date(selected.occurred_at).toLocaleString("pt-BR")}</div></div>
                <div><div className="text-xs text-muted-foreground">Categoria</div><div>{selected.category}</div></div>
                <div><div className="text-xs text-muted-foreground">Origem</div><div className="font-mono text-xs">{selected.source}</div></div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Mensagem</div>
                <div className="p-3 rounded bg-muted/50 whitespace-pre-wrap">{selected.message}</div>
              </div>
              {selected.details && Object.keys(selected.details).length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Detalhes</div>
                  <pre className="p-3 rounded bg-muted/50 text-xs overflow-x-auto">
                    {JSON.stringify(selected.details, null, 2)}
                  </pre>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                {!selected.is_read && (
                  <Button onClick={() => { void markRead(selected); setSelected(null); }}>
                    <Check className="w-4 h-4 mr-1.5" />Marcar como lido
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
