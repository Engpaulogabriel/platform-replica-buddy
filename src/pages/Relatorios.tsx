import { lazy, Suspense, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Clock, Droplet, Droplets, FileText, Loader2, Power } from "lucide-react";
import AutomacaoReportTab from "@/components/reports/AutomacaoReportTab";
import AuditoriaReportTab from "@/components/reports/AuditoriaReportTab";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useFarmFeatures } from "@/hooks/useFarmFeatures";
import { useAutomationLog } from "@/lib/automationLog";

const NiveisReport = lazy(() => import("@/components/NiveisReport"));
const HorimetroReportTab = lazy(() => import("@/components/reports/HorimetroReportTab"));
const VazaoReportTab = lazy(() => import("@/components/reports/VazaoReportTab"));
const AguaConsumoReportTab = lazy(() => import("@/components/reports/AguaConsumoReportTab"));

type ReportTab = "automacao" | "horimetro" | "niveis" | "vazao" | "agua" | "auditoria";

function ReportLoading({ label = "Carregando relatório..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <span className="ml-3">{label}</span>
    </div>
  );
}

function defaultFromIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

function defaultToIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const Relatorios = () => {
  const [activeTab, setActiveTab] = useState<ReportTab>("automacao");
  const [renderedTab, setRenderedTab] = useState<ReportTab>("automacao");
  const [isPending, startTransition] = useTransition();
  const tabFrameRef = useRef<number | null>(null);
  // (flowEnabled removido — visibilidade da aba agora depende de features.vazao_consumo do banco)
  const [selectedPump, setSelectedPump] = useState("all");
  const [fromDate, setFromDate] = useState<string>(defaultFromIso());
  const [toDate, setToDate] = useState<string>(defaultToIso());
  const [fromDraft, setFromDraft] = useState<string>(fromDate);
  const [toDraft, setToDraft] = useState<string>(toDate);
  const [dateError, setDateError] = useState<string | null>(null);
  const [tabReady, setTabReady] = useState(true);
  const farmId = useDefaultFarmId();
  const features = useFarmFeatures();
  const automationEntries = useAutomationLog((s) => s.entries);

  // Se a aba ativa pertence a um módulo desativado, cair para "automacao"
  useEffect(() => {
    if (features.loading) return;
    if ((activeTab === "niveis" && !features.niveis) ||
        (activeTab === "agua" && !features.vazao_consumo)) {
      changeTab("automacao");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features.loading, features.niveis, features.vazao_consumo, activeTab]);

  // Antigo toggle localStorage 'module_flow' foi migrado para farms.modules.vazao_consumo

  useEffect(() => {
    const prev = document.title;
    document.title = "Relatórios - Gestor de Bombas";
    return () => { document.title = prev; };
  }, []);

  // Debounce + validate date drafts before propagating to report tabs.
  useEffect(() => {
    const isValid = (s: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
      const d = new Date(`${s}T00:00:00`);
      return !isNaN(d.getTime());
    };
    if (!isValid(fromDraft) || !isValid(toDraft)) {
      setDateError("Data inválida");
      return;
    }
    if (new Date(fromDraft) > new Date(toDraft)) {
      setDateError("Data início deve ser anterior à data fim");
      return;
    }
    const MAX_DAYS = 365;
    const diffDays = Math.ceil(
      (new Date(toDraft).getTime() - new Date(fromDraft).getTime()) / (1000 * 60 * 60 * 24),
    );
    if (diffDays > MAX_DAYS) {
      setDateError(`Período máximo: ${MAX_DAYS} dias`);
      return;
    }
    setDateError(null);
    const handle = window.setTimeout(() => {
      setFromDate(fromDraft);
      setToDate(toDraft);
    }, 400);
    return () => window.clearTimeout(handle);
  }, [fromDraft, toDraft]);

  const pumpOptions = useMemo(() => {
    const set = new Set<string>();
    automationEntries
      .filter((e) => !farmId || !e.farmId || e.farmId === farmId)
      .forEach((e) => set.add(e.pump));
    return Array.from(set).sort();
  }, [automationEntries, farmId]);

  const tabButtonClass = (tab: ReportTab) =>
    `inline-flex min-w-0 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
      activeTab === tab
        ? "bg-primary text-primary-foreground"
        : "text-muted-foreground hover:bg-muted hover:text-foreground"
    }`;

  const changeTab = (tab: ReportTab) => {
    if (tab === activeTab) return;
    if (tabFrameRef.current !== null) window.cancelAnimationFrame(tabFrameRef.current);
    setTabReady(false);
    setActiveTab(tab);
    tabFrameRef.current = window.requestAnimationFrame(() => {
      startTransition(() => {
        setRenderedTab(tab);
      });
      tabFrameRef.current = null;
    });
  };

  useEffect(() => {
    if (tabReady) return;
    const id = window.setTimeout(() => setTabReady(true), 0);
    return () => window.clearTimeout(id);
  }, [renderedTab, tabReady]);

  useEffect(() => () => {
    if (tabFrameRef.current !== null) window.cancelAnimationFrame(tabFrameRef.current);
  }, []);

  const showTabLoading = isPending || !tabReady || activeTab !== renderedTab;

  return (
    <div className="space-y-6 min-w-0 max-w-full overflow-x-clip">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Relatórios</h1>
        <p className="text-sm text-muted-foreground mt-1">Automação, horímetro e histórico operacional</p>
      </div>

      <Card className="bg-card border-border max-w-full overflow-x-clip">
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-3 items-end sm:flex sm:flex-wrap">
            <div className="min-w-0">
              <label className="text-xs text-muted-foreground">Data Início</label>
              <Input
                type="date"
                value={fromDraft}
                onChange={(e) => setFromDraft(e.target.value)}
                className="bg-secondary border-border mt-1 w-full sm:w-40"
              />
            </div>
            <div className="min-w-0">
              <label className="text-xs text-muted-foreground">Data Fim</label>
              <Input
                type="date"
                value={toDraft}
                onChange={(e) => setToDraft(e.target.value)}
                className="bg-secondary border-border mt-1 w-full sm:w-40"
              />
            </div>
            <div className="min-w-0 sm:col-span-1">
              <label className="text-xs text-muted-foreground">Equipamento</label>
              <Select value={selectedPump} onValueChange={setSelectedPump}>
                <SelectTrigger className="bg-secondary border-border mt-1 w-full sm:w-40"><SelectValue placeholder="Todos" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {pumpOptions.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {dateError && (
            <p className="mt-2 text-xs text-destructive">{dateError}</p>
          )}
        </CardContent>
      </Card>

      <div className="min-w-0 max-w-full">
        <div className="bg-secondary border border-border grid grid-cols-2 w-full h-auto gap-1 rounded-lg p-1 sm:inline-flex sm:w-auto sm:flex-nowrap">
          <button type="button" className={tabButtonClass("automacao")} onClick={() => changeTab("automacao")}>
            <Power className="w-4 h-4" /> Automação
          </button>
          <button type="button" className={tabButtonClass("horimetro")} onClick={() => changeTab("horimetro")}>
            <Clock className="w-4 h-4" /> Horímetro
          </button>
          {features.niveis && (
            <button type="button" className={tabButtonClass("niveis")} onClick={() => changeTab("niveis")}>
              <Droplet className="w-4 h-4" /> Níveis
            </button>
          )}
          {features.vazao_consumo && (
            <button type="button" className={tabButtonClass("vazao")} onClick={() => changeTab("vazao")}>
              <Droplets className="w-4 h-4" /> Vazão e Consumo
            </button>
          )}
          <button type="button" className={tabButtonClass("auditoria")} onClick={() => changeTab("auditoria")}>
            <FileText className="w-4 h-4" /> Auditoria
          </button>
        </div>

        <Suspense fallback={<ReportLoading />}>
        <div className="mt-4">
          {showTabLoading ? (
            <ReportLoading />
          ) : renderedTab === "automacao" ? (
            <AutomacaoReportTab farmId={farmId} fromDate={fromDate} toDate={toDate} selectedPump={selectedPump} />
          ) : renderedTab === "horimetro" ? (
            <HorimetroReportTab farmId={farmId} fromDate={fromDate} toDate={toDate} selectedPump={selectedPump} />
          ) : renderedTab === "niveis" && features.niveis ? (
            <NiveisReport fromDate={fromDate} toDate={toDate} />
          ) : renderedTab === "vazao" && features.vazao_consumo ? (
            <VazaoReportTab farmId={farmId} fromDate={fromDate} toDate={toDate} />
          ) : renderedTab === "agua" && features.vazao_consumo ? (
            <AguaConsumoReportTab farmId={farmId} fromDate={fromDate} toDate={toDate} selectedPump={selectedPump} />
          ) : renderedTab === "auditoria" ? (
            <AuditoriaReportTab farmId={farmId} />
          ) : null}
        </div>
        </Suspense>
      </div>
    </div>
  );
};

export default Relatorios;