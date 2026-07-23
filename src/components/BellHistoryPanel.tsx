// Histórico completo do sino de alertas — usado pela aba "Sino" em /alarmes.
import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Bell, AlertTriangle, CheckCircle } from "lucide-react";

interface Row {
  id: string;
  kind: string;
  severity: string;
  title: string;
  message: string;
  source: string | null;
  resolved_at: string | null;
  created_at: string;
}

export default function BellHistoryPanel() {
  const farmId = useDefaultFarmId();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<"all" | "failure" | "system">("all");
  const [days, setDays] = useState("7");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!farmId) return;
    setLoading(true);
    const since = new Date(Date.now() - Number(days) * 86400_000).toISOString();
    let q = supabase
      .from("farm_notifications")
      .select("id, kind, severity, title, message, source, resolved_at, created_at")
      .eq("farm_id", farmId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);
    if (kind !== "all") q = q.eq("kind", kind);
    q.then(({ data }) => {
      setRows((data ?? []) as Row[]);
      setLoading(false);
    });
  }, [farmId, kind, days]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) =>
      r.title.toLowerCase().includes(s) || r.message.toLowerCase().includes(s),
    );
  }, [rows, search]);

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base text-foreground flex items-center gap-2">
            <Bell className="w-4 h-4 text-muted-foreground" />
            Histórico do Sino
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger className="w-[140px] h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="failure">Falhas</SelectItem>
                <SelectItem value="system">Sistema</SelectItem>
              </SelectContent>
            </Select>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-[120px] h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">24h</SelectItem>
                <SelectItem value="7">7 dias</SelectItem>
                <SelectItem value="30">30 dias</SelectItem>
                <SelectItem value="90">90 dias</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Buscar…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-[180px] h-8 text-xs"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-secondary/50">
              <TableHead className="text-muted-foreground">Data/Hora</TableHead>
              <TableHead className="text-muted-foreground">Tipo</TableHead>
              <TableHead className="text-muted-foreground">Severidade</TableHead>
              <TableHead className="text-muted-foreground">Alerta</TableHead>
              <TableHead className="text-muted-foreground">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-xs py-6">Carregando…</TableCell></TableRow>
            )}
            {!loading && filtered.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-xs py-6">Nenhum alerta no período</TableCell></TableRow>
            )}
            {filtered.map((r) => (
              <TableRow key={r.id} className="border-border hover:bg-secondary/50">
                <TableCell className="text-foreground text-xs whitespace-nowrap">
                  {new Date(r.created_at).toLocaleString("pt-BR")}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-[10px] uppercase">
                    {r.kind === "system" ? <><Bell className="w-3 h-3 mr-1" />Sistema</> : <><AlertTriangle className="w-3 h-3 mr-1" />Falha</>}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                    r.severity === "critical" ? "bg-destructive/15 text-destructive"
                    : r.severity === "warning" ? "bg-warning/15 text-warning"
                    : "bg-info/15 text-info"
                  }`}>
                    {r.severity}
                  </span>
                </TableCell>
                <TableCell className="text-foreground text-xs max-w-[420px]">
                  <div className="font-medium truncate">{r.title}</div>
                  <div className="text-muted-foreground text-[11px] truncate">{r.message}</div>
                </TableCell>
                <TableCell>
                  {r.resolved_at ? (
                    <span className="text-[11px] text-primary flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Resolvido
                    </span>
                  ) : (
                    <span className="text-[11px] text-warning">Ativo</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
