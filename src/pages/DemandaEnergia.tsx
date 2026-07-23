import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";
import { useNationalHolidaysSet, DEFAULT_PROD_CFG } from "@/hooks/useProductivityData";
import { isPeakNow } from "@/lib/tariff";
import {
  Zap,
  AlertTriangle,
  Power,
  PowerOff,
  TrendingUp,
  TrendingDown,
  Activity,
  Gauge,
  Timer,
  ArrowLeft,
  ShieldAlert,
  ChevronDown,
  ChevronUp,
  BarChart3,
  Loader2,
  Info,
  Pencil,
  Check,
  X,
  Layers,
  Settings,
  Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFarmAccess } from "@/hooks/useFarmAccess";
import EquipmentPowerConfig from "@/components/demanda/EquipmentPowerConfig";
import DemandReportTab from "@/components/DemandReportTab";
import ConsumoReportTab from "@/components/reports/ConsumoReportTab";

interface Equipment {
  id: string;
  name: string;
  type: string;
  power_kw: number | null;
  power_cv: number | null;
  demanda_kw: number | null;
  saida: number | null;
  last_outputs_state: string | null;
  last_communication: string | null;
  desired_running: boolean;
  communication_status: string | null;
}

interface Config {
  contracted_demand_kw: number;
  demand_cost_per_kw: number;
  utility_name: string | null;
}

const ONLINE_WINDOW_MS = 60_000;

function isCommunicating(eq: Equipment): boolean {
  if (eq.communication_status === "offline") return false;
  if (!eq.last_communication) return false;
  const age = Date.now() - new Date(eq.last_communication).getTime();
  return !Number.isNaN(age) && age <= ONLINE_WINDOW_MS;
}

function isRunning(eq: Equipment): boolean {
  // Equipamento sem comunicação (offline ou sem RX há mais de 60s) NÃO conta
  // como ligado — mesma regra do Centro de Comando.
  if (!isCommunicating(eq)) return false;
  const payload = eq.last_outputs_state ?? "";
  const idx = (eq.saida ?? 1) - 1;
  if (payload.length === 1) return payload === "1";
  return payload[idx] === "1";
}

function powerOf(eq: Equipment): number {
  // Preferimos demanda_kw quando > 0; se for 0/null/undefined caímos em power_kw.
  // Usar `??` aqui era um bug: demanda_kw=0 vencia power_kw=132 e zerava tudo.
  const d = Number(eq.demanda_kw ?? 0);
  if (d > 0) return d;
  return Number(eq.power_kw ?? 0);
}

