import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Bot, ChevronLeft, ChevronRight, Download, Eye, FileText, Hand, MessageCircle, Monitor, Power, Radio, RefreshCw, Server, WifiOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAutomationLog, loadAutomationLogRange, type AutomationLogEntry } from "@/lib/automationLog";
import { exportAutomacaoCSV, exportAutomacaoPDF } from "@/lib/reportExport";
import { notifyReport } from "@/lib/notify";

interface AutomacaoReportTabProps {
  farmId: string | null;
  fromDate: string;
  toDate: string;
  selectedPump: string;
}

const LOG_PAGE_SIZE = 50;

const SYSTEM_USER_LABELS = new Set<string>([
  "Acionamento Local",
  "Local (painel)",
  "Automação",
  "Sistema",
  "Operador",
  "Usuário",
  "Desconhecido",
]);

const SYSTEM_ACTIONS = new Set<string>([
  "Sem resposta",
  "Equipamento religado",
  "Reinício do agente",
  "Atualização OTA",
  "Leitura OK",
]);

function getOriginIcon(origin: string) {
  if (origin === "Automático") return <Bot className="w-4 h-4 text-primary" />;
  if (origin === "Remoto") return <Monitor className="w-4 h-4 text-info" />;
  if (origin === "Sistema") return <Server className="w-4 h-4 text-muted-foreground" />;
  if (origin === "WhatsApp") return <MessageCircle className="w-4 h-4 text-[#25D366]" />;
  return <Hand className="w-4 h-4 text-warning" />;
}

function getOriginLabel(origin: string) {
  if (origin === "Manual") return "Local";
  return origin;
}

function getOriginBadge(origin: string) {
  const styles: Record<string, string> = {
    "Automático": "bg-primary/10 text-primary",
    "Remoto": "bg-info/10 text-info",
    "Manual": "bg-warning/15 text-warning border border-warning/30",
    "Sistema": "bg-muted text-muted-foreground border border-border",
    "WhatsApp": "bg-[#25D366]/10 text-[#1ea952] border border-[#25D366]/30",
  };
  return styles[origin] || "bg-secondary text-muted-foreground";
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
  return user && user.trim() ? user.trim() : "Sistema";
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
  const [showReadings, setShowReadings] = useState(false);
  const [logPage, setLogPage] = useState(1);
  const [loadingRange, setLoadingRange] = useState(false);
  const [farmHeader, setFarmHeader] = useState<{ name: string; city: string | null; state: string | null }>({ name: "Fazenda", city: null, state: null });
  const [farmMemberLabels, setFarmMemberLabels] = useState<Set<string>>(new Set());

  const liveAutomationLog = useAutomationLog((s) => s.entries);
  // Defer expensive re-filter when store updates rapidly (Realtime / boot hydration)
  const rawAutomationLog = useDeferredValue(liveAutomationLog);
  const setActiveFarm = useAutomationLog((s) => s.setActiveFarm);

  useEffect(() => {
    if (!farmId) return;
    setActiveFarm(farmId);
    let cancelled = false;
    (async () => {
      const [{ data: farm }, { data: roles }] = await Promise.all([
        supabase
          .from("farms")
          .select("name, city, state")
          .eq("id", farmId)
          .maybeSingle(),
        supabase
          .from("user_roles")
          .select("user_id")
          .eq("farm_id", farmId),
      ]);

      if (cancelled) return;
      if (farm) setFarmHeader({ name: farm.name ?? "Fazenda", city: farm.city ?? null, state: farm.state ?? null });

      const ids = Array.from(new Set((roles ?? []).map((r: any) => r.user_id).filter(Boolean)));
      if (ids.length === 0) {
        setFarmMemberLabels(new Set());
        return;
      }

      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", ids);

      if (cancelled) return;
      const labels = new Set<string>();
      for (const p of (profs ?? []) as Array<{ full_name: string | null; email: string | null }>) {
        if (p.full_name) labels.add(p.full_name.trim());
        if (p.email) labels.add(p.email.trim());
      }
      setFarmMemberLabels(labels);
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

  const automationLog = useMemo<AutomationLogEntry[]>(() => {
    if (!farmId) return [];
    return rawAutomationLog
      .filter((e) => !e.farmId || e.farmId === farmId)
      .filter((e) => {
        const t = new Date(e.ts).getTime();
        return t >= rangeBounds.from && t <= rangeBounds.to;
      })
      .filter((e) => {
        const isSystem = SYSTEM_ACTIONS.has(e.action) || e.origin === "Sistema";
        if (isSystem) return false;
        if (!showReadings && e.action === "Leitura OK") return false;
        return e.origin === "Remoto" || e.origin === "Manual" || e.origin === "WhatsApp";
      })
      .map((e) => {
        const u = (e.user ?? "").trim();
        if (!u || SYSTEM_USER_LABELS.has(u) || u === "Agente") return e;
        // WhatsApp actor labels ("WhatsApp · Nome") sempre passam — vêm do webhook.
        if (e.origin === "WhatsApp" || u.startsWith("WhatsApp")) return e;
        if (farmMemberLabels.has(u)) return e;
        return { ...e, user: "Operador" };
      });
  }, [rawAutomationLog, farmId, farmMemberLabels, showReadings, rangeBounds]);

  const filteredLog = useMemo(
    () => (selectedPump === "all"
      ? automationLog
      : automationLog.filter((item) => item.pump === selectedPump)),
    [automationLog, selectedPump]
  );

  useEffect(() => { setLogPage(1); }, [showReadings, selectedPump, fromDate, toDate]);

  const totalLogPages = useMemo(
    () => Math.max(1, Math.ceil(filteredLog.length / LOG_PAGE_SIZE)),
    [filteredLog.length]
  );
  const currentLogPage = Math.min(logPage, totalLogPages);
  const pagedLog = useMemo(
    () => filteredLog.slice((currentLogPage - 1) * LOG_PAGE_SIZE, currentLogPage * LOG_PAGE_SIZE),
    [filteredLog, currentLogPage]
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
              <Button variant="outline" size="sm" className="border-border text-muted-foreground gap-1" onClick={() => {
                const mapped = filteredLog.map(r => ({ ...r, origin: getOriginLabel(r.origin), user: getUserLabel(r.user) }));
                exportAutomacaoCSV(mapped);
                notifyReport.exported("CSV", "Automação");
              }}>
                <Download className="w-3.5 h-3.5" /> CSV
              </Button>
              <Button variant="outline" size="sm" className="border-border text-muted-foreground gap-1" onClick={() => {
                const mapped = filteredLog.map(r => ({ ...r, origin: getOriginLabel(r.origin), user: getUserLabel(r.user), result: r.result ?? "success" }));
                exportAutomacaoPDF(mapped, farmHeader);
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
              Mostrar leituras de status (ruidoso)
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
                  const ok = (item.result ?? "success") === "success";
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
                          <span className="inline-flex items-center gap-1 font-medium text-foreground">{getOriginIcon(item.origin)}{getOriginLabel(item.origin)}</span>
                        </div>
                        <div className="col-span-2">
                          <span className="block text-muted-foreground">Usuário</span>
                          <span className="font-medium text-foreground">{getUserLabel(item.user)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="hidden sm:block w-full max-w-full overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-secondary/50">
                      <TableHead className="text-muted-foreground">Data</TableHead>
                      <TableHead className="text-muted-foreground">Hora</TableHead>
                      <TableHead className="text-muted-foreground">Equipamento</TableHead>
                      <TableHead className="text-muted-foreground">Ação</TableHead>
                      <TableHead className="text-muted-foreground">Origem</TableHead>
                      <TableHead className="text-muted-foreground">Usuário</TableHead>
                      <TableHead className="text-muted-foreground">Resultado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pagedLog.map((item) => {
                      const { cls: actionCls, Icon: ActionIcon } = getActionStyle(item.action);
                      return (
                        <TableRow key={item.id} className="border-border hover:bg-secondary/50">
                          <TableCell className="text-foreground text-sm">{item.date}</TableCell>
                          <TableCell className="text-foreground text-sm font-medium">{item.time}</TableCell>
                          <TableCell className="text-foreground font-medium">{item.pump}</TableCell>
                          <TableCell>
                            <span className={`inline-flex items-center gap-1.5 text-sm font-semibold ${actionCls}`}>
                              <ActionIcon className="w-3.5 h-3.5" /> {item.action}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              {getOriginIcon(item.origin)}
                              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${getOriginBadge(item.origin)}`}>
                                {getOriginLabel(item.origin)}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {getUserLabel(item.user) === "Sistema" ? (
                              <span className="text-warning font-medium">Sistema</span>
                            ) : (
                              <span className="text-foreground">{getUserLabel(item.user)}</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {(item.result ?? "success") === "success" ? (
                              <span className="text-[11px] font-medium text-primary">OK</span>
                            ) : (
                              <span className="text-[11px] font-medium text-destructive">Falhou</span>
                            )}
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
    </div>
  );
}