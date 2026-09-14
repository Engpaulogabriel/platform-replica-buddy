import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Bot, ChevronLeft, ChevronRight, Download, Eye, FileText, Hand, MessageCircle, Monitor, Power, Radio, RefreshCw, Server, WifiOff, Workflow } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAutomationLog, loadAutomationLogRange, loadTechnicalReadings, type AutomationLogEntry, type AutomationOrigin, type TechnicalReading } from "@/lib/automationLog";
import { useFarmAccess } from "@/hooks/useFarmAccess";
import { exportAutomacaoCSV, exportAutomacaoPDF } from "@/lib/reportExport";
import { notifyReport } from "@/lib/notify";
import {
  resolveReportOrigin, REPORT_ORIGIN_ICON, REPORT_ORIGIN_ICON_CLASS, REPORT_ORIGIN_BADGE,
} from "@/lib/reportOrigin";
import { guardExport } from "@/lib/securityClient";
import { toast } from "sonner";

interface AutomacaoReportTabProps {
  farmId: string | null;
  fromDate: string;
  toDate: string;
  selectedPump: string;
}

const LOG_PAGE_SIZE = 50;

// Resultado do comando: "OK" para success / executed / ok / null (comando enviado
// sem erro). Só "Falhou" para fail / failed / timeout / error explícitos. (Mesma
// regra do resultLabel em reportExport.ts — o agente registra "executed".)
const isResultOk = (result?: string | null): boolean => {
  const s = String(result ?? "").trim().toLowerCase();
  return !(s === "fail" || s === "failed" || s === "timeout" || s === "error");
};

const SYSTEM_ACTIONS = new Set<string>([
  "Sem resposta",
  "Equipamento religado",
  "Reinício do agente",
  "Atualização OTA",
  "Leitura OK",
]);

/** ORIGEM: quatro casos do produto — Remoto, Local, Automação e Modo
 *  Automático. A decisão mora em `@/lib/reportOrigin` (puro e testado); aqui
 *  fica só o mapeamento nome-do-ícone → componente lucide. */
const ORIGIN_ICON_COMPONENT = {
  Monitor, Hand, Workflow, Bot, MessageCircle, Server,
} as const;

function getOriginIcon(origin: string, sourceDevice?: string | null) {
  const o = resolveReportOrigin(origin, sourceDevice);
  const Icon = ORIGIN_ICON_COMPONENT[REPORT_ORIGIN_ICON[o] ?? "Hand"] ?? Hand;
  return <Icon className={`w-4 h-4 ${REPORT_ORIGIN_ICON_CLASS[o] ?? "text-warning"}`} />;
}

function getOriginLabel(origin: string, sourceDevice?: string | null) {
  return resolveReportOrigin(origin, sourceDevice);
}

function getOriginBadge(origin: string, sourceDevice?: string | null) {
  return REPORT_ORIGIN_BADGE[resolveReportOrigin(origin, sourceDevice)]
      ?? "bg-secondary text-muted-foreground";
}

function getActionStyle(action: string): { cls: string; Icon: typeof Power } {
  switch (action) {
    case "Ligada":
      return { cls: "text-primary", Icon: Power };
    case "Desligada":
      return { cls: "text-destructive", Icon: Power };
    case "Sem resposta":
      return { cls: "text-warning", Icon: WifiOff };
    case "Equipamento religado":
      return { cls: "text-primary", Icon: Radio };
    case "Reinício do agente":
      return { cls: "text-warning", Icon: RefreshCw };
    case "Atualização OTA":
      return { cls: "text-info", Icon: Download };
    case "Leitura OK":
      return { cls: "text-muted-foreground", Icon: Eye };
    default:
      return { cls: "text-foreground", Icon: Power };
  }
}

function getUserLabel(user?: string | null) {
  // actor_label vem pronto do banco (trigger). Usa DIRETO. Sem ator, mostra "—":
  // não inventamos pessoa nem escrevemos "Remoto não identificado". Quando a
  // autoria histórica é comprovadamente indisponível, a frase explicativa fica
  // só na auditoria técnica (agent_technical_events), não no relatório.
  return user && user.trim() ? user.trim() : "—";
}

