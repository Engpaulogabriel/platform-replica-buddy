import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useFarmAccess } from "@/hooks/useFarmAccess";
import { useUserFarms } from "@/hooks/useUserFarms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Download, FileText, Search, MessageSquare, Shield, Loader2, Users, Users2 } from "lucide-react";
import type { Contact } from "@/lib/whatsappHistory";
import {
  DEFAULT_RANGE_DAYS, PAGE_SIZE, CONTACT_PAGE_SIZE, MAX_ROWS,
  localDateString, dateRangeToIso, formatPhone, canonPhone, phoneSuffix8,
  buildContacts, pageRange, hasMorePages, mergeUnique, createRequestGuard,
  type ContactSeed,
} from "@/lib/whatsappHistory";
import { toast } from "sonner";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

type Row = {
  id: string;
  direction: "incoming" | "outgoing";
  phone: string;
  operator_name: string | null;
  operator_id: string | null;
  farm_id: string | null;
  message_type: string | null;
  message_body: string | null;
  message_id: string | null;
  command_parsed: string | null;
  command_result: string | null;
  metadata: Record<string, unknown> | null;
  timestamp_meta: string | null;
  created_at: string;
};

const COMMAND_FILTERS = [
  { value: "all", label: "Todos comandos" },
  { value: "liga", label: "Liga" },
  { value: "desliga", label: "Desliga" },
  { value: "status", label: "Status" },
  { value: "nivel", label: "Nível" },
  { value: "auto", label: "Automático" },
  { value: "manual", label: "Manual" },
  { value: "prog", label: "Programações" },
];