export default function DemandaEnergia() {
  const farmId = useDefaultFarmId();
  const navigate = useNavigate();
  const { isPlatformAdmin } = usePlatformAdmin();
  const { canEditConfig } = useFarmAccess();
  const holidays = useNationalHolidaysSet();

  const [equipments, setEquipments] = useState<Equipment[]>([]);
  const [cfg, setCfg] = useState<Config>({
    contracted_demand_kw: 0,
    demand_cost_per_kw: 35,
    utility_name: null,
  });
  const [now, setNow] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [shedding, setShedding] = useState(false);
  const [editingDemand, setEditingDemand] = useState(false);
  const [demandDraft, setDemandDraft] = useState("");
  const [savingDemand, setSavingDemand] = useState(false);

  // Settings tab form state
  const [settingsDraft, setSettingsDraft] = useState({
    contracted_demand_kw: "",
    demand_cost_per_kw: "",
    utility_name: "",
    tariff_peak: "",
    tariff_off_peak: "",
    tariff_reserved: "",
    tariff_intermediate: "",
    reserved_hour_start: "",
    reserved_hour_end: "",
    intermediate_hour_pre_start: "",
    intermediate_hour_post_end: "",
  });
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsEdited, setSettingsEdited] = useState(false);

  // Atualiza o "agora" a cada 15s para recalcular horário de ponta
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    if (!farmId) return;
    const [eqRes, cfgRes] = await Promise.all([
      supabase
        .from("equipments")
        .select("id, name, type, power_kw, power_cv, demanda_kw, saida, last_outputs_state, last_communication, desired_running, communication_status")
        .eq("farm_id", farmId)
        .eq("active", true)
        .in("type", ["poco", "bombeamento"] as any)
        .order("name", { ascending: true }),
      supabase
        .from("farm_productivity_config" as any)
        .select("contracted_demand_kw, demand_cost_per_kw, utility_name")
        .eq("farm_id", farmId)
        .maybeSingle(),
    ]);
    setEquipments((eqRes.data as any) ?? []);
    const c = (cfgRes.data as any) ?? {};
    setCfg({
      contracted_demand_kw: Number(c.contracted_demand_kw ?? 0),
      demand_cost_per_kw: Number(c.demand_cost_per_kw ?? DEFAULT_PROD_CFG.demand_cost_per_kw),
      utility_name: c.utility_name ?? null,
    });
    setSettingsDraft({
      contracted_demand_kw: c.contracted_demand_kw != null ? String(c.contracted_demand_kw) : "",
      demand_cost_per_kw: c.demand_cost_per_kw != null ? String(c.demand_cost_per_kw) : String(DEFAULT_PROD_CFG.demand_cost_per_kw),
      utility_name: c.utility_name ?? "",
      tariff_peak: c.tariff_peak != null ? String(c.tariff_peak) : String(DEFAULT_PROD_CFG.tariff_peak),
      tariff_off_peak: c.tariff_off_peak != null ? String(c.tariff_off_peak) : String(DEFAULT_PROD_CFG.tariff_off_peak),
      tariff_reserved: c.tariff_reserved != null ? String(c.tariff_reserved) : String(DEFAULT_PROD_CFG.tariff_reserved),
      tariff_intermediate: c.tariff_intermediate != null ? String(c.tariff_intermediate) : "",
      reserved_hour_start: c.reserved_hour_start ?? "21:30",
      reserved_hour_end: c.reserved_hour_end ?? "06:00",
      intermediate_hour_pre_start: c.intermediate_hour_pre_start ?? "17:00",
      intermediate_hour_post_end: c.intermediate_hour_post_end ?? "21:30",
    });
    setSettingsEdited(false);
    setLoading(false);
  }, [farmId]);

  // Carrega a 1ª vez com spinner; refreshes do realtime ficam silenciosos
  // pra não desmontar as <Tabs> e jogar o usuário fora da aba "Configuração".

  useEffect(() => {
    void load();
    if (!farmId) return;
    const ch = supabase
      .channel(`demanda-${farmId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "equipments", filter: `farm_id=eq.${farmId}` },
        () => void load(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [farmId, load]);

  const running = equipments.filter(isRunning);
  const runningKw = running.reduce((sum, e) => sum + powerOf(e), 0);
  const totalInstalledKw = equipments.reduce((sum, e) => sum + powerOf(e), 0);

  const peak = isPeakNow(holidays, now);
  // ANEEL: tolerância de 10% (multa só acima de 110% da contratada).
  const ANEEL_TOLERANCE = 1.10;
  const overFine = cfg.contracted_demand_kw > 0 && runningKw > cfg.contracted_demand_kw * ANEEL_TOLERANCE;
  const overDemand = cfg.contracted_demand_kw > 0 && runningKw > cfg.contracted_demand_kw;
  const nearDemand = cfg.contracted_demand_kw > 0 && runningKw > cfg.contracted_demand_kw * 0.85 && !overDemand;
  const demandPercent = cfg.contracted_demand_kw > 0 ? Math.min((runningKw / cfg.contracted_demand_kw) * 100, 100) : 0;
  const availableKw = Math.max(0, cfg.contracted_demand_kw - runningKw);

  const handleSaveDemand = async () => {
    if (!farmId) return;
    const value = Number(demandDraft.replace(",", "."));
    if (!Number.isFinite(value) || value < 0) {
      toast.error("Informe um valor válido em kW");
      return;
    }
    setSavingDemand(true);
    try {
      const { error } = await supabase
        .from("farm_productivity_config" as any)
        .upsert({ farm_id: farmId, contracted_demand_kw: value } as any, { onConflict: "farm_id" });
      if (error) throw error;
      setCfg((c) => ({ ...c, contracted_demand_kw: value }));
      setEditingDemand(false);
      toast.success("Demanda contratada atualizada");
    } catch (e: any) {
      toast.error(`Falha ao salvar: ${e.message ?? e}`);
    } finally {
      setSavingDemand(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!farmId) return;
    const payload: Record<string, any> = { farm_id: farmId };

    const contracted = Number(settingsDraft.contracted_demand_kw.replace(",", "."));
    if (settingsDraft.contracted_demand_kw !== "" && Number.isFinite(contracted) && contracted >= 0) {
      payload.contracted_demand_kw = contracted;
    }

    const cost = Number(settingsDraft.demand_cost_per_kw.replace(",", "."));
    if (settingsDraft.demand_cost_per_kw !== "" && Number.isFinite(cost) && cost >= 0) {
      payload.demand_cost_per_kw = cost;
    }

    if (settingsDraft.utility_name.trim()) {
      payload.utility_name = settingsDraft.utility_name.trim();
    } else {
      payload.utility_name = null;
    }

    const tPeak = Number(settingsDraft.tariff_peak.replace(",", "."));
    if (settingsDraft.tariff_peak !== "" && Number.isFinite(tPeak) && tPeak >= 0) payload.tariff_peak = tPeak;

    const tOff = Number(settingsDraft.tariff_off_peak.replace(",", "."));
    if (settingsDraft.tariff_off_peak !== "" && Number.isFinite(tOff) && tOff >= 0) payload.tariff_off_peak = tOff;

    const tRes = Number(settingsDraft.tariff_reserved.replace(",", "."));
    if (settingsDraft.tariff_reserved !== "" && Number.isFinite(tRes) && tRes >= 0) payload.tariff_reserved = tRes;

    const tInt = Number(settingsDraft.tariff_intermediate.replace(",", "."));
    if (settingsDraft.tariff_intermediate !== "" && Number.isFinite(tInt) && tInt >= 0) payload.tariff_intermediate = tInt;

    if (settingsDraft.reserved_hour_start) payload.reserved_hour_start = settingsDraft.reserved_hour_start;
    if (settingsDraft.reserved_hour_end) payload.reserved_hour_end = settingsDraft.reserved_hour_end;
    if (settingsDraft.intermediate_hour_pre_start) payload.intermediate_hour_pre_start = settingsDraft.intermediate_hour_pre_start;
    if (settingsDraft.intermediate_hour_post_end) payload.intermediate_hour_post_end = settingsDraft.intermediate_hour_post_end;

    setSavingSettings(true);
    try {
      const { error } = await supabase
        .from("farm_productivity_config" as any)
        .upsert(payload as any, { onConflict: "farm_id" });
      if (error) throw error;

      setCfg((prev) => ({
        ...prev,
        contracted_demand_kw: payload.contracted_demand_kw ?? prev.contracted_demand_kw,
        demand_cost_per_kw: payload.demand_cost_per_kw ?? prev.demand_cost_per_kw,
        utility_name: payload.utility_name ?? prev.utility_name,
      }));
      setSettingsEdited(false);
      toast.success("Configurações de energia salvas");
    } catch (e: any) {
      toast.error(`Falha ao salvar: ${e.message ?? e}`);
    } finally {
      setSavingSettings(false);
    }
  };

  const updateSetting = (field: keyof typeof settingsDraft, value: string) => {
    setSettingsDraft((prev) => ({ ...prev, [field]: value }));
    setSettingsEdited(true);
  };

  // Prioridade: bombas com maior potência = maior impacto no pico
  // Quando precisar desligar, desliga as de maior potência primeiro (ou menor, depende da estratégia)
  // Estratégia: manter bombas menores ligadas, desligar maiores primeiro
  const sortedByImpact = [...running].sort((a, b) => powerOf(b) - powerOf(a));

  const handleShedLoad = async () => {
    if (!farmId || sortedByImpact.length === 0) return;
    setShedding(true);
    // Desliga a bomba de maior impacto primeiro
    const target = sortedByImpact[0];
    try {
      const { error } = await supabase.from("commands").insert({
        farm_id: farmId,
        equipment_id: target.id,
        type: "manual",
        frame: buildTurnOffFrame(target),
        status: "pending",
        priority: 1,
        source_device: "web-demand-control",
      } as any);
      if (error) throw error;
      toast.success(`Comando enviado: desligar ${target.name} (${powerOf(target).toFixed(1)} kW)`);
    } catch (e: any) {
      toast.error(`Falha ao enviar comando: ${e.message ?? e}`);
    } finally {
      setShedding(false);
    }
  };

  const buildTurnOffFrame = (eq: Equipment): string => {
    const saida = eq.saida ?? 1;
    // Protocolo Renov: 6 posições, saida em 1-based
    const bits = Array.from({ length: 6 }, (_, i) => (i + 1 === saida ? "0" : "1"));
    return `[TSNN_1_]{${bits.join("")}}[TSNN_ETX_]\r`;
  };

  if (loading) {
    return (
      <div className="min-h-[calc(100vh-8rem)] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Zap className="w-6 h-6 text-warning" />
            Energia
          </h1>
          <p className="text-sm text-muted-foreground">
            Monitoramento em tempo real, relatórios e configuração de demanda
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-4 h-4 mr-1" />
          Voltar
        </Button>
      </div>

      <Tabs defaultValue="demanda" className="space-y-4 min-w-0">
        <TabsList className="!grid grid-cols-2 w-full !h-auto gap-1 sm:!inline-flex sm:w-auto sm:flex-nowrap [&>*]:min-w-0 [&>*]:whitespace-normal [&>*]:text-center">
          <TabsTrigger value="demanda">Demanda de Energia</TabsTrigger>
          <TabsTrigger value="consumo">Consumo</TabsTrigger>
        </TabsList>

        <TabsContent value="demanda" className="mt-0 space-y-4">
        <Tabs defaultValue="monitor" className="space-y-4 min-w-0">
        <TabsList className="!grid grid-cols-2 w-full !h-auto gap-1 sm:!inline-flex sm:w-auto sm:flex-nowrap [&>*]:min-w-0 [&>*]:whitespace-normal [&>*]:text-center">
          <TabsTrigger value="monitor">Monitoramento</TabsTrigger>
          <TabsTrigger value="report">Relatório</TabsTrigger>
          <TabsTrigger value="settings">Configurações</TabsTrigger>
          {(canEditConfig || isPlatformAdmin) && (
            <TabsTrigger value="config">Configuração de Equipamentos</TabsTrigger>
          )}
        </TabsList>


        <TabsContent value="monitor" className="space-y-6 mt-0">
      {/* Alertas */}
      {overDemand && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-xl px-4 py-3 flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold text-destructive text-sm">Demanda contratada ultrapassada!</p>
            <p className="text-xs text-destructive/80 mt-0.5">
              {runningKw.toFixed(1)} kW em uso vs {cfg.contracted_demand_kw} kW contratados.
              Sujeito a multa da concessionária ({cfg.utility_name ?? "concessionária"}).
            </p>
            {isPlatformAdmin && (
              <Button
                size="sm"
                variant="destructive"
                className="mt-2"
                onClick={handleShedLoad}
                disabled={shedding}
              >
                <PowerOff className="w-3.5 h-3.5 mr-1" />
                {shedding ? "Enviando…" : `Desligar ${sortedByImpact[0]?.name ?? "maior consumo"}`}
              </Button>
            )}
          </div>
        </div>
      )}

      {nearDemand && !overDemand && (
        <div className="bg-warning/10 border border-warning/30 rounded-xl px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-warning-foreground text-sm">Próximo do limite de demanda</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Utilizando {runningKw.toFixed(1)} kW de {cfg.contracted_demand_kw} kW contratados ({demandPercent.toFixed(0)}%).
            </p>
          </div>
        </div>
      )}

      {peak && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-xl px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-destructive text-sm">Horário de Ponta (18h–21h)</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Tarifa de energia está no valor mais alto. Evite ligar novas bombas.
            </p>
          </div>
        </div>
      )}

      {/* Cards de métricas */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card border-border">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Activity className="w-4 h-4" />
              <span className="text-xs font-medium uppercase tracking-wider">Consumo Atual</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-extrabold text-foreground">{runningKw.toFixed(1)}</span>
              <span className="text-sm font-medium text-muted-foreground">kW</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {running.length} de {equipments.length} bombas ligadas
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-2 text-muted-foreground">
              <div className="flex items-center gap-2">
                <Gauge className="w-4 h-4" />
                <span className="text-xs font-medium uppercase tracking-wider">Demanda Contratada</span>
              </div>
              {(canEditConfig || isPlatformAdmin) && !editingDemand && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={() => {
                    setDemandDraft(cfg.contracted_demand_kw > 0 ? String(cfg.contracted_demand_kw) : "");
                    setEditingDemand(true);
                  }}
                  aria-label="Editar demanda contratada"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
            {editingDemand ? (
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.1"
                  value={demandDraft}
                  onChange={(e) => setDemandDraft(e.target.value)}
                  className="h-8 text-sm"
                  autoFocus
                  placeholder="kW"
                />
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={handleSaveDemand} disabled={savingDemand}>
                  {savingDemand ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4 text-success" />}
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditingDemand(false)} disabled={savingDemand}>
                  <X className="w-4 h-4 text-muted-foreground" />
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-extrabold text-foreground">
                    {cfg.contracted_demand_kw > 0 ? cfg.contracted_demand_kw : "—"}
                  </span>
                  {cfg.contracted_demand_kw > 0 && <span className="text-sm font-medium text-muted-foreground">kW</span>}
                </div>
                {cfg.contracted_demand_kw === 0 ? (
                  <p className="text-xs text-warning">Não configurada</p>
                ) : (
                  <p className="text-[10px] text-muted-foreground">Tolerância ANEEL: 10%</p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-2 text-muted-foreground">
              {overDemand ? <TrendingUp className="w-4 h-4 text-destructive" /> : <TrendingDown className="w-4 h-4 text-primary" />}
              <span className="text-xs font-medium uppercase tracking-wider">Margem Disponível</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className={`text-3xl font-extrabold ${overDemand ? "text-destructive" : "text-foreground"}`}>
                {availableKw.toFixed(1)}
              </span>
              <span className="text-sm font-medium text-muted-foreground">kW</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {cfg.contracted_demand_kw > 0 ? `${demandPercent.toFixed(0)}% da demanda utilizada` : "Configure a demanda contratada"}
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Timer className="w-4 h-4" />
              <span className="text-xs font-medium uppercase tracking-wider">Potência Instalada</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-extrabold text-foreground">{totalInstalledKw.toFixed(1)}</span>
              <span className="text-sm font-medium text-muted-foreground">kW</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Soma da potência de todas as bombas
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Barra de progresso da demanda */}
      {cfg.contracted_demand_kw > 0 && (
        <Card className="bg-card border-border">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-sm font-semibold text-foreground">Uso da Demanda Contratada</span>
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className="text-[10px] bg-success/10 text-success border-success/30 gap-1">
                  <Layers className="w-3 h-3" />
                  Partida Escalonada Ativa
                </Badge>
                <Badge variant={overFine ? "destructive" : overDemand ? "destructive" : nearDemand ? "secondary" : "outline"}>
                  {overFine ? "Multa ANEEL" : overDemand ? "Acima do contrato" : nearDemand ? "Próximo" : "OK"}
                </Badge>
              </div>
            </div>
            <Progress
              value={Math.min(demandPercent, 100)}
              className="h-3"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0 kW</span>
              <span className={overDemand ? "text-destructive font-semibold" : ""}>
                {runningKw.toFixed(1)} kW ({demandPercent.toFixed(0)}%)
              </span>
              <span>{cfg.contracted_demand_kw} kW</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lista de bombas */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-primary" />
            Bombas — Status e Potência
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {equipments.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              Nenhuma bomba cadastrada nesta fazenda.
            </p>
          ) : (
            equipments.map((eq) => {
              const on = isRunning(eq);
              const kw = powerOf(eq);
              return (
                <div
                  key={eq.id}
                  className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                    on
                      ? "bg-primary/5 border-primary/20"
                      : "bg-muted/30 border-border"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-2.5 h-2.5 rounded-full ${on ? "bg-success animate-pulse" : "bg-muted"}`} />
                    <div>
                      <p className="text-sm font-semibold text-foreground">{eq.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {kw > 0
                          ? `${kw.toFixed(1)} kW${eq.power_cv ? ` (${Number(eq.power_cv).toFixed(0)} CV)` : ""}`
                          : "Potência não informada"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {on ? (
                      <Badge variant="secondary" className="text-[10px] bg-success/15 text-success border-success/30">
                        <Power className="w-3 h-3 mr-0.5" />
                        Ligada
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        <PowerOff className="w-3 h-3 mr-0.5" />
                        Desligada
                      </Badge>
                    )}
                    {peak && on && (
                      <Badge variant="destructive" className="text-[10px]">
                        Ponta
                      </Badge>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Painel de Priorização */}
      <Collapsible open={priorityOpen} onOpenChange={setPriorityOpen}>
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CollapsibleTrigger asChild>
              <button className="flex items-center justify-between w-full">
                <CardTitle className="text-base flex items-center gap-2">
                  <Info className="w-4 h-4 text-info" />
                  Priorização Automática
                </CardTitle>
                {priorityOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
              </button>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Se a demanda contratada for ultrapassada, o sistema pode desligar bombas automaticamente,
                começando pelas de <strong>maior potência</strong>, preservando as menores.
              </p>
              {sortedByImpact.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-foreground uppercase tracking-wider">
                    Ordem de desligamento (maior → menor impacto)
                  </p>
                  {sortedByImpact.map((eq, i) => (
                    <div
                      key={eq.id}
                      className="flex items-center gap-3 p-2 rounded-md bg-muted/40 border border-border"
                    >
                      <span className="text-xs font-mono text-muted-foreground w-6 text-center">
                        {i + 1}
                      </span>
                      <span className="text-sm text-foreground flex-1">{eq.name}</span>
                      <span className="text-sm font-semibold text-warning">{powerOf(eq).toFixed(1)} kW</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Nenhuma bomba ligada no momento.</p>
              )}
              {isPlatformAdmin && overDemand && sortedByImpact.length > 0 && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleShedLoad}
                  disabled={shedding}
                  className="w-full sm:w-auto"
                >
                  <PowerOff className="w-4 h-4 mr-1" />
                  {shedding ? "Enviando comando…" : `Desligar ${sortedByImpact[0].name} agora`}
                </Button>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
        </TabsContent>

        <TabsContent value="report" className="mt-0 space-y-4">
          <EnergyReportTabContent farmId={farmId} />
        </TabsContent>

        <TabsContent value="settings" className="mt-0 space-y-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Settings className="w-4 h-4 text-primary" />
                Configurações de Demanda e Tarifas
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Demanda Contratada (kW)</label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.1"
                    value={settingsDraft.contracted_demand_kw}
                    onChange={(e) => updateSetting("contracted_demand_kw", e.target.value)}
                    placeholder="ex: 5000"
                    disabled={!canEditConfig && !isPlatformAdmin}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Custo por kW de Demanda (R$)</label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={settingsDraft.demand_cost_per_kw}
                    onChange={(e) => updateSetting("demand_cost_per_kw", e.target.value)}
                    placeholder="ex: 35"
                    disabled={!canEditConfig && !isPlatformAdmin}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Concessionária</label>
                  <Input
                    type="text"
                    value={settingsDraft.utility_name}
                    onChange={(e) => updateSetting("utility_name", e.target.value)}
                    placeholder="ex: Coelba / Neoenergia"
                    disabled={!canEditConfig && !isPlatformAdmin}
                  />
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <p className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">Tarifas (R$/kWh)</Badge>
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Ponta (R$/kWh)</label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      value={settingsDraft.tariff_peak}
                      onChange={(e) => updateSetting("tariff_peak", e.target.value)}
                      placeholder="ex: 2.80"
                      disabled={!canEditConfig && !isPlatformAdmin}
                    />
                    <p className="text-[10px] text-muted-foreground">18h–21h + feriados</p>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Fora Ponta (R$/kWh)</label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      value={settingsDraft.tariff_off_peak}
                      onChange={(e) => updateSetting("tariff_off_peak", e.target.value)}
                      placeholder="ex: 0.55"
                      disabled={!canEditConfig && !isPlatformAdmin}
                    />
                    <p className="text-[10px] text-muted-foreground">Demais horários</p>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Reservado (R$/kWh)</label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      value={settingsDraft.tariff_reserved}
                      onChange={(e) => updateSetting("tariff_reserved", e.target.value)}
                      placeholder="ex: 0.32"
                      disabled={!canEditConfig && !isPlatformAdmin}
                    />
                    <p className="text-[10px] text-muted-foreground">Horário rural noturno</p>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Intermediário (R$/kWh)</label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      value={settingsDraft.tariff_intermediate}
                      onChange={(e) => updateSetting("tariff_intermediate", e.target.value)}
                      placeholder="ex: 1.20"
                      disabled={!canEditConfig && !isPlatformAdmin}
                    />
                    <p className="text-[10px] text-muted-foreground">Transição ponta/fora-ponta</p>
                  </div>
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <p className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">Horários de Posto Tarifário</Badge>
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Início Reservado</label>
                    <Input
                      type="time"
                      value={settingsDraft.reserved_hour_start}
                      onChange={(e) => updateSetting("reserved_hour_start", e.target.value)}
                      disabled={!canEditConfig && !isPlatformAdmin}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Fim Reservado</label>
                    <Input
                      type="time"
                      value={settingsDraft.reserved_hour_end}
                      onChange={(e) => updateSetting("reserved_hour_end", e.target.value)}
                      disabled={!canEditConfig && !isPlatformAdmin}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Início Intermediário</label>
                    <Input
                      type="time"
                      value={settingsDraft.intermediate_hour_pre_start}
                      onChange={(e) => updateSetting("intermediate_hour_pre_start", e.target.value)}
                      disabled={!canEditConfig && !isPlatformAdmin}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Fim Intermediário</label>
                    <Input
                      type="time"
                      value={settingsDraft.intermediate_hour_post_end}
                      onChange={(e) => updateSetting("intermediate_hour_post_end", e.target.value)}
                      disabled={!canEditConfig && !isPlatformAdmin}
                    />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground mt-2">
                  Horário de ponta fixo: 18:00–21:00. Feriados nacionais também são considerados ponta conforme ANEEL.
                </p>
              </div>

              {(canEditConfig || isPlatformAdmin) && (
                <div className="flex justify-end pt-2">
                  <Button
                    size="sm"
                    onClick={handleSaveSettings}
                    disabled={savingSettings || !settingsEdited}
                  >
                    {savingSettings ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Save className="w-4 h-4 mr-1" />}
                    Salvar Configurações
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {(canEditConfig || isPlatformAdmin) && (
          <TabsContent value="config" className="mt-0">
            <EquipmentPowerConfig farmId={farmId} canEdit={canEditConfig || isPlatformAdmin} />
          </TabsContent>
        )}
      </Tabs>
        </TabsContent>

        <TabsContent value="consumo" className="mt-0">
          <EnergyConsumoTabContent farmId={farmId} />
        </TabsContent>
      </Tabs>
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

function EnergyReportTabContent({ farmId }: { farmId: string | null }) {
  const [fromDate, setFromDate] = useState<string>(defaultFromIso());
  const [toDate, setToDate] = useState<string>(defaultToIso());
  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-3 items-end sm:flex sm:flex-wrap">
            <div className="min-w-0">
              <label className="text-xs text-muted-foreground">Data Início</label>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="bg-secondary border-border mt-1 w-full sm:w-40"
              />
            </div>
            <div className="min-w-0">
              <label className="text-xs text-muted-foreground">Data Fim</label>
              <Input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="bg-secondary border-border mt-1 w-full sm:w-40"
              />
            </div>
          </div>
        </CardContent>
      </Card>
      <DemandReportTab farmId={farmId} fromDate={fromDate} toDate={toDate} />
    </div>
  );
}

function EnergyConsumoTabContent({ farmId }: { farmId: string | null }) {
  const [fromDate, setFromDate] = useState<string>(defaultFromIso());
  const [toDate, setToDate] = useState<string>(defaultToIso());
  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-3 items-end sm:flex sm:flex-wrap">
            <div className="min-w-0">
              <label className="text-xs text-muted-foreground">Data Início</label>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="bg-secondary border-border mt-1 w-full sm:w-40"
              />
            </div>
            <div className="min-w-0">
              <label className="text-xs text-muted-foreground">Data Fim</label>
              <Input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="bg-secondary border-border mt-1 w-full sm:w-40"
              />
            </div>
          </div>
        </CardContent>
      </Card>
      <ConsumoReportTab farmId={farmId} fromDate={fromDate} toDate={toDate} selectedPump="all" />
    </div>
  );
}