/** Célula da coluna Usuário. Só nome humano real, nome de regra ou
 *  "Acionamento local". FASE B removeu os rótulos provisórios: um evento sem
 *  autoria provada não chega mais ao relatório oficial — ele fica na fila
 *  administrativa até o platform_admin decidir. Não há fallback genérico. */
function UserCell({ item }: { item: AutomationLogEntry }) {
  const label = getUserLabel(item.user);
  return <span className="text-foreground" title={item.confirmationMethod ?? undefined}>{label}</span>;
}

/** Detalhe técnico do evento — só platform_admin/owner. */
function TechDetail({ item }: { item: AutomationLogEntry }) {
  const t = item.tech;
  if (!t) return null;
  const linhas = [
    `ID do evento: ${t.id}`,
    `Data/hora BRT: ${t.occurredAtBrt}`,
    `origin: ${t.origin || "—"}`,
    `confirmation_method: ${t.confirmationMethod ?? "—"}`,
    `origem declarada pelo agente: ${t.agentDeclaredOrigin ?? "—"}`,
    `autoria (fonte): ${t.authorshipSource ?? "—"}`,
    `autoria (confiança): ${t.authorshipConfidence ?? "—"}`,
    `pendência de revisão: ${t.attributionUnavailable ? "aberta" : "não"}`,
  ];
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
        detalhe técnico
      </summary>
      <div className="mt-1 rounded border border-border bg-muted/40 p-2 text-[10px] font-mono leading-relaxed text-muted-foreground">
        {linhas.map((l) => <div key={l}>{l}</div>)}
      </div>
    </details>
  );
}

function buildPageList(current: number, total: number): Array<number | "..."> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: Array<number | "..."> = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) out.push("...");
  for (let i = start; i <= end; i++) out.push(i);
  if (end < total - 1) out.push("...");
  out.push(total);
  return out;
}