function resultBadge(result: string | null) {
  if (!result) return null;
  const map: Record<string, { label: string; cls: string }> = {
    executed: { label: "✅ Executado", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
    command_executed: { label: "✅ Executado", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
    sent: { label: "Enviado", cls: "bg-muted text-muted-foreground" },
    confirmation_requested: { label: "⏳ Aguardando SIM", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
    pending_confirmation: { label: "⏳ Aguardando SIM", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
    command_expired: { label: "⏰ Expirado", cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
    status_sent: { label: "ℹ️ Status", cls: "bg-sky-500/15 text-sky-400 border-sky-500/30" },
    cancelled: { label: "❌ Cancelado", cls: "bg-rose-500/15 text-rose-400 border-rose-500/30" },
    error: { label: "⚠️ Erro", cls: "bg-rose-500/15 text-rose-400 border-rose-500/30" },
  };
  const hit = map[result] ?? (result.startsWith("error") ? map.error : { label: result, cls: "bg-muted text-muted-foreground" });
  return <Badge variant="outline" className={`text-[10px] ${hit.cls}`}>{hit.label}</Badge>;
}

export default function HistoricoWhatsApp() {
  const { isPlatformAdmin, canEditConfig, loading: accessLoading } = useFarmAccess();
  const { farms } = useUserFarms();

  const [rows, setRows] = useState<Row[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [selectedPhone, setSelectedPhone] = useState<string>("");
  // 30 dias: nos últimos 7 há 6 mensagens; nos últimos 30, 10.122.
  const [dateFrom, setDateFrom] = useState(localDateString(DEFAULT_RANGE_DAYS));
  const [dateTo, setDateTo] = useState(localDateString(0));
  const [farmFilter, setFarmFilter] = useState<string>("all");
  const [commandFilter, setCommandFilter] = useState("all");
  // Paginação das mensagens — substitui o .limit(2000) que truncava calado.
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [contactsTruncated, setContactsTruncated] = useState(false);

  // Só a requisição mais recente escreve no estado. Trocar de contato ou de
  // período rápido não deixa mais a resposta antiga sobrescrever a nova.
  const msgGuard = useRef(createRequestGuard()).current;
  const contactGuard = useRef(createRequestGuard()).current;

  const canAccess = isPlatformAdmin || canEditConfig;

  /** Mensagem legível de um erro desconhecido, sem recorrer a `any`. */
  const errMsg = (e: unknown): string =>
    e instanceof Error ? e.message : String(e);

  // ── Lista lateral: TODO o histórico acessível, SEM filtro de data ────────
  // A causa do bug: antes esta query usava a mesma janela das mensagens. Com
  // 26/08–02/09 só o Jonatan tinha tráfego, então os outros 26 contatos
  // sumiam da barra lateral — parecia exclusão. Data agora filtra APENAS as
  // mensagens do painel central. O escopo de FAZENDA continua valendo aqui,
  // porque é acesso, não recorte temporal.
  const loadContacts = async () => {
    const token = contactGuard.begin();
    setContactsLoading(true);
    setContactsTruncated(false);
    try {
      const seeds: ContactSeed[] = [];
      let p = 0;
      let truncated = false;
      // Paginação das linhas leves (4 colunas). Sem o .limit(5000) mudo.
      for (;;) {
        const [rFrom, rTo] = pageRange(p, CONTACT_PAGE_SIZE);
        let q = supabase
          .from("whatsapp_message_log")
          .select("phone, operator_name, created_at, farm_id")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(rFrom, rTo);
        if (farmFilter !== "all") q = q.eq("farm_id", farmFilter);
        const { data, error } = await q;
        if (error) throw error;
        const batch = (data ?? []) as ContactSeed[];
        seeds.push(...batch);
        if (!hasMorePages(batch.length, CONTACT_PAGE_SIZE)) break;
        if (seeds.length >= MAX_ROWS) { truncated = true; break; }
        p += 1;
      }
      if (!contactGuard.isCurrent(token)) return;   // filtro mudou: descarta
      setContacts(buildContacts(seeds));
      setContactsTruncated(truncated);
    } catch (e: unknown) {
      if (!contactGuard.isCurrent(token)) return;
      toast.error("Falha ao carregar contatos: " + errMsg(e));
    } finally {
      if (contactGuard.isCurrent(token)) setContactsLoading(false);
    }
  };

  /** Uma página de mensagens do filtro atual. Usada pela tela e pela exportação. */
  const fetchMessagePage = async (pageIndex: number): Promise<Row[]> => {
    const { from, to } = dateRangeToIso(dateFrom, dateTo);
    const [rFrom, rTo] = pageRange(pageIndex, PAGE_SIZE);
    let q = supabase
      .from("whatsapp_message_log")
      .select("*")
      .gte("created_at", from)
      .lte("created_at", to)
      // Ordenação ESTÁVEL: created_at pode empatar; o id desempata e impede
      // que uma linha pule de página.
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(rFrom, rTo);
    if (selectedPhone) {
      const suffix = phoneSuffix8(selectedPhone);
      q = suffix ? q.ilike("phone", `%${suffix}`) : q.eq("phone", selectedPhone);
    }
    if (farmFilter !== "all") q = q.eq("farm_id", farmFilter);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Row[];
  };

  const load = async () => {
    const token = msgGuard.begin();
    setLoading(true);
    try {
      const first = await fetchMessagePage(0);
      if (!msgGuard.isCurrent(token)) return;
      setRows(first);
      setPage(0);
      setHasMore(hasMorePages(first.length, PAGE_SIZE));
    } catch (e: unknown) {
      if (!msgGuard.isCurrent(token)) return;
      toast.error("Falha ao carregar histórico: " + errMsg(e));
    } finally {
      if (msgGuard.isCurrent(token)) setLoading(false);
    }
  };

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    const token = msgGuard.begin();
    setLoadingMore(true);
    try {
      const next = page + 1;
      const batch = await fetchMessagePage(next);
      if (!msgGuard.isCurrent(token)) return;
      // mergeUnique: entre duas páginas pode chegar mensagem nova e deslocar o
      // offset. Sem isso, a linha da borda apareceria duas vezes.
      setRows((prev) => mergeUnique(prev, batch));
      setPage(next);
      setHasMore(hasMorePages(batch.length, PAGE_SIZE));
    } catch (e: unknown) {
      if (!msgGuard.isCurrent(token)) return;
      toast.error("Falha ao carregar mais: " + errMsg(e));
    } finally {
      if (msgGuard.isCurrent(token)) setLoadingMore(false);
    }
  };

  /**
   * Conjunto COMPLETO do filtro atual, para exportar. CSV e PDF não podem sair
   * só com as páginas que o usuário rolou na tela.
   */
  const fetchAllForExport = async (): Promise<Row[]> => {
    let all: Row[] = [];
    let p = 0;
    for (;;) {
      const batch = await fetchMessagePage(p);
      all = mergeUnique(all, batch);
      if (!hasMorePages(batch.length, PAGE_SIZE)) break;
      if (all.length >= MAX_ROWS) {
        toast.warning(`Exportação limitada a ${MAX_ROWS.toLocaleString("pt-BR")} registros.`);
        break;
      }
      p += 1;
    }
    return all;
  };

  useEffect(() => {
    if (canAccess) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAccess, dateFrom, dateTo, farmFilter, selectedPhone]);

  // Sem dateFrom/dateTo nas dependências: a lista lateral é histórica e não
  // pode encolher porque o usuário estreitou o período. Só fazenda a redefine.
  useEffect(() => {
    if (canAccess) void loadContacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAccess, farmFilter]);

  const filteredContacts = useMemo(() => {
    const s = contactSearch.trim().toLowerCase();
    if (!s) return contacts;
    return contacts.filter((c) => c.name.toLowerCase().includes(s) || c.phone.includes(s.replace(/\D/g, "")));
  }, [contacts, contactSearch]);

  const groupedContacts = useMemo(() => {
    const groups = new Map<string, { farmId: string | null; farmName: string; items: Contact[] }>();
    for (const c of filteredContacts) {
      const key = c.farmId ?? "__none__";
      const farmName = c.farmId
        ? (farms.find((f) => f.id === c.farmId)?.name ?? "Fazenda desconhecida")
        : "Sem fazenda";
      const g = groups.get(key);
      if (g) g.items.push(c);
      else groups.set(key, { farmId: c.farmId, farmName, items: [c] });
    }
    // Sort groups by farm name (assigned farms first, "Sem fazenda" last)
    return Array.from(groups.values()).sort((a, b) => {
      if (!a.farmId && b.farmId) return 1;
      if (a.farmId && !b.farmId) return -1;
      return a.farmName.localeCompare(b.farmName, "pt-BR");
    });
  }, [filteredContacts, farms]);


  // Busca e filtro de comando são locais. Extraídos do useMemo para que a
  // exportação aplique EXATAMENTE os mesmos critérios da tela.
  const applyLocalFilters = (list: Row[]): Row[] => {
    const s = search.trim().toLowerCase();
    return list.filter((r) => {
      if (commandFilter !== "all") {
        const cp = (r.command_parsed ?? "").toLowerCase();
        const body = (r.message_body ?? "").toLowerCase();
        if (!cp.includes(commandFilter) && !body.includes(commandFilter)) return false;
      }
      if (!s) return true;
      return (
        (r.message_body ?? "").toLowerCase().includes(s) ||
        (r.operator_name ?? "").toLowerCase().includes(s) ||
        (r.phone ?? "").toLowerCase().includes(s) ||
        (r.command_parsed ?? "").toLowerCase().includes(s)
      );
    });
  };

  const filtered = useMemo(() => applyLocalFilters(rows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, search, commandFilter]);

  const exportCSV = async () => {
    setExporting(true);
    let all: Row[];
    try {
      all = applyLocalFilters(await fetchAllForExport());
    } catch (e: unknown) {
      toast.error("Falha ao exportar: " + errMsg(e));
      setExporting(false);
      return;
    }
    setExporting(false);
    const headers = ["created_at", "direction", "phone", "operator_name", "farm_id", "message_type", "message_body", "message_id", "command_parsed", "command_result", "timestamp_meta"];
    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return `"${s.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
    };
    const lines = [headers.join(",")];
    for (const r of all) {
      lines.push(headers.map((h) => escape((r as unknown as Record<string, unknown>)[h])).join(","));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `whatsapp-audit_${dateFrom}_${dateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPDF = async () => {
    setExporting(true);
    let all: Row[];
    try {
      all = applyLocalFilters(await fetchAllForExport());
    } catch (e: unknown) {
      toast.error("Falha ao exportar: " + errMsg(e));
      setExporting(false);
      return;
    }
    setExporting(false);
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("Relatório de Auditoria — Gestor de Bombas", pageWidth / 2, 40, { align: "center" });
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text("Renov Tecnologia Agrícola", pageWidth / 2, 56, { align: "center" });

    const farmName = farmFilter === "all" ? "Todas" : (farms.find((f) => f.id === farmFilter)?.name ?? farmFilter);
    doc.setFontSize(9);
    doc.text(
      `Período: ${dateFrom} a ${dateTo}  |  Fazenda: ${farmName}  |  Telefone: ${selectedPhone || "todos"}  |  Registros: ${all.length}`,
      40,
      78,
    );

    autoTable(doc, {
      startY: 92,
      head: [["Data/Hora", "Dir.", "Telefone", "Operador", "Mensagem", "Resultado", "Message ID"]],
      body: all.map((r) => [
        new Date(r.created_at).toLocaleString("pt-BR"),
        r.direction === "incoming" ? "↓ IN" : "↑ OUT",
        r.phone,
        r.operator_name ?? "—",
        (r.message_body ?? "").slice(0, 200),
        r.command_result ?? "",
        r.message_id ?? "",
      ]),
      styles: { fontSize: 7, cellPadding: 3, overflow: "linebreak" },
      headStyles: { fillColor: [66, 147, 80] },
      columnStyles: {
        0: { cellWidth: 75 },
        1: { cellWidth: 32 },
        2: { cellWidth: 75 },
        3: { cellWidth: 70 },
        4: { cellWidth: "auto" },
        5: { cellWidth: 70 },
        6: { cellWidth: 80 },
      },
      didDrawPage: () => {
        const h = doc.internal.pageSize.getHeight();
        doc.setFontSize(7);
        doc.setTextColor(120);
        doc.text(
          `Documento gerado automaticamente em ${new Date().toLocaleString("pt-BR")}. Dados extraídos do sistema de registro Meta WhatsApp Business API. Message IDs verificáveis junto à Meta Platforms Inc.`,
          40,
          h - 20,
          { maxWidth: pageWidth - 80 },
        );
        doc.setTextColor(0);
      },
    });

    doc.save(`whatsapp-audit_${dateFrom}_${dateTo}.pdf`);
  };

  if (accessLoading) {
    return <div className="p-6 text-muted-foreground">Carregando permissões…</div>;
  }

  if (!canAccess) {
    return (
      <div className="p-6 max-w-xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Shield className="w-5 h-5" /> Acesso restrito</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            O histórico de conversas do WhatsApp é restrito a gestores e administradores da plataforma.
          </CardContent>
        </Card>
      </div>
    );
  }

  const ContactsPanel = (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1.5">
            <Users2 className="w-3.5 h-3.5" /> Contatos ({contacts.length})
          </div>
          {contactsLoading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={contactSearch}
            onChange={(e) => setContactSearch(e.target.value)}
            className="pl-7 h-8 text-xs"
            placeholder="Buscar nome ou número..."
          />
        </div>
        <Button
          variant={selectedPhone === "" ? "default" : "outline"}
          size="sm"
          className="w-full h-8 text-xs"
          onClick={() => setSelectedPhone("")}
        >
          <Users className="w-3.5 h-3.5 mr-1.5" /> Todos os contatos
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {contactsTruncated && (
          <div className="px-2 pb-2 text-[11px] text-amber-500">
            Lista limitada a {MAX_ROWS.toLocaleString("pt-BR")} registros — pode haver contatos não exibidos.
          </div>
        )}
        {filteredContacts.length === 0 && !contactsLoading && (
          <div className="p-4 text-xs text-muted-foreground text-center">Nenhum contato no período.</div>
        )}
        {groupedContacts.map((group) => (
          <div key={group.farmId ?? "__none__"}>
            <div className="sticky top-0 z-10 px-3 py-1.5 bg-muted/80 backdrop-blur border-y border-border/60 text-[11px] font-bold uppercase tracking-wide text-foreground/80 flex items-center justify-between">
              <span className="truncate">{group.farmName}</span>
              <span className="text-muted-foreground font-medium normal-case">{group.items.length}</span>
            </div>
            {group.items.map((c) => {
              const active = c.phone === selectedPhone;
              return (
                <button
                  key={c.phone}
                  onClick={() => setSelectedPhone(c.phone)}
                  className={`w-full text-left px-3 py-2 border-b border-border/50 hover:bg-muted/50 transition-colors ${
                    active ? "bg-emerald-500/10 border-l-2 border-l-emerald-500" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{c.name}</div>
                      <div className="text-[10px] text-muted-foreground truncate font-mono">{formatPhone(c.phone)}</div>
                    </div>
                    <Badge variant="secondary" className="text-[10px] shrink-0">{c.count}</Badge>
                  </div>
                  <div className="text-[9px] text-muted-foreground/70 mt-0.5">
                    {new Date(c.lastAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );

  const selectedContact = contacts.find((c) => c.phone === selectedPhone);

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MessageSquare className="w-6 h-6 text-emerald-500" />
            Histórico de Conversas WhatsApp
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Trilha de auditoria imutável. Mensagens armazenadas por 5 anos conforme boas práticas de auditoria.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="md:hidden">
                <Users className="w-4 h-4 mr-2" /> Contatos
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-[85vw] sm:w-80">
              <SheetHeader className="p-3 border-b">
                <SheetTitle className="text-sm">Contatos</SheetTitle>
              </SheetHeader>
              <div className="h-[calc(100vh-60px)]">{ContactsPanel}</div>
            </SheetContent>
          </Sheet>
          <Button variant="outline" size="sm" onClick={() => void exportCSV()} disabled={!filtered.length || exporting}>
            <Download className="w-4 h-4 mr-2" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => void exportPDF()} disabled={!filtered.length || exporting}>
            <FileText className="w-4 h-4 mr-2" /> Exportar Relatório (PDF)
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[240px_1fr] lg:grid-cols-[280px_1fr]">
        {/* Contacts sidebar (desktop) */}
        <Card className="hidden md:block h-[calc(100vh-180px)] min-h-[500px] overflow-hidden">
          {ContactsPanel}
        </Card>

        {/* Conversation area */}
        <div className="space-y-4 min-w-0">
          <Card>
            <CardContent className="pt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="sm:col-span-2">
                <Label className="text-xs">Buscar (mensagem, operador, telefone)</Label>
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" placeholder="Pesquisar..." />
                </div>
              </div>
              <div>
                <Label className="text-xs">De</Label>
                <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Até</Label>
                <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Comando</Label>
                <Select value={commandFilter} onValueChange={setCommandFilter}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {COMMAND_FILTERS.map((c) => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {isPlatformAdmin && farms.length > 1 && (
                <div className="sm:col-span-2">
                  <Label className="text-xs">Fazenda</Label>
                  <Select value={farmFilter} onValueChange={setFarmFilter}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todas as fazendas</SelectItem>
                      {farms.map((f) => (
                        <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 min-w-0">
                  {selectedContact ? (
                    <>
                      <span className="truncate">{selectedContact.name}</span>
                      <span className="text-[10px] font-mono text-muted-foreground truncate">{formatPhone(selectedContact.phone)}</span>
                    </>
                  ) : (
                    <span>Todos os contatos</span>
                  )}
                  <span className="text-muted-foreground">•</span>
                  <span className="text-muted-foreground">{loading ? "Carregando…" : `${filtered.length} msg`}</span>
                </span>
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!loading && filtered.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-8">
                  Nenhuma mensagem encontrada no período selecionado.
                </div>
              )}
              <div className="space-y-2 max-h-[65vh] overflow-y-auto pr-2">
                {filtered.slice().reverse().map((r) => {
                  const isIn = r.direction === "incoming";
                  const isCommand = !!r.command_parsed;
                  return (
                    <div key={r.id} className={`flex ${isIn ? "justify-start" : "justify-end"}`}>
                      <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                        isIn
                          ? isCommand
                            ? "bg-amber-500/10 border border-amber-500/30"
                            : "bg-muted"
                          : "bg-emerald-600/15 border border-emerald-600/30"
                      }`}>
                        <div className="text-[10px] text-muted-foreground flex items-center gap-2 mb-1">
                          <span className="font-medium">
                            {isIn ? (r.operator_name ?? r.phone) : "Bot Renov"}
                          </span>
                          <span>•</span>
                          <span>{new Date(r.created_at).toLocaleString("pt-BR")}</span>
                          {r.message_type && r.message_type !== "text" && (
                            <Badge variant="outline" className="text-[9px]">{r.message_type}</Badge>
                          )}
                          {!isIn && resultBadge(r.command_result)}
                        </div>
                        <div className="whitespace-pre-wrap break-words">{r.message_body ?? <em className="text-muted-foreground">(sem texto)</em>}</div>
                        {r.message_id && (
                          <div className="text-[9px] text-muted-foreground/70 mt-1 font-mono">id: {r.message_id}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {hasMore && (
                <div className="pt-3 flex items-center justify-center gap-3">
                  <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
                    Carregar mais
                  </Button>
                  <span className="text-[11px] text-muted-foreground">
                    {rows.length.toLocaleString("pt-BR")} carregadas
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
