// Fila de reconciliação de autoria — Setor Técnico, platform_admin/owner.
// Você vê o LOTE, escolhe o usuário UMA vez, e o sistema aplica a todos os poços
// daquele lote com auditoria. Sem revisar evento por evento.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RefreshCw, UserCheck, Lock, AlertTriangle } from "lucide-react";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useFarmAccess } from "@/hooks/useFarmAccess";
import { toast } from "sonner";

interface QueueRow {
  id: string; batch_id: string; started_at: string; ended_at: string; intent: string;
  event_ids: string[]; events_total: number; events_unnamed: number;
  suggested_user: string | null; candidates: Array<{ user_id: string; nome: string; email: string; fonte: string; forca: string }>;
  status: string;
}
interface Profile { id: string; full_name: string | null; email: string | null }

const brt = (t: string) =>
  new Date(t).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

export default function AuthorshipReconciliationQueue() {
  const farmId = useDefaultFarmId();
  const { role } = useFarmAccess();
  const canView = role === "platform_admin" || role === "owner";
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [people, setPeople] = useState<Profile[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!farmId || !canView) { setLoading(false); return; }
    setLoading(true);
    const [{ data: q }, { data: p }] = await Promise.all([
      supabase.from("remote_reconciliation_queue" as any)
        .select("*").eq("farm_id", farmId).eq("status", "pending")
        .order("started_at", { ascending: false }).limit(200),
      supabase.from("profiles").select("id, full_name, email").order("full_name").limit(500),
    ]);
    setRows((q ?? []) as unknown as QueueRow[]);
    setPeople((p ?? []) as unknown as Profile[]);
    setLoading(false);
  }, [farmId, canView]);

  useEffect(() => { void load(); }, [load]);

  // Realtime: a fila reflete o backfill sem polling do browser.
  useEffect(() => {
    if (!farmId || !canView) return;
    const ch = supabase.channel(`rrq:${farmId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "remote_reconciliation_queue", filter: `farm_id=eq.${farmId}` },
        () => { void load(); })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [farmId, canView, load]);

  const nameOf = useMemo(() => {
    const m = new Map(people.map((p) => [p.id, p.full_name || p.email || p.id]));
    return (id?: string | null) => (id ? m.get(id) ?? id : null);
  }, [people]);

  async function apply(row: QueueRow) {
    const userId = choice[row.id] ?? row.suggested_user ?? "";
    if (!userId) { toast.error("Selecione o usuário responsável pelo lote."); return; }
    setBusy(row.id);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const executor = auth?.user?.id;
      if (!executor) { toast.error("Sessão sem usuário — refaça o login."); return; }
      // O RPC congela os ids e ABORTA se o conjunto mudou desde a conferência.
      const { data, error } = await supabase.rpc("apply_remote_reconciliation" as any, {
        _queue_id: row.id, _user_id: userId, _expected_ids: row.event_ids,
        _executor: executor,
        _evidence: `Reconciliação em lote pelo Setor Técnico — ${row.events_unnamed} evento(s) do lote ${row.batch_id}`,
      });
      if (error) { toast.error(`Não aplicado: ${error.message}`); return; }
      toast.success(`${data ?? 0} evento(s) atribuídos a ${nameOf(userId)}.`);
      await load();
    } finally { setBusy(null); }
  }

  if (!canView) {
    return <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
      <Lock className="w-4 h-4" /> Reconciliação restrita a platform_admin/owner.</div>;
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-1.5">
              <UserCheck className="w-4 h-4" /> Reconciliação de autoria ({rows.length} lote(s))
            </CardTitle>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Escolha o responsável <strong>uma vez por lote</strong>. O sistema grava o nome em todos os
              eventos daquele lote, com auditoria. Eventos locais e de automação nunca são tocados.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Atualizar
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">Carregando…</div>
        ) : rows.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            Nenhum lote pendente — toda autoria remota desta fazenda está atribuída.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="text-xs">
              <TableHeader><TableRow>
                <TableHead>Período (BRT)</TableHead><TableHead>Ação</TableHead>
                <TableHead>Eventos</TableHead><TableHead>Sem nome</TableHead>
                <TableHead>Candidatas</TableHead><TableHead>Responsável</TableHead><TableHead />
              </TableRow></TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const conflito = (r.candidates?.length ?? 0) > 1;
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap">
                        {brt(r.started_at)}<br />
                        <span className="text-muted-foreground">até {brt(r.ended_at)}</span>
                      </TableCell>
                      <TableCell>{r.intent === "ligar" ? "Ligar" : "Desligar"}</TableCell>
                      <TableCell className="tabular-nums">{r.events_total}</TableCell>
                      <TableCell className="tabular-nums font-semibold text-warning">{r.events_unnamed}</TableCell>
                      <TableCell>
                        {conflito && (
                          <Badge variant="outline" className="bg-warning/10 text-warning border-warning/40 mb-1">
                            <AlertTriangle className="w-3 h-3 mr-1" /> {r.candidates.length} pessoas
                          </Badge>
                        )}
                        <div className="text-[10px] text-muted-foreground">
                          {(r.candidates ?? []).map((c) => `${c.nome ?? c.email} (${c.fonte})`).join(" · ") || "—"}
                        </div>
                      </TableCell>
                      <TableCell className="min-w-[180px]">
                        <Select value={choice[r.id] ?? r.suggested_user ?? ""}
                                onValueChange={(v) => setChoice((s) => ({ ...s, [r.id]: v }))}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Selecione…" /></SelectTrigger>
                          <SelectContent>
                            {people.map((p) => (
                              <SelectItem key={p.id} value={p.id}>{p.full_name || p.email}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Button size="sm" disabled={busy === r.id} onClick={() => void apply(r)}>
                          {busy === r.id ? "Aplicando…" : "Aplicar ao lote"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