export default function AutomacaoReportTab({ farmId, fromDate, toDate, selectedPump }: AutomacaoReportTabProps) {
  const { role } = useFarmAccess();
  const canSeeTech = role === "platform_admin" || role === "owner";
  const [showReadings, setShowReadings] = useState(false);
  const [logPage, setLogPage] = useState(1);
  const [loadingRange, setLoadingRange] = useState(false);
  const [farmHeader, setFarmHeader] = useState<{ name: string; city: string | null; state: string | null }>({ name: "Fazenda", city: null, state: null });

  const liveAutomationLog = useAutomationLog((s) => s.entries);
  // Defer expensive re-filter when store updates rapidly (Realtime / boot hydration)
  const rawAutomationLog = useDeferredValue(liveAutomationLog);
  const setActiveFarm = useAutomationLog((s) => s.setActiveFarm);

  useEffect(() => {
    if (!farmId) return;
    setActiveFarm(farmId);
    let cancelled = false;
    (async () => {
      // Apenas o cabeçalho da fazenda (nome/cidade/UF) para o PDF. O nome do usuário
      // no relatório vem DIRETO do actor_label do banco — sem JOIN com profiles/user_roles.
      const { data: farm } = await supabase
        .from("farms")
        .select("name, city, state")
        .eq("id", farmId)
        .maybeSingle();
      if (cancelled) return;
      if (farm) setFarmHeader({ name: farm.name ?? "Fazenda", city: farm.city ?? null, state: farm.state ?? null });
    })();
    return () => { cancelled = true; };
  }, [farmId, setActiveFarm]);

  const parsedRange = useMemo(() => {
    if (!fromDate || !toDate) return null;
    const from = new Date(`${fromDate}T00:00:00`);
    const to = new Date(`${toDate}T23:59:59.999`);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return null;
    if (from.getTime() > to.getTime()) return null;
    return { from, to };
  }, [fromDate, toDate]);

  useEffect(() => {
    if (!farmId || !parsedRange) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setLoadingRange(true);
      loadAutomationLogRange(farmId, parsedRange.from.toISOString(), parsedRange.to.toISOString()).finally(() => {
        if (!cancelled) setLoadingRange(false);
      });
    }, 400);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [farmId, parsedRange]);

  const rangeBounds = useMemo(() => {
    if (!parsedRange) return { from: 0, to: 0 };
    return { from: parsedRange.from.getTime(), to: parsedRange.to.getTime() };
  }, [parsedRange]);

  // Telemetria técnica (status_read) — conjunto SEPARADO, carregado só sob demanda.
  // Nunca é mesclado ao histórico oficial.
  const [readings, setReadings] = useState<TechnicalReading[]>([]);
  const [loadingReadings, setLoadingReadings] = useState(false);
  useEffect(() => {
    if (!showReadings || !farmId || !parsedRange) { setReadings([]); return; }
    let cancelled = false;
    setLoadingReadings(true);
    loadTechnicalReadings(farmId, parsedRange.from.toISOString(), parsedRange.to.toISOString())
      .then((rs) => { if (!cancelled) setReadings(rs); })
      .finally(() => { if (!cancelled) setLoadingReadings(false); });
    return () => { cancelled = true; };
  }, [showReadings, farmId, parsedRange]);

  const filteredReadings = useMemo(
    () => (selectedPump === "all" ? readings : readings.filter((r) => r.pump === selectedPump)),
    [readings, selectedPump],
  );

  const automationLog = useMemo<AutomationLogEntry[]>(() => {
    if (!farmId) return [];
    return rawAutomationLog
      .filter((e) => !e.farmId || e.farmId === farmId)
      .filter((e) => {
        const t = new Date(e.ts).getTime();
        return t >= rangeBounds.from && t <= rangeBounds.to;
      })
      .filter((e) => {
        // O relatório NÃO depende de filtro visual para estar correto: a query já
        // devolve só evento operacional canônico (transição confirmada). Aqui
        // resta apenas descartar linhas legadas de ciclo de vida do agente.
        if (SYSTEM_ACTIONS.has(e.action)) return false;
        // Ligada/Desligada de QUALQUER origem é transição confirmada — inclusive
        // origem "Sistema" (telemetria sem autoria). Escondê-la fazia a transição
        // desaparecer do histórico enquanto o dashboard mostrava a bomba ligada.
        return e.action === "Ligada" || e.action === "Desligada";
      });
    // O nome exibido (item.user) vem DIRETO do actor_label do banco (resolveUser já o
    // prioriza) — sem override, sem JOIN com profiles, sem resolver por user_id.
    // null/vazio → "Desconhecido" (getUserLabel).
  }, [rawAutomationLog, farmId, showReadings, rangeBounds]);

  const filteredLog = useMemo(
    () => (selectedPump === "all"
      ? automationLog
      : automationLog.filter((item) => item.pump === selectedPump)),
    [automationLog, selectedPump]
  );

  useEffect(() => { setLogPage(1); }, [showReadings, selectedPump, fromDate, toDate]);

  // ── ARRAY CANÔNICO ────────────────────────────────────────────────────────
  // Tela, CSV e PDF consomem ESTE array. Não existe mais transformação de
  // rótulo separada por formato: a origem e o usuário são resolvidos uma única
  // vez, então os três mostram exatamente as mesmas linhas e os mesmos IDs.
  const canonicalRows = useMemo(
    () => filteredLog.map(r => ({
      ...r,
      // Esta memo monta a linha de APRESENTAÇÃO reaproveitando a forma de
      // AutomationLogEntry e sobrescreve `origin` com o RÓTULO exibido — algo
      // que já acontecia antes desta mudança. O cast mantém a forma; trocar
      // isso por um tipo de linha de exibição próprio é refatoração, e o
      // pedido aqui é visual.
      origin: getOriginLabel(r.origin, r.sourceDevice) as unknown as AutomationOrigin,
      user: getUserLabel(r.user),
    })),
    [filteredLog],
  );

  const totalLogPages = useMemo(
    () => Math.max(1, Math.ceil(filteredLog.length / LOG_PAGE_SIZE)),
    [filteredLog.length]
  );
  const currentLogPage = Math.min(logPage, totalLogPages);
  const pagedLog = useMemo(
    () => canonicalRows.slice((currentLogPage - 1) * LOG_PAGE_SIZE, currentLogPage * LOG_PAGE_SIZE),
    [canonicalRows, currentLogPage]
  );

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border max-w-full overflow-x-clip [transform:translateZ(0)]">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <CardTitle className="text-base text-foreground">Relatório de Automação</CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Tempo real • {filteredLog.length} {filteredLog.length === 1 ? "evento" : "eventos"}
                {totalLogPages > 1 ? ` • página ${currentLogPage}/${totalLogPages}` : ""}
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" size="sm" className="border-border text-muted-foreground gap-1" onClick={async () => {
                const g = await guardExport("csv", "relatorio-automacao.csv");
                if (!g.allowed) { toast.error(`Limite de CSVs por dia atingido (${g.used}/${g.limit}). Fale com o suporte.`); return; }
                exportAutomacaoCSV(canonicalRows);
                notifyReport.exported("CSV", "Automação");
              }}>
                <Download className="w-3.5 h-3.5" /> CSV
              </Button>
              <Button variant="outline" size="sm" className="border-border text-muted-foreground gap-1" onClick={async () => {
                const g = await guardExport("pdf", "relatorio-automacao.pdf");
                if (!g.allowed) { toast.error(`Limite de PDFs por hora atingido (${g.used}/${g.limit}). Fale com o suporte.`); return; }
                exportAutomacaoPDF(canonicalRows, farmHeader);
                notifyReport.exported("PDF", "Automação");
              }}>
                <FileText className="w-3.5 h-3.5" /> PDF
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-3">
            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={showReadings}
                onChange={(e) => setShowReadings(e.target.checked)}
                className="accent-primary"
              />
              Mostrar telemetria técnica em seção separada (não entra no histórico)
            </label>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loadingRange && filteredLog.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">Carregando…</div>
          ) : filteredLog.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <Power className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
              <p className="text-sm font-medium text-foreground">Nenhum evento registrado ainda</p>
              <p className="text-xs text-muted-foreground mt-1">
                Comandos, leituras e falhas aparecerão aqui automaticamente em tempo real.
              </p>
            </div>
          ) : (
            <>
              <div className="sm:hidden divide-y divide-border">
                {pagedLog.map((item) => {
                  const ok = isResultOk(item.result);
                  const { cls: actionCls, Icon: ActionIcon } = getActionStyle(item.action);
                  return (
                    <div key={item.id} className="px-4 py-3 space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-foreground truncate">{item.pump}</p>
                          <p className="text-xs text-muted-foreground">{item.date} às {item.time}</p>
                        </div>
                        <span className={`shrink-0 text-xs font-bold px-2 py-1 rounded-full ${ok ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"}`}>
                          {ok ? "OK" : "Falhou"}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="block text-muted-foreground">Ação</span>
                          <span className={`inline-flex items-center gap-1 font-semibold ${actionCls}`}>
                            <ActionIcon className="w-3.5 h-3.5" /> {item.action}
                          </span>
                        </div>
                        <div>
                          <span className="block text-muted-foreground">Origem</span>
                          <span className="inline-flex items-center gap-1 font-medium text-foreground">{getOriginIcon(item.origin, item.sourceDevice)}{getOriginLabel(item.origin, item.sourceDevice)}</span>
                        </div>
                        <div className="col-span-2">
                          <span className="block text-muted-foreground">Nome</span>
                          {/* só o nome: método de confirmação e detalhe técnico
                              não aparecem no relatório oficial */}
                          <UserCell item={item} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="hidden sm:block w-full max-w-full overflow-x-auto">
                <Table className="md:[&_th]:px-2 md:[&_td]:px-2 md:[&_td]:py-1.5 xl:[&_th]:px-4 xl:[&_td]:p-4">
                  <TableHeader>
                    <TableRow className="border-border hover:bg-secondary/50">
                      <TableHead className="text-muted-foreground">Data</TableHead>
                      <TableHead className="text-muted-foreground">Hora</TableHead>
                      <TableHead className="text-muted-foreground">Poço</TableHead>
                      <TableHead className="text-muted-foreground">Ação</TableHead>
                      <TableHead className="text-muted-foreground">Origem</TableHead>
                      <TableHead className="text-muted-foreground">Nome</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pagedLog.map((item) => {
                      const { cls: actionCls, Icon: ActionIcon } = getActionStyle(item.action);
                      return (
                        <TableRow key={item.id} className="border-border hover:bg-secondary/50">
                          <TableCell className="text-foreground text-sm">{item.date}</TableCell>
                          <TableCell className="text-foreground text-sm font-medium tabular-nums">{item.timeSec ?? item.time}</TableCell>
                          <TableCell className="text-foreground font-medium">{item.pump}</TableCell>
                          <TableCell>
                            <span className={`inline-flex items-center gap-1.5 text-sm font-semibold ${actionCls}`}>
                              <ActionIcon className="w-3.5 h-3.5" /> {item.action}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              {getOriginIcon(item.origin, item.sourceDevice)}
                              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${getOriginBadge(item.origin, item.sourceDevice)}`}>
                                {getOriginLabel(item.origin, item.sourceDevice)}
                              </span>
                            </div>
                          </TableCell>
                          {/* Coluna Usuário = SÓ autoria humana. O método de confirmação
                              física ("Telemetria RF") vive no tooltip, nunca aqui. */}
                          <TableCell className="text-muted-foreground text-sm">
                            {/* SOMENTE o nome. O método de confirmação
                                (Telemetria RF) é técnico e vive apenas em
                                details.confirmation_method, para auditoria —
                                nunca na tela, no CSV ou no PDF oficiais. */}
                            <UserCell item={item} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {totalLogPages > 1 && (
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border flex-wrap">
                  <p className="text-xs text-muted-foreground">
                    Mostrando {(currentLogPage - 1) * LOG_PAGE_SIZE + 1}–{Math.min(currentLogPage * LOG_PAGE_SIZE, filteredLog.length)} de {filteredLog.length}
                  </p>
                  <div className="flex items-center gap-1 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 border-border"
                      onClick={() => setLogPage((p) => Math.max(1, p - 1))}
                      disabled={currentLogPage <= 1}
                      aria-label="Página anterior"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    {buildPageList(currentLogPage, totalLogPages).map((it, idx) =>
                      it === "..." ? (
                        <span key={`e${idx}`} className="px-2 text-xs text-muted-foreground select-none">…</span>
                      ) : (
                        <Button
                          key={it}
                          variant={it === currentLogPage ? "default" : "outline"}
                          size="sm"
                          className="h-8 min-w-8 px-2 border-border"
                          onClick={() => setLogPage(it as number)}
                          aria-current={it === currentLogPage ? "page" : undefined}
                        >
                          {it}
                        </Button>
                      )
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 border-border"
                      onClick={() => setLogPage((p) => Math.min(totalLogPages, p + 1))}
                      disabled={currentLogPage >= totalLogPages}
                      aria-label="Próxima página"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* TELEMETRIA TÉCNICA — seção SEPARADA. Nunca se mistura ao histórico
          oficial: são leituras de estado (polling/eco/reconexão) e comandos que
          não confirmaram, mantidos apenas para diagnóstico. */}
      {showReadings && (
        <Card className="bg-card border-border max-w-full overflow-x-clip">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-1.5">
              <Radio className="w-4 h-4" /> Diagnóstico técnico ({filteredReadings.length})
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Exceções para investigação: timeout de comando, erro de bridge/serial, perda e retorno de
              comunicação, conflito de estado e tentativas não confirmadas. <strong>Não são eventos
              operacionais</strong> — não entram no histórico, no CSV nem no PDF. Retenção de 30 dias.
              Polling, eco e leitura de status não aparecem aqui porque não são gravados em lugar nenhum.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {loadingReadings ? (
              <div className="px-6 py-8 text-center text-sm text-muted-foreground">Carregando telemetria…</div>
            ) : filteredReadings.length === 0 ? (
              <div className="px-6 py-8 text-center text-sm text-muted-foreground">
                Nenhuma leitura técnica no período.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader><TableRow>
                    <TableHead>Data</TableHead><TableHead>Hora</TableHead><TableHead>Equipamento</TableHead>
                    <TableHead>Ocorrência</TableHead><TableHead>Detalhe</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {filteredReadings.slice(0, 300).map((r) => (
                      <TableRow key={r.id} className="opacity-80">
                        <TableCell className="whitespace-nowrap">{r.date}</TableCell>
                        <TableCell className="whitespace-nowrap">{r.time}</TableCell>
                        <TableCell>{r.pump}</TableCell>
                        <TableCell>{r.kindLabel}</TableCell>
                        <TableCell className="text-muted-foreground text-[10px] max-w-[280px] truncate"
                                   title={JSON.stringify(r.details)}>
                          {String(r.details?.intended_action ?? r.details?.hint ?? "—")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {filteredReadings.length > 300 && (
                  <p className="px-4 py-2 text-[11px] text-muted-foreground">
                    Mostrando as 300 mais recentes de {filteredReadings.length}.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}