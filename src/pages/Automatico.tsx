import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Calendar, ShieldCheck, Activity, Droplets, Pencil, Trash2, Save, ChevronDown, ChevronUp, PartyPopper, CalendarDays, AlertCircle, Cloud, Search, Power, PowerOff, LayoutGrid, List } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { notify } from "@/lib/notify";
import { useCadastrosCloud } from "@/hooks/useCadastrosCloud";
import { useCloudAutomation, type ScheduleMode } from "@/hooks/useCloudAutomation";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { enqueueProtectiveOffOnDisable } from "@/lib/automationProtectiveOff";
import { supabase } from "@/integrations/supabase/client";
import { Link } from "react-router-dom";
import AuditoriaPanel from "@/components/automatico/AuditoriaPanel";


const weekDays = [
  { key: "seg", label: "Seg" },
  { key: "ter", label: "Ter" },
  { key: "qua", label: "Qua" },
  { key: "qui", label: "Qui" },
  { key: "sex", label: "Sex" },
  { key: "sab", label: "Sáb" },
  { key: "dom", label: "Dom" },
];

const nationalHolidays = [
  { date: "01/01", name: "Confraternização Universal" },
  { date: "21/04", name: "Tiradentes" },
  { date: "01/05", name: "Dia do Trabalho" },
  { date: "07/09", name: "Independência do Brasil" },
  { date: "12/10", name: "Nossa Sra. Aparecida" },
  { date: "02/11", name: "Finados" },
  { date: "15/11", name: "Proclamação da República" },
  { date: "25/12", name: "Natal" },
];

const emptyForm = { mode: "on-only" as ScheduleMode, days: [] as string[], timeOn: "06:00", timeOff: "18:00" };

const Automatico = () => {
  const { loading: cadastrosLoading, equipments, plcs } = useCadastrosCloud();
  const cloud = useCloudAutomation();
  const farmId = useDefaultFarmId();

  const pumpEquipments = useMemo(
    () => equipments.filter((e) => e.type === "poco" || e.type === "bombeamento"),
    [equipments],
  );
  const pumpList = useMemo(() => pumpEquipments.map((e) => e.name.toUpperCase()), [pumpEquipments]);

  const [expandedPumps, setExpandedPumps] = useState<string[]>([]);
  const [holidayExpanded, setHolidayExpanded] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [viewMode, setViewMode] = useState<"week" | "pump">("week");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dialogPump, setDialogPump] = useState("");
  const [dialogEquipmentId, setDialogEquipmentId] = useState("");
  const [form, setForm] = useState(emptyForm);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Busca timezone da fazenda só quando precisar disparar o "protective off"
  const fetchFarmTimezone = async (): Promise<string> => {
    if (!farmId) return "America/Sao_Paulo";
    const { data } = await supabase.from("farms").select("timezone").eq("id", farmId).maybeSingle();
    return data?.timezone || "America/Sao_Paulo";
  };

  const triggerProtectiveOff = async (scheduleIdScope?: string) => {
    if (!farmId) return;
    try {
      const timezone = await fetchFarmTimezone();
      const count = await enqueueProtectiveOffOnDisable({
        farmId,
        timezone,
        schedules: cloud.schedules,
        equipments,
        plcs,
        holidayConfigs: cloud.holidayConfigs,
        scheduleIdScope,
      });
      if (count > 0) {
        notify.tip("Automático", count === 1
            ? "Comando de desligamento enviado para 1 bomba (sincronização de segurança)"
            : `Comandos de desligamento enviados para ${count} bombas (sincronização de segurança)`);
      }
    } catch (e) {
      console.error(e);
      // não bloqueia a desativação
    }
  };

  const toggleEngine = async (checked: boolean) => {
    console.log("[MODE_CHANGE] Automatico page engine switch clicked. Equipment:", "automation_engine", "New state:", checked);
    try {
      // Antes de desligar, verifica se há bombas em janela ativa com saída desligada e enfileira OFF protetor
      if (!checked) await triggerProtectiveOff();
      const notificationResult = await cloud.setEngineActive(checked);
      console.log("[MODE_CHANGE] Automatico page engine switch completed. Equipment:", "automation_engine", "New state:", checked, "Result:", notificationResult);
      notify.ok("Automático", checked ? "Motor de automação ATIVADO" : "Motor de automação DESATIVADO — apenas controle manual");
    } catch (e) {
      console.error("[MODE_CHANGE] Automatico page engine switch failed. Equipment:", "automation_engine", "New state:", checked, e);
      notify.fail("Automático", e instanceof Error ? e.message : String(e));
    }
  };


  const toggleSchedule = async (id: string) => {
    try {
      const sched = cloud.schedules.find((s) => s.id === id);
      console.log("[MODE_CHANGE] Automatico page schedule toggle clicked. Equipment:", sched?.equipmentId, "Schedule:", id, "New state:", sched ? !sched.active : undefined);
      // Se está desativando uma programação ativa, dispara protective OFF apenas para ela
      if (sched?.active) await triggerProtectiveOff(id);
      await cloud.toggleSchedule(id);
      console.log("[MODE_CHANGE] Automatico page schedule toggle completed. Equipment:", sched?.equipmentId, "Schedule:", id, "New state:", sched ? !sched.active : undefined);
    } catch (e) {
      console.error("[MODE_CHANGE] Automatico page schedule toggle failed. Schedule:", id, e);
      notify.fail("Automático", e instanceof Error ? e.message : String(e));
    }
  };

  const togglePumpExpand = (pump: string) => {
    setExpandedPumps((prev) => prev.includes(pump) ? prev.filter((p) => p !== pump) : [...prev, pump]);
  };

  const openCreate = (pump: string, equipmentId: string) => {
    setEditingId(null);
    setDialogPump(pump);
    setDialogEquipmentId(equipmentId);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (id: string) => {
    const sched = cloud.schedules.find((s) => s.id === id);
    if (!sched) return;
    const eq = pumpEquipments.find((e) => e.id === sched.equipmentId);
    setEditingId(id);
    setDialogPump(eq?.name?.toUpperCase() ?? "");
    setDialogEquipmentId(sched.equipmentId);
    setForm({ mode: sched.mode, days: [...sched.days], timeOn: sched.timeOn, timeOff: sched.timeOff });
    setDialogOpen(true);
  };

  const toggleDay = (day: string) => {
    setForm((prev) => ({
      ...prev,
      days: prev.days.includes(day) ? prev.days.filter((d) => d !== day) : [...prev.days, day],
    }));
  };

  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    console.log("[Automatico] handleSave click", { editingId, dialogEquipmentId, form, farmId });
    if (saving) return;
    if (form.days.length === 0) { notify.fail("Automático", "Selecione ao menos um dia da semana"); return; }
    if (!dialogEquipmentId) { notify.fail("Automático", "Equipamento não identificado."); return; }
    if (!farmId) { notify.fail("Automático", "Fazenda não identificada. Recarregue a página."); return; }

    setSaving(true);
    try {
      if (editingId !== null) {
        await cloud.updateSchedule(editingId, {
          mode: form.mode, days: form.days, timeOn: form.timeOn, timeOff: form.timeOff,
        });
        notify.ok("Automático", "Programação atualizada com sucesso");
      } else {
        await cloud.createSchedule({
          equipmentId: dialogEquipmentId,
          active: true,
          mode: form.mode,
          days: form.days,
          timeOn: form.timeOn,
          timeOff: form.timeOff,
        });
        notify.ok("Automático", "Programação criada com sucesso");
      }
      setDialogOpen(false);
    } catch (e) {
      console.error("[Automatico] handleSave error", e);
      notify.fail("Automático", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (id: string) => {
    setDeletingId(id);
    setDeleteDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    try {
      await cloud.deleteSchedule(deletingId);
      notify.ok("Automático", "Programação excluída");
      setDeleteDialogOpen(false);
      setDeletingId(null);
    } catch (e) {
      notify.fail("Automático", e instanceof Error ? e.message : String(e));
    }
  };

  const updateHolidayConfig = async (equipmentId: string, pumpName: string, patch: Parameters<typeof cloud.upsertHoliday>[1]) => {
    try {
      await cloud.upsertHoliday(equipmentId, patch);
      notify.ok("Automático", `Configuração de feriado atualizada — ${pumpName}`);
    } catch (e) {
      notify.fail("Automático", e instanceof Error ? e.message : String(e));
    }
  };

  const activeSchedulesCount = cloud.schedules.filter((s) => s.active).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Automático</h1>
        <p className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
          <Cloud className="w-3.5 h-3.5 text-primary" />
          Programações sincronizadas na nuvem — rodam mesmo com o navegador fechado
        </p>
      </div>

      <Card className={`border-2 transition-colors ${cloud.engineActive ? "border-primary/40 bg-primary/5" : "border-border bg-card"}`}>
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${cloud.engineActive ? "bg-primary/20" : "bg-secondary"}`}>
                <ShieldCheck className={`w-5 h-5 ${cloud.engineActive ? "text-primary" : "text-muted-foreground"}`} />
              </div>
              <div>
                <h3 className="text-sm font-bold text-foreground">Modo Automático</h3>
                <p className="text-xs text-muted-foreground">
                  {cloud.engineActive
                    ? `Ativo na nuvem — ${activeSchedulesCount} programação(ões) ativa(s)`
                    : "Desativado — bombas só respondem a controle manual"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {cloud.engineActive && (
                <div className="flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-primary animate-pulse" />
                  <span className="text-xs font-medium text-primary">Rodando</span>
                </div>
              )}
              <Switch
                checked={cloud.engineActive}
                onCheckedChange={toggleEngine}
                className="data-[state=checked]:bg-primary"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Card de Feriados foi movido para o final da página para não ficar no caminho das programações */}

      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">Programações</h2>
            {pumpEquipments.length > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                {pumpEquipments.length} {pumpEquipments.length === 1 ? "poço" : "poços"}
              </span>
            )}
          </div>
          {pumpEquipments.length > 0 && (
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "week" | "pump")}>
                <TabsList className="h-9">
                  <TabsTrigger value="week" className="gap-1.5 text-xs">
                    <LayoutGrid className="w-3.5 h-3.5" /> Semana
                  </TabsTrigger>
                  <TabsTrigger value="pump" className="gap-1.5 text-xs">
                    <List className="w-3.5 h-3.5" /> Por Bomba
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="relative flex-1 sm:w-56">
                <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <Input
                  placeholder="Buscar bomba…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="bg-secondary border-border pl-9 h-9 text-sm"
                />
              </div>
            </div>
          )}
        </div>

        {(cadastrosLoading || cloud.loading) && (
          <Card className="bg-card border-border">
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              Carregando programações da nuvem…
            </CardContent>
          </Card>
        )}

        {!cadastrosLoading && pumpEquipments.length === 0 && (
          <Card className="bg-card border-dashed border-border">
            <CardContent className="p-8 flex flex-col items-center text-center gap-3">
              <AlertCircle className="w-10 h-10 text-muted-foreground" />
              <div>
                <h3 className="text-sm font-bold text-foreground">Nenhum poço ou bomba cadastrado</h3>
                <p className="text-xs text-muted-foreground mt-1 max-w-md">
                  A automação programada só fica disponível para equipamentos cadastrados.
                </p>
              </div>
              <Button asChild size="sm" className="gap-2 bg-primary text-primary-foreground">
                <Link to="/cadastros">
                  <Plus className="w-3.5 h-3.5" /> Ir para Cadastros
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {viewMode === "week" && !cadastrosLoading && pumpEquipments.length > 0 && (() => {
          const term = searchTerm.trim().toLowerCase();
          const filteredPumps = term
            ? pumpEquipments.filter((e) =>
                e.name.toLowerCase().includes(term) ||
                (e.hw_id ?? "").toLowerCase().includes(term),
              )
            : pumpEquipments;
          const allowedIds = new Set(filteredPumps.map((e) => e.id));
          const pumpById = new Map(pumpEquipments.map((e) => [e.id, e] as const));

          type DayItem = {
            schedId: string;
            equipmentId: string;
            pumpName: string;
            isOn: boolean;
            time: string;
            active: boolean;
          };
          const byDay = new Map<string, DayItem[]>();
          for (const d of weekDays) byDay.set(d.key, []);
          for (const s of cloud.schedules) {
            if (!allowedIds.has(s.equipmentId)) continue;
            const eq = pumpById.get(s.equipmentId);
            if (!eq) continue;
            const isOn = s.mode === "on-only";
            const time = isOn ? s.timeOn : s.timeOff;
            const item: DayItem = {
              schedId: s.id,
              equipmentId: s.equipmentId,
              pumpName: eq.name.toUpperCase(),
              isOn,
              time,
              active: s.active,
            };
            for (const day of s.days) {
              byDay.get(day)?.push(item);
            }
          }
          for (const list of byDay.values()) {
            list.sort((a, b) => a.time.localeCompare(b.time) || a.pumpName.localeCompare(b.pumpName, "pt-BR"));
          }

          const todayJs = new Date().getDay(); // 0=dom..6=sab
          const todayKey = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"][todayJs];

          const totalShown = Array.from(byDay.values()).reduce((acc, l) => acc + l.length, 0);

          if (term && totalShown === 0) {
            return (
              <Card className="bg-card border-dashed border-border">
                <CardContent className="p-6 text-center text-sm text-muted-foreground">
                  Nenhuma programação encontrada para "{searchTerm}".
                </CardContent>
              </Card>
            );
          }

          return (
            <Card className="bg-card border-border overflow-hidden">
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 divide-x divide-y lg:divide-y-0 divide-border">
                {weekDays.map((d) => {
                  const items = byDay.get(d.key) ?? [];
                  const isToday = d.key === todayKey;
                  return (
                    <div key={d.key} className="min-h-[140px] flex flex-col">
                      <div className={`px-2.5 py-1.5 flex items-center justify-between border-b border-border ${
                        isToday ? "bg-primary/15" : "bg-secondary/40"
                      }`}>
                        <span className={`text-[11px] font-bold uppercase tracking-wider ${
                          isToday ? "text-primary" : "text-muted-foreground"
                        }`}>
                          {d.label}
                          {isToday && <span className="ml-1 text-[9px] font-semibold normal-case">hoje</span>}
                        </span>
                        <span className="text-[10px] text-muted-foreground tabular-nums">{items.length}</span>
                      </div>
                      <div className="flex-1 p-1.5 space-y-1">
                        {items.length === 0 ? (
                          <p className="text-[10px] text-muted-foreground/60 px-1.5 py-2 italic">vazio</p>
                        ) : (
                          items.map((it, idx) => {
                            const isLive = it.active && cloud.engineActive;
                            return (
                              <div
                                key={`${d.key}-${it.schedId}-${idx}`}
                                title={`${it.pumpName} — ${it.isOn ? "Ligar" : "Desligar"} às ${it.time}${it.active ? "" : " (desativada)"}`}
                                className={`w-full flex items-center gap-1 px-1 py-1 rounded border transition-colors ${
                                  it.isOn
                                    ? isLive
                                      ? "border-primary/40 bg-primary/10"
                                      : "border-border bg-secondary"
                                    : isLive
                                      ? "border-destructive/40 bg-destructive/10"
                                      : "border-border bg-secondary"
                                } ${!it.active ? "opacity-50" : ""}`}
                              >
                                <button
                                  onClick={() => openEdit(it.schedId)}
                                  className="flex items-center gap-1 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
                                >
                                  {it.isOn ? (
                                    <Power className={`w-3 h-3 shrink-0 ${isLive ? "text-primary" : "text-muted-foreground"}`} />
                                  ) : (
                                    <PowerOff className={`w-3 h-3 shrink-0 ${isLive ? "text-destructive" : "text-muted-foreground"}`} />
                                  )}
                                  <span className={`text-[11px] font-bold tabular-nums ${
                                    it.isOn
                                      ? isLive ? "text-primary" : "text-foreground"
                                      : isLive ? "text-destructive" : "text-foreground"
                                  }`}>{it.time}</span>
                                  <span className="text-[10px] text-foreground/80 truncate min-w-0 flex-1">{it.pumpName}</span>
                                </button>
                                <Switch
                                  checked={it.active}
                                  onCheckedChange={async () => {
                                    await cloud.toggleSchedule(it.schedId);
                                    if (it.active) await triggerProtectiveOff(it.schedId);
                                    notify.ok("Automático", it.active ? "Programação desativada" : "Programação ativada");
                                  }}
                                  title={it.active ? "Desativar esta programação" : "Ativar esta programação"}
                                  className="scale-[0.55] data-[state=checked]:bg-primary shrink-0 -mr-1"
                                />
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="px-3 py-2 border-t border-border bg-secondary/30 flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground">
                  Clique no horário para editar · Use o switch ao lado para ativar/desativar a programação
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => setViewMode("pump")}
                >
                  <Plus className="w-3 h-3" /> Nova
                </Button>
              </div>
            </Card>
          );
        })()}

        {viewMode === "pump" && (() => {
          if (cadastrosLoading) return null;
          const term = searchTerm.trim().toLowerCase();
          const filtered = term
            ? pumpEquipments.filter((e) =>
                e.name.toLowerCase().includes(term) ||
                (e.hw_id ?? "").toLowerCase().includes(term),
              )
            : pumpEquipments;

          if (pumpEquipments.length > 0 && filtered.length === 0) {
            return (
              <Card className="bg-card border-dashed border-border">
                <CardContent className="p-6 text-center text-sm text-muted-foreground">
                  Nenhuma bomba encontrada para "{searchTerm}".
                </CardContent>
              </Card>
            );
          }

          // Ordena: bombas com programações primeiro, depois alfabético
          const sorted = [...filtered].sort((a, b) => {
            const ac = cloud.schedules.filter((s) => s.equipmentId === a.id).length;
            const bc = cloud.schedules.filter((s) => s.equipmentId === b.id).length;
            if ((ac > 0) !== (bc > 0)) return ac > 0 ? -1 : 1;
            return a.name.localeCompare(b.name, "pt-BR");
          });

          return (
            <Card className="bg-card border-border overflow-hidden">
              <ul className="divide-y divide-border">
                {sorted.map((equip) => {
                  const pump = equip.name.toUpperCase();
                  const pumpSchedules = cloud.schedules.filter((s) => s.equipmentId === equip.id);
                  const activeCount = pumpSchedules.filter((s) => s.active).length;
                  const isExpanded = expandedPumps.includes(pump);
                  const hasSchedules = pumpSchedules.length > 0;

                  return (
                    <li key={equip.id}>
                      <div className="flex items-center gap-2 px-3 py-2 hover:bg-secondary/40 transition-colors">
                        <button
                          onClick={() => togglePumpExpand(pump)}
                          className="flex-1 flex items-center gap-3 text-left min-w-0"
                        >
                          <Droplets className={`w-4 h-4 shrink-0 ${hasSchedules ? "text-primary" : "text-muted-foreground/60"}`} />
                          <span className="text-sm font-semibold text-foreground truncate">{pump}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-mono shrink-0">
                            {equip.hw_id}
                          </span>
                          <div className="ml-auto flex items-center gap-2 shrink-0">
                            {hasSchedules ? (
                              <>
                                <span className="text-[11px] text-muted-foreground hidden sm:inline">
                                  {pumpSchedules.length} prog.
                                </span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                  activeCount > 0
                                    ? "bg-primary/15 text-primary"
                                    : "bg-secondary text-muted-foreground"
                                }`}>
                                  {activeCount} ativa{activeCount === 1 ? "" : "s"}
                                </span>
                              </>
                            ) : (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground/70 font-medium">
                                Sem programações
                              </span>
                            )}
                          </div>
                        </button>
                        <div className="flex items-center gap-1 shrink-0 pl-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-primary"
                            onClick={() => openCreate(pump, equip.id)}
                            title="Nova programação"
                          >
                            <Plus className="w-4 h-4" />
                          </Button>
                          <button
                            onClick={() => togglePumpExpand(pump)}
                            className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground rounded"
                            aria-label={isExpanded ? "Recolher" : "Expandir"}
                          >
                            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="border-t border-border/60 bg-secondary/20 max-h-[360px] overflow-y-auto">
                          {pumpSchedules.length === 0 ? (
                            <div className="px-4 py-4 flex items-center justify-between gap-3">
                              <p className="text-xs text-muted-foreground">
                                Nenhuma programação configurada para este poço.
                              </p>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1.5 text-xs"
                                onClick={() => openCreate(pump, equip.id)}
                              >
                                <Plus className="w-3 h-3" /> Adicionar
                              </Button>
                            </div>
                          ) : (
                            (() => {
                              type Item = { schedId: string; isOn: boolean; time: string; active: boolean };
                              const byDay = new Map<string, Item[]>();
                              for (const d of weekDays) byDay.set(d.key, []);
                              for (const s of pumpSchedules) {
                                const isOn = s.mode === "on-only";
                                const time = isOn ? s.timeOn : s.timeOff;
                                for (const day of s.days) {
                                  byDay.get(day)?.push({ schedId: s.id, isOn, time, active: s.active });
                                }
                              }
                              for (const list of byDay.values()) {
                                list.sort((a, b) => a.time.localeCompare(b.time));
                              }
                              const usedDays = weekDays.filter((d) => (byDay.get(d.key)?.length ?? 0) > 0);

                              return (
                                <div className="px-3 py-2 space-y-1">
                                  {usedDays.length === 0 ? (
                                    <p className="text-[11px] text-muted-foreground py-1 px-2">
                                      Programações sem dias selecionados.
                                    </p>
                                  ) : (
                                    usedDays.map((d) => {
                                      const items = byDay.get(d.key) ?? [];
                                      return (
                                        <div
                                          key={d.key}
                                          className="flex items-start gap-3 px-2 py-1.5 rounded hover:bg-secondary/40 transition-colors"
                                        >
                                          <span className="text-[11px] font-bold uppercase text-muted-foreground tracking-wider w-10 shrink-0 mt-1.5">
                                            {d.label}
                                          </span>
                                          <div className="flex-1 flex flex-wrap gap-1.5 min-w-0">
                                            {items.map((it, idx) => {
                                              const isLive = it.active && cloud.engineActive;
                                              return (
                                                <div
                                                  key={`${it.schedId}-${idx}`}
                                                  className={`group inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded border transition-colors ${
                                                    it.isOn
                                                      ? isLive
                                                        ? "border-primary/40 bg-primary/10"
                                                        : "border-border bg-secondary"
                                                      : isLive
                                                        ? "border-destructive/40 bg-destructive/10"
                                                        : "border-border bg-secondary"
                                                  } ${!it.active ? "opacity-60" : ""}`}
                                                >
                                                  <button
                                                    onClick={() => openEdit(it.schedId)}
                                                    title={`${it.isOn ? "Ligar" : "Desligar"} às ${it.time} — clique para editar dias e horários`}
                                                    className={`flex items-center gap-1 ${
                                                      it.isOn
                                                        ? isLive ? "text-primary" : "text-foreground"
                                                        : isLive ? "text-destructive" : "text-foreground"
                                                    }`}
                                                  >
                                                    {it.isOn ? <Power className="w-3 h-3" /> : <PowerOff className="w-3 h-3" />}
                                                    <span className="text-[11px] font-semibold tabular-nums">{it.time}</span>
                                                  </button>
                                                  <Switch
                                                    checked={it.active}
                                                    onCheckedChange={() => toggleSchedule(it.schedId)}
                                                    title={it.active ? "Desativar esta programação" : "Ativar esta programação"}
                                                    className="scale-[0.55] data-[state=checked]:bg-primary shrink-0 -mx-0.5"
                                                  />
                                                  <button
                                                    onClick={() => confirmDelete(it.schedId)}
                                                    title="Excluir esta programação"
                                                    className="h-4 w-4 flex items-center justify-center text-muted-foreground/70 hover:text-destructive transition-colors"
                                                  >
                                                    <Trash2 className="w-3 h-3" />
                                                  </button>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      );
                                    })
                                  )}
                                  <p className="text-[10px] text-muted-foreground/70 px-2 pt-1 border-t border-border/40 mt-1">
                                    Toque no horário para editar · Switch ativa/desativa · Lixeira exclui
                                  </p>
                                </div>
                              );
                            })()
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          );
        })()}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {editingId !== null ? `Editar Programação — ${dialogPump}` : `Nova Programação — ${dialogPump}`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <Label className="text-foreground mb-2 block">O que esta programação faz?</Label>
              <RadioGroup
                value={form.mode}
                onValueChange={(val) => setForm((prev) => ({ ...prev, mode: val as ScheduleMode }))}
                className="grid grid-cols-2 gap-2"
              >
                <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${form.mode === "on-only" ? "border-primary bg-primary/10" : "border-border bg-secondary/30 hover:border-primary/40"}`}>
                  <RadioGroupItem value="on-only" />
                  <Power className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium text-foreground">Ligar Bomba</span>
                </label>
                <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${form.mode === "off-only" ? "border-destructive bg-destructive/10" : "border-border bg-secondary/30 hover:border-destructive/40"}`}>
                  <RadioGroupItem value="off-only" />
                  <PowerOff className="w-4 h-4 text-destructive" />
                  <span className="text-sm font-medium text-foreground">Desligar Bomba</span>
                </label>
              </RadioGroup>
              <p className="text-[11px] text-muted-foreground mt-2">
                Cada programação executa uma única ação. Para ligar e desligar, crie duas programações separadas — assim funciona certinho mesmo quando o ciclo cruza a meia-noite.
              </p>
            </div>
            <div>
              <Label className="text-foreground mb-2 block">Dias da Semana</Label>
              <div className="flex flex-wrap gap-3">
                {weekDays.map((d) => (
                  <label key={d.key} className="flex items-center gap-1.5 text-sm text-foreground cursor-pointer">
                    <Checkbox
                      checked={form.days.includes(d.key)}
                      onCheckedChange={() => toggleDay(d.key)}
                      className="border-border data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                    />
                    {d.label}
                  </label>
                ))}
              </div>
            </div>
            <div>
              {form.mode === "on-only" ? (
                <>
                  <Label className="text-foreground">Horário para Ligar</Label>
                  <Input
                    type="time"
                    className="bg-secondary border-border mt-1"
                    value={form.timeOn}
                    onChange={(e) => setForm((prev) => ({ ...prev, timeOn: e.target.value }))}
                  />
                </>
              ) : (
                <>
                  <Label className="text-foreground">Horário para Desligar</Label>
                  <Input
                    type="time"
                    className="bg-secondary border-border mt-1"
                    value={form.timeOff}
                    onChange={(e) => setForm((prev) => ({ ...prev, timeOff: e.target.value }))}
                  />
                </>
              )}
            </div>
            <Button onClick={handleSave} disabled={saving} className="w-full bg-primary text-primary-foreground gap-2">
              <Save className="w-4 h-4" />
              {saving
                ? (editingId !== null ? "Salvando…" : "Criando…")
                : (editingId !== null ? "Salvar Alterações" : "Criar Programação")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="bg-card border-border max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-foreground">Excluir Programação</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Tem certeza que deseja excluir esta programação? Esta ação não pode ser desfeita.
          </p>
          <DialogFooter className="gap-2 mt-4">
            <DialogClose asChild>
              <Button variant="outline">Cancelar</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleDelete} className="gap-2">
              <Trash2 className="w-4 h-4" /> Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Feriados Nacionais — movido para o final para não atrapalhar o acesso às programações */}
      <Card className="border-border overflow-hidden">
        <button
          onClick={() => setHolidayExpanded((prev) => !prev)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary/50 transition-colors text-left"
        >
          <div className="flex items-center gap-3">
            <PartyPopper className="w-5 h-5 text-primary" />
            <div>
              <h2 className="text-sm font-bold text-foreground">Feriados Nacionais</h2>
              <p className="text-xs text-muted-foreground">
                Ative para liberar o poço em <strong>livre demanda</strong> nos feriados nacionais
              </p>
            </div>
          </div>
          {holidayExpanded ? (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          )}
        </button>

        {holidayExpanded && (
          <div className="border-t border-border p-4 space-y-4">
            <div className="rounded-md bg-primary/5 border border-primary/20 p-3">
              <p className="text-xs text-foreground leading-relaxed">
                <strong>Como funciona:</strong> ao ativar um poço abaixo, nos dias de feriado nacional ele ignora a programação semanal e opera em <strong>Livre Demanda</strong> (sem restrição de horário). Isto <em>não</em> ativa nem desativa programações individuais — serve apenas para liberar o poço em datas especiais.
              </p>
            </div>

            <div>
              <Label className="text-foreground text-xs font-medium mb-2 block">Feriados Reconhecidos</Label>
              <div className="flex flex-wrap gap-2">
                {nationalHolidays.map((h) => (
                  <span key={h.date} className="text-[10px] px-2 py-1 rounded bg-primary/10 text-primary font-medium flex items-center gap-1">
                    <CalendarDays className="w-3 h-3" />
                    {h.date} — {h.name}
                  </span>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-foreground text-xs font-medium block">Ativar Livre Demanda em Feriados (por Poço)</Label>
              {pumpEquipments.length === 0 && (
                <p className="text-xs text-muted-foreground py-2">
                  Nenhum poço cadastrado. Cadastre equipamentos para configurar feriados.
                </p>
              )}
              {pumpEquipments.map((eq) => {
                const pump = eq.name.toUpperCase();
                const config = cloud.holidayConfigs[eq.id] ?? {
                  enabled: false,
                  mode: "free-demand" as const,
                  specialTimeOn: "06:00",
                  specialTimeOff: "22:00",
                };
                return (
                  <div key={eq.id} className={`flex items-center justify-between px-3 py-2.5 rounded-lg border transition-colors ${config.enabled ? "border-primary/30 bg-primary/5" : "border-border bg-secondary/30"}`}>
                    <div className="flex items-center gap-2">
                      <Droplets className="w-3.5 h-3.5 text-primary" />
                      <span className="text-sm font-bold text-foreground">{pump}</span>
                      {config.enabled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium">
                          Livre demanda em feriados
                        </span>
                      )}
                    </div>
                    <Switch
                      checked={config.enabled}
                      onCheckedChange={(checked) => updateHolidayConfig(eq.id, pump, { enabled: checked, mode: "free-demand" })}
                      className="data-[state=checked]:bg-primary scale-75"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Card>

      <AuditoriaPanel />
    </div>
  );

};

export default Automatico;
