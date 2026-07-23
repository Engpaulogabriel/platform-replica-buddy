import { useState, useEffect } from "react";
import { notifyRegistry, notify } from "@/lib/notify";
import { supabase } from "@/integrations/supabase/client";
import { confirmAction } from "@/lib/confirmDialog";
import { toast } from "sonner";
import RestrictedAuth from "@/components/RestrictedAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Plus, Pencil, Trash2, CircuitBoard, Droplets, Activity, Gauge,
  Check, X, Zap, AlertTriangle, Timer, HelpCircle, ChevronDown, ChevronUp,
  ListOrdered, Settings2, MapPin, Cloud, CloudOff, Loader2, Lock, Settings, RotateCcw,
} from "lucide-react";
import { useCadastrosCloud, type CloudPlc, type CloudEquipamento, type EquipTipo, type FonteTipo } from "@/hooks/useCadastrosCloud";
import { onQueueChange, isOnline as checkOnline, startOfflineQueueSync } from "@/lib/offlineQueue";
import PumpCfgDialog from "@/components/diagnostico/PumpCfgDialog";
import RepeaterCfgDialog from "@/components/diagnostico/RepeaterCfgDialog";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useUserFarms } from "@/hooks/useUserFarms";
import LevelCalibrationCard from "@/components/LevelCalibrationCard";
import { useFarmAccess } from "@/hooks/useFarmAccess";

const MAX_SAIDAS = 6;

const tipoLabels: Record<EquipTipo, string> = {
  poco: "Poço",
  bombeamento: "Bombeamento",
  nivel: "Nível",
  repetidor: "Repetidor",
  vazao: "Vazão/Consumo",
};

const tipoIcons: Record<EquipTipo, typeof Droplets> = {
  poco: Droplets,
  bombeamento: Zap,
  nivel: Activity,
  repetidor: Settings2,
  vazao: Gauge,
};

const tabItems = [
  { value: "plcs", label: "PLCs", icon: CircuitBoard },
  { value: "equipamentos", label: "Equipamentos", icon: Gauge },
  { value: "ajuda", label: "Ajuda", icon: HelpCircle },
];

const helpGuides = [
  {
    id: "intro", title: "Visão Geral do Sistema", icon: Settings2, color: "text-primary",
    steps: [
      { title: "Hierarquia do Sistema", desc: "PLCs (Controladores) controlam Equipamentos. Cada PLC tem até 6 saídas físicas." },
      { title: "Tipos de Equipamentos", desc: "Poço, Bombeamento ou Nível. Cada um com parâmetros próprios." },
      { title: "Fluxo de Configuração", desc: "Cadastre PLCs → vincule Equipamentos às saídas → configure parâmetros." },
      { title: "Sincronização em Nuvem", desc: "Todos os cadastros são salvos na nuvem em tempo real e ficam disponíveis em qualquer dispositivo." },
    ],
  },
  {
    id: "plc", title: "Cadastrando um PLC", icon: CircuitBoard, color: "text-blue-400",
    steps: [
      { title: "1. Aba PLCs", desc: "Acesse a aba 'PLCs'." },
      { title: "2. Adicionar PLC", desc: "Clique em 'Adicionar PLC'." },
      { title: "3. Nome", desc: "Identificador (ex: PLC-001)." },
      { title: "4. ID Hex", desc: "4 caracteres hexadecimais (ex: 1A2B). Único por fazenda." },
      { title: "5. Salvar", desc: "Clique em 'Salvar'." },
    ],
  },
  {
    id: "equip", title: "Cadastrando um Equipamento", icon: Gauge, color: "text-green-400",
    steps: [
      { title: "1. Aba Equipamentos", desc: "Selecione 'Equipamentos'." },
      { title: "2. Tipo", desc: "Poço, Bombeamento ou Nível." },
      { title: "3. PLC + Saída", desc: "Vincule a um PLC e escolha uma das 6 saídas (livres)." },
      { title: "4. Parâmetros", desc: "Preencha conforme o tipo (Horário de Pico, Altura Máxima, etc)." },
      { title: "5. Salvar", desc: "Equipamento aparece no Dashboard automaticamente." },
    ],
  },
];

interface PlcFormState { name: string; hw_id: string; }
interface EquipFormState {
  type: EquipTipo;
  name: string;
  plc_group_id: string;
  saida: string;
  output_count: "1" | "6";
  latitude: string;
  longitude: string;
  horas_pico: string;
  max_horas_dia: string;
  demanda_kw: string;
  power_kw: string;
  estimated_flow_m3h: string;
  max_height: string;
  alarm_low: string;
  alarm_high: string;
  fonte_tipo: "" | FonteTipo;
  fonte_id: string;
  alimenta_id: string;
  sector_id: string;
  /** Override por equipamento — "" = usa global da fazenda. */
  rf_radio: "" | "R1" | "R2" | "R3";
  /** Override por equipamento — "default" = usa global, "on" = via repetidor, "off" = direto. */
  rf_via_rep: "default" | "on" | "off";
  participates_night_cycle: boolean;
  vazao_mode: "off" | "estimated" | "real";
  vazao_cadastrada_m3h: string;
  vazao_m3_por_pulso: string;
}

const emptyEquipForm: EquipFormState = {
  type: "poco", name: "", plc_group_id: "", saida: "", output_count: "1",
  latitude: "", longitude: "",
  horas_pico: "17:00-21:00", max_horas_dia: "12", demanda_kw: "0", power_kw: "", estimated_flow_m3h: "",
  max_height: "4.0", alarm_low: "20", alarm_high: "90",
  fonte_tipo: "", fonte_id: "", alimenta_id: "", sector_id: "",
  rf_radio: "", rf_via_rep: "default",
  participates_night_cycle: true,
  vazao_mode: "off",
  vazao_cadastrada_m3h: "",
  vazao_m3_por_pulso: "1",
};

const numOrNull = (s: string): number | null => {
  if (!s.trim()) return null;
  const v = parseFloat(s.replace(",", "."));
  return Number.isFinite(v) ? v : null;
};

// Aceita decimal ("-12.97") ou DMS ("12°58'36.58\"S", "45° 2'9.04\"O", "12°58'36.58\"").
// Hemisférios suportados: N/S/E/W/O (Oeste)/L (Leste). Quando ausente, usa default (Brasil = S/W).
const parseCoord = (raw: string, defaultHem: "S" | "W" | "" = ""): number | null => {
  if (!raw || !raw.trim()) return null;
  const s = raw
    .trim()
    .normalize("NFKD")
    .replace(/[−–—]/g, "-")
    .replace(/[º˚]/g, "°")
    .replace(/[‘’´`′]/g, "'")
    .replace(/[“”″]/g, '"')
    .toUpperCase();
  const hem = s.match(/[NSEWOL]\b|[NSEWOL]$/)?.[0]?.charAt(0) ?? "";
  const nums = s.match(/-?\d+(?:[.,]\d+)?/g)?.map((n) => parseFloat(n.replace(",", "."))) ?? [];
  if (!nums.length) return null;

  const isDMS = /[°'"]/.test(s);
  let val = Math.abs(nums[0]);
  if (nums.length >= 2) val += Math.abs(nums[1]) / 60;
  if (nums.length >= 3) val += Math.abs(nums[2]) / 3600;
  if (nums[0] < 0) val = -val;
  if (hem === "S" || hem === "W" || hem === "O") val = -Math.abs(val);
  else if (hem === "N" || hem === "E" || hem === "L") val = Math.abs(val);
  else if (isDMS && defaultHem && val > 0) val = -val; // DMS sem hemisfério: assume Brasil
  return Number.isFinite(val) ? val : null;
};

const formatCoord = (n: number | null): string =>
  n == null ? "" : Number(n.toFixed(6)).toString();

// strip "%" e "m"
const cleanNumeric = (s: string): string => s.replace(/[^\d.,-]/g, "");

export const Cadastros = () => {
  const cloud = useCadastrosCloud();
  const { canDelete } = useFarmAccess();
  const userFarms = useUserFarms();
  const [activeTab, setActiveTab] = useState("plcs");
  const [expandedHelp, setExpandedHelp] = useState<string | null>(null);

  // Conectividade
  const [online, setOnline] = useState(checkOnline());
  const [pending, setPending] = useState(0);
  useEffect(() => {
    startOfflineQueueSync();
    const off = onQueueChange(setPending);
    const on = () => setOnline(true);
    const offE = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", offE);
    return () => {
      off();
      window.removeEventListener("online", on);
      window.removeEventListener("offline", offE);
    };
  }, []);

  // PLC dialog
  const [plcDialogOpen, setPlcDialogOpen] = useState(false);
  const [editingPlc, setEditingPlc] = useState<CloudPlc | null>(null);
  const [plcForm, setPlcForm] = useState<PlcFormState>({ name: "", hw_id: "" });

  // Equip dialog
  const [equipDialogOpen, setEquipDialogOpen] = useState(false);
  const [editingEquip, setEditingEquip] = useState<CloudEquipamento | null>(null);
  const [equipForm, setEquipForm] = useState<EquipFormState>(emptyEquipForm);

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<{ type: "plc" | "equip"; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Filter
  const [equipFilter, setEquipFilter] = useState<"todos" | EquipTipo>("todos");

  // CFG dialog (configuração remota da bomba)
  const farmId = useDefaultFarmId();
  const [cfgTarget, setCfgTarget] = useState<CloudEquipamento | null>(null);
  const cfgPlc = cfgTarget ? cloud.plcs.find((p) => p.id === cfgTarget.plc_group_id) ?? null : null;
  const cfgTsnn = cfgPlc?.hw_id ?? cfgTarget?.hw_id?.substring(0, 4) ?? "";

  // Helpers
  const getPlcName = (id: string | null) => cloud.plcs.find((p) => p.id === id)?.name ?? "—";
  const plcHasEquipamentos = (id: string) => cloud.equipments.some((e) => e.plc_group_id === id);

  // ───────── PLC handlers ─────────
  const openNewPlc = () => {
    if (!cloud.isAdmin) { notify.fail("Cadastros", "apenas administradores podem cadastrar."); return; }
    setEditingPlc(null);
    setPlcForm({ name: "", hw_id: "" });
    setPlcDialogOpen(true);
  };
  const openEditPlc = (plc: CloudPlc) => {
    if (!cloud.isAdmin) { notify.fail("Cadastros", "apenas administradores podem editar."); return; }
    setEditingPlc(plc);
    setPlcForm({ name: plc.name, hw_id: plc.hw_id });
    setPlcDialogOpen(true);
  };
  const plcSavingDisabled = !plcForm.name.trim() || !plcForm.hw_id.trim();
  const savePlc = async () => {
    if (!plcForm.name.trim() || !plcForm.hw_id.trim()) {
      notify.fail("PLC", "preencha nome e ID Hex.");
      return;
    }
    try {
      let ok = false;
      if (editingPlc) {
        ok = await cloud.updatePlc(editingPlc.id, plcForm);
      } else {
        const created = await cloud.createPlc(plcForm);
        ok = !!created;
      }
      if (ok) setPlcDialogOpen(false);
    } catch (err) {
      console.error("[savePlc] exception", err);
      notify.fail("PLC", `erro inesperado — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ───────── Equip handlers ─────────
  const openNewEquip = () => {
    if (!cloud.isAdmin) { notify.fail("Cadastros", "apenas administradores podem cadastrar."); return; }
    if (cloud.plcs.length === 0) { notify.fail("Equipamento", "cadastre um PLC primeiro."); return; }
    setEditingEquip(null);
    setEquipForm(emptyEquipForm);
    setEquipDialogOpen(true);
  };
  const openEditEquip = (e: CloudEquipamento) => {
    if (!cloud.isAdmin) { notify.fail("Cadastros", "apenas administradores podem editar."); return; }
    setEditingEquip(e);
    setEquipForm({
      type: e.type,
      name: e.name,
      plc_group_id: e.plc_group_id ?? "",
      saida: e.saida ? String(e.saida) : "",
      output_count: cloud.plcs.find((p) => p.id === e.plc_group_id)?.output_count === 6 && e.type === "bombeamento" ? "6" : "1",
      latitude: e.latitude != null ? String(e.latitude) : "",
      longitude: e.longitude != null ? String(e.longitude) : "",
      horas_pico: e.horas_pico ?? "17:00-21:00",
      max_horas_dia: e.max_horas_dia != null ? String(e.max_horas_dia) : "12",
      demanda_kw: e.demanda_kw != null ? String(e.demanda_kw) : "0",
      power_kw: e.power_kw != null ? String(e.power_kw) : "",
      estimated_flow_m3h: e.estimated_flow_m3h != null ? String(e.estimated_flow_m3h) : "",
      max_height: e.max_height != null ? String(e.max_height) : "4.0",
      alarm_low: e.alarm_low != null ? String(e.alarm_low) : "20",
      alarm_high: e.alarm_high != null ? String(e.alarm_high) : "90",
      fonte_tipo: e.fonte_tipo ?? "",
      fonte_id: e.fonte_id ?? "",
      alimenta_id: e.alimenta_id ?? "",
      sector_id: e.sector_id ?? "",
      rf_radio: (e.rf_radio ?? "") as "" | "R1" | "R2" | "R3",
      rf_via_rep: e.rf_via_rep == null ? "default" : (e.rf_via_rep ? "on" : "off"),
      participates_night_cycle: e.participates_night_cycle !== false,
      vazao_mode: ((e as unknown as { vazao_mode?: string }).vazao_mode as "off" | "estimated" | "real") ?? "off",
      vazao_cadastrada_m3h: (e as unknown as { vazao_cadastrada_m3h?: number | null }).vazao_cadastrada_m3h != null
        ? String((e as unknown as { vazao_cadastrada_m3h?: number | null }).vazao_cadastrada_m3h)
        : "",
      vazao_m3_por_pulso: (e as unknown as { vazao_m3_por_pulso?: number | null }).vazao_m3_por_pulso != null
        ? String((e as unknown as { vazao_m3_por_pulso?: number | null }).vazao_m3_por_pulso)
        : "1",
    });
    setEquipDialogOpen(true);
  };
  const saveEquip = async () => {
    if (!equipForm.name.trim() || !equipForm.plc_group_id || (equipForm.type !== "nivel" && !equipForm.saida)) {
      notify.fail("Equipamento", "preencha todos os campos obrigatórios.");
      return;
    }
    const saida = equipForm.type === "nivel" ? null : Number(equipForm.saida);
    const input = {
      name: equipForm.name,
      type: equipForm.type,
      plc_group_id: equipForm.plc_group_id,
      saida,
      output_count: equipForm.type === "bombeamento" ? Number(equipForm.output_count) : 1,
      latitude: parseCoord(equipForm.latitude, "S"),
      longitude: parseCoord(equipForm.longitude, "W"),
      horas_pico: equipForm.type === "nivel" ? null : (equipForm.horas_pico || null),
      max_horas_dia: equipForm.type === "nivel" ? null : numOrNull(equipForm.max_horas_dia),
      demanda_kw: equipForm.type === "nivel" ? null : numOrNull(equipForm.demanda_kw),
      power_kw: equipForm.type === "nivel" ? null : numOrNull(equipForm.power_kw),
      estimated_flow_m3h: equipForm.type === "nivel" ? null : numOrNull(equipForm.estimated_flow_m3h),
      max_height: equipForm.type === "nivel" ? numOrNull(cleanNumeric(equipForm.max_height)) : null,
      alarm_low: equipForm.type === "nivel" ? numOrNull(cleanNumeric(equipForm.alarm_low)) : null,
      alarm_high: equipForm.type === "nivel" ? numOrNull(cleanNumeric(equipForm.alarm_high)) : null,
      fonte_tipo: (equipForm.fonte_tipo || null) as FonteTipo | null,
      fonte_id: equipForm.fonte_id || null,
      alimenta_id: equipForm.alimenta_id || null,
      sector_id: equipForm.sector_id || null,
      rf_radio: equipForm.rf_radio === "" ? null : equipForm.rf_radio,
      rf_via_rep: equipForm.rf_via_rep === "default" ? null : equipForm.rf_via_rep === "on",
      participates_night_cycle: equipForm.type === "nivel" ? true : equipForm.participates_night_cycle,
      vazao_mode: equipForm.type === "nivel" ? "off" : equipForm.vazao_mode,
      vazao_cadastrada_m3h: equipForm.type === "nivel" || equipForm.vazao_mode !== "estimated"
        ? 0
        : (numOrNull(equipForm.vazao_cadastrada_m3h) ?? 0),
      vazao_m3_por_pulso: equipForm.type === "nivel" || equipForm.vazao_mode !== "real"
        ? 1
        : (Number(equipForm.vazao_m3_por_pulso) || 1),
    };
    let ok = false;
    if (editingEquip) {
      ok = await cloud.updateEquip(editingEquip.id, input);
    } else {
      const created = await cloud.createEquip(input);
      ok = !!created;
    }
    if (ok) setEquipDialogOpen(false);
  };

  // ───────── Delete ─────────
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      if (deleteTarget.type === "plc") {
        if (plcHasEquipamentos(deleteTarget.id)) {
          notify.fail("PLC", "remova os equipamentos vinculados antes de excluir.");
          return;
        }
        await cloud.deletePlc(deleteTarget.id);
      } else {
        await cloud.deleteEquip(deleteTarget.id);
      }
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  // ───────── Filters ─────────
  const filteredEquipamentos = equipFilter === "todos"
    ? cloud.equipments
    : cloud.equipments.filter((e) => e.type === equipFilter);

  const equipCounts = {
    todos: cloud.equipments.length,
    poco: cloud.equipments.filter((e) => e.type === "poco").length,
    bombeamento: cloud.equipments.filter((e) => e.type === "bombeamento").length,
    nivel: cloud.equipments.filter((e) => e.type === "nivel").length,
  };

  const availableForPlc = (plcGroupId: string, excludeId?: string) =>
    cloud.availableSaidas(plcGroupId, excludeId);

  // ───────── Render ─────────
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Equipamentos</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Cadastros sincronizados em tempo real na nuvem
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!cloud.isAdmin && cloud.farmId && (
            <Badge variant="outline" className="gap-1.5 text-warning border-warning/50">
              <Lock className="w-3 h-3" /> Modo leitura
            </Badge>
          )}
          {online ? (
            <Badge variant="outline" className="gap-1.5 text-primary border-primary/50">
              <Cloud className="w-3 h-3" /> Online
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1.5 text-destructive border-destructive/50">
              <CloudOff className="w-3 h-3" /> Offline
            </Badge>
          )}
          {pending > 0 && (
            <Badge variant="outline" className="gap-1.5 text-info border-info/50">
              <Loader2 className="w-3 h-3 animate-spin" /> {pending} pendente{pending > 1 ? "s" : ""}
            </Badge>
          )}
        </div>
      </div>

      {cloud.error === "no_default_farm" && (
        <Card className="bg-warning/10 border-warning/40">
          <CardContent className="p-4 text-sm">
            <strong>Sem fazenda padrão.</strong> Cadastre uma fazenda em Suporte Técnico → Fazenda antes de continuar.
          </CardContent>
        </Card>
      )}
      {cloud.error && cloud.error !== "no_default_farm" && (
        <Card className="bg-destructive/10 border-destructive/40">
          <CardContent className="p-4 text-sm text-destructive">
            Erro ao carregar cadastros: {cloud.error}
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-secondary border border-border">
          {tabItems.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground gap-2">
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* PLCs */}
        <TabsContent value="plcs" className="mt-4">
          <Card className="bg-card border-border">
            <CardContent className="p-0">
              <div className="flex items-center justify-between p-4 border-b border-border">
                <h3 className="font-semibold text-foreground">PLCs de Comunicação</h3>
                <Button size="sm" className="bg-primary text-primary-foreground gap-2" onClick={openNewPlc} disabled={!cloud.isAdmin}>
                  <Plus className="w-4 h-4" /> Adicionar PLC
                </Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-secondary/50">
                    <TableHead className="text-muted-foreground">Nome</TableHead>
                    <TableHead className="text-muted-foreground">ID Hex</TableHead>
                    <TableHead className="text-muted-foreground">Saídas Usadas</TableHead>
                    <TableHead className="text-muted-foreground text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cloud.loading && (
                    <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Carregando…
                    </TableCell></TableRow>
                  )}
                  {!cloud.loading && cloud.plcs.map((plc) => {
                    const usedSlots = cloud.usedSaidas(plc.id);
                    return (
                      <TableRow key={plc.id} className="border-border hover:bg-secondary/50">
                        <TableCell className="text-foreground font-medium">{plc.name}</TableCell>
                        <TableCell className="text-muted-foreground font-mono">{plc.hw_id}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {Array.from({ length: MAX_SAIDAS }, (_, i) => i + 1).map((slot) => (
                              <div
                                key={slot}
                                className={`w-6 h-6 rounded text-xs flex items-center justify-center font-mono ${
                                  usedSlots.includes(slot)
                                    ? "bg-primary/20 text-primary border border-primary/40"
                                    : "bg-secondary text-muted-foreground border border-border"
                                }`}
                                title={
                                  usedSlots.includes(slot)
                                    ? `Saída ${slot}: ${cloud.equipments.find((e) => e.plc_group_id === plc.id && e.saida === slot)?.name}`
                                    : `Saída ${slot}: Livre`
                                }
                              >
                                {slot}
                              </div>
                            ))}
                            <span className="text-xs text-muted-foreground ml-2">{usedSlots.length}/{MAX_SAIDAS}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right space-x-1">
                          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground" onClick={() => openEditPlc(plc)} disabled={!cloud.isAdmin}>
                            <Pencil className="w-4 h-4" />
                          </Button>
                          {canDelete && (
                            <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={() => setDeleteTarget({ type: "plc", id: plc.id, name: plc.name })} disabled={!cloud.isAdmin}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!cloud.loading && cloud.plcs.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                        Nenhum PLC cadastrado. Clique em "Adicionar PLC" para começar.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* EQUIPAMENTOS */}
        <TabsContent value="equipamentos" className="mt-4 space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            {(["todos", "poco", "bombeamento", "nivel"] as const).map((filter) => (
              <Button
                key={filter}
                size="sm"
                variant={equipFilter === filter ? "default" : "outline"}
                className="gap-1.5"
                onClick={() => setEquipFilter(filter)}
              >
                {filter === "todos" && <Gauge className="w-3.5 h-3.5" />}
                {filter === "poco" && <Droplets className="w-3.5 h-3.5" />}
                {filter === "bombeamento" && <Zap className="w-3.5 h-3.5" />}
                {filter === "nivel" && <Activity className="w-3.5 h-3.5" />}
                {filter === "todos" ? "Todos" : tipoLabels[filter]}
                <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{equipCounts[filter]}</Badge>
              </Button>
            ))}
          </div>

          <Card className="bg-card border-border">
            <CardContent className="p-0">
              <div className="flex items-center justify-between p-4 border-b border-border">
                <h3 className="font-semibold text-foreground">
                  {equipFilter === "todos" ? "Todos os Equipamentos" : tipoLabels[equipFilter]}
                </h3>
                <Button size="sm" className="bg-primary text-primary-foreground gap-2" onClick={openNewEquip} disabled={!cloud.isAdmin}>
                  <Plus className="w-4 h-4" /> Adicionar
                </Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-secondary/50">
                    <TableHead className="text-muted-foreground">Tipo</TableHead>
                    <TableHead className="text-muted-foreground">Nome</TableHead>
                    <TableHead className="text-muted-foreground">PLC</TableHead>
                    <TableHead className="text-muted-foreground">Saída</TableHead>
                    <TableHead className="text-muted-foreground">hw_id</TableHead>
                    <TableHead className="text-muted-foreground">Coordenadas</TableHead>
                    <TableHead className="text-muted-foreground">Detalhes</TableHead>
                    <TableHead className="text-muted-foreground text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cloud.loading && (
                    <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Carregando…
                    </TableCell></TableRow>
                  )}
                  {!cloud.loading && filteredEquipamentos.map((equip) => {
                    const Icon = tipoIcons[equip.type];
                    return (
                      <TableRow key={equip.id} className="border-border hover:bg-secondary/50">
                        <TableCell>
                          <Badge variant="outline" className="gap-1">
                            <Icon className="w-3 h-3" />
                            {tipoLabels[equip.type]}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-foreground font-medium">{equip.name}</TableCell>
                        <TableCell className="text-muted-foreground">{getPlcName(equip.plc_group_id)}</TableCell>
                        <TableCell><Badge variant="secondary" className="font-mono">{equip.type === "nivel" ? "—" : (equip.saida ?? "—")}</Badge></TableCell>
                        <TableCell className="text-muted-foreground font-mono text-xs">{equip.hw_id}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {equip.latitude != null && equip.longitude != null ? (
                            <span className="flex items-center gap-1">
                              <MapPin className="w-3 h-3 text-info" />
                              {equip.latitude}, {equip.longitude}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {equip.type !== "nivel" ? (
                            <div className="flex items-center gap-3">
                              <span className="flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-warning" />{equip.horas_pico ?? "—"}</span>
                              <span className="flex items-center gap-1"><Timer className="w-3 h-3" />{equip.max_horas_dia ?? "—"}h</span>
                              <span className="flex items-center gap-1"><Zap className="w-3 h-3" />{equip.demanda_kw ?? "—"}kW</span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-3">
                              <span>Alt: {equip.level_max_meters ?? equip.max_height ?? "—"}m</span>
                              <span className="text-warning">Baixo: {equip.alarm_low ?? "—"}%</span>
                              <span className="text-destructive">Alto: {equip.alarm_high ?? "—"}%</span>
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right space-x-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-primary"
                            title={
                              equip.type === "repetidor"
                                ? "Configurações avançadas do repetidor"
                                : equip.type === "nivel"
                                ? "Configurar sensor de nível (CFG remoto)"
                                : "Configurar bomba (CFG remoto)"
                            }
                            onClick={() => setCfgTarget(equip)}
                            disabled={!cloud.isAdmin}
                          >
                            <Settings className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground" onClick={() => openEditEquip(equip)} disabled={!cloud.isAdmin}>
                            <Pencil className="w-4 h-4" />
                          </Button>
                          {canDelete && (
                            <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={() => setDeleteTarget({ type: "equip", id: equip.id, name: equip.name })} disabled={!cloud.isAdmin}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!cloud.loading && filteredEquipamentos.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                        {cloud.plcs.length === 0
                          ? "Cadastre um PLC primeiro na aba PLCs"
                          : 'Nenhum equipamento cadastrado. Clique em "Adicionar" para começar.'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* AJUDA */}
        <TabsContent value="ajuda" className="mt-4 space-y-4">
          <Card className="bg-card border-border">
            <CardContent className="p-6">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <HelpCircle className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-foreground">Guia de Configuração</h2>
                  <p className="text-xs text-muted-foreground">Cadastros 100% nuvem com sincronização em tempo real</p>
                </div>
              </div>
              <div className="space-y-3">
                {helpGuides.map((guide) => {
                  const Icon = guide.icon;
                  const isExpanded = expandedHelp === guide.id;
                  return (
                    <div key={guide.id} className="border border-border rounded-xl overflow-hidden">
                      <button
                        onClick={() => setExpandedHelp(isExpanded ? null : guide.id)}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-secondary/50 transition-colors text-left"
                      >
                        <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center">
                          <Icon className={`w-4 h-4 ${guide.color}`} />
                        </div>
                        <span className="flex-1 text-sm font-semibold text-foreground">{guide.title}</span>
                        {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                      </button>
                      {isExpanded && (
                        <div className="px-4 pb-4 space-y-3">
                          <div className="h-px bg-border" />
                          {guide.steps.map((step, i) => (
                            <div key={i} className="flex gap-3">
                              <div className="flex flex-col items-center">
                                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                                  <span className="text-[10px] font-bold text-primary">{i + 1}</span>
                                </div>
                                {i < guide.steps.length - 1 && <div className="w-px flex-1 bg-border mt-1" />}
                              </div>
                              <div className="pb-3">
                                <p className="text-sm font-semibold text-foreground">{step.title}</p>
                                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{step.desc}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* PLC dialog */}
      <Dialog open={plcDialogOpen} onOpenChange={setPlcDialogOpen}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-foreground">{editingPlc ? "Editar PLC" : "Novo PLC"}</DialogTitle>
            <DialogDescription>Identificação e endereço hexadecimal do controlador.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-muted-foreground">Nome</Label>
              <Input value={plcForm.name} onChange={(e) => setPlcForm({ ...plcForm, name: e.target.value })} placeholder="PLC-001" className="bg-secondary border-border" />
            </div>
            <div>
              <Label className="text-muted-foreground">ID Hex (4 caracteres)</Label>
              <Input value={plcForm.hw_id} onChange={(e) => setPlcForm({ ...plcForm, hw_id: e.target.value.toUpperCase() })} placeholder="1A2B" maxLength={4} className="bg-secondary border-border font-mono" />
              <p className="text-[10px] text-muted-foreground mt-1">Único por fazenda. Apenas 0-9 e A-F.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlcDialogOpen(false)}>Cancelar</Button>
            <Button type="button" onClick={savePlc} disabled={plcSavingDisabled} className="bg-primary text-primary-foreground">Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Equipment dialog */}
      <Dialog open={equipDialogOpen} onOpenChange={setEquipDialogOpen}>
        <DialogContent className="bg-card border-border max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-foreground">{editingEquip ? "Editar Equipamento" : "Novo Equipamento"}</DialogTitle>
            <DialogDescription>Configuração de poço, bombeamento ou sensor de nível.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
            <div className="rounded-md border border-border bg-secondary/40 p-3">
              <div className="flex items-center justify-between mb-1">
                <Label className="text-muted-foreground text-xs">Fazenda</Label>
                {userFarms.farms.length > 1 && (
                  <span className="text-[10px] text-muted-foreground">
                    Trocar fazenda recarrega a tela
                  </span>
                )}
              </div>
              {userFarms.farms.length === 0 ? (
                <p className="text-xs text-muted-foreground">Carregando fazendas…</p>
              ) : userFarms.farms.length === 1 ? (
                <div className="text-sm font-medium text-foreground flex items-center gap-2">
                  <MapPin className="h-3.5 w-3.5 text-primary" />
                  {userFarms.farms[0].name}
                  {userFarms.farms[0].city && (
                    <span className="text-xs text-muted-foreground font-normal">
                      — {userFarms.farms[0].city}{userFarms.farms[0].state ? `/${userFarms.farms[0].state}` : ""}
                    </span>
                  )}
                </div>
              ) : (
                <Select
                  value={userFarms.activeFarmId ?? ""}
                  onValueChange={(v) => { void userFarms.setActiveFarm(v); }}
                  disabled={!!editingEquip}
                >
                  <SelectTrigger className="bg-secondary border-border">
                    <SelectValue placeholder="Selecione a fazenda" />
                  </SelectTrigger>
                  <SelectContent>
                    {userFarms.farms.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}{f.city ? ` — ${f.city}${f.state ? `/${f.state}` : ""}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {editingEquip && userFarms.farms.length > 1 && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  Não é possível mover um equipamento existente entre fazendas.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-muted-foreground">Tipo</Label>
                <Select value={equipForm.type} onValueChange={(v) => setEquipForm({ ...equipForm, type: v as EquipTipo, output_count: v === "bombeamento" ? equipForm.output_count : "1" })}>
                  <SelectTrigger className="bg-secondary border-border"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="poco">Poço</SelectItem>
                    <SelectItem value="bombeamento">Bombeamento</SelectItem>
                    <SelectItem value="nivel">Nível</SelectItem>
                    <SelectItem value="vazao">Vazão/Consumo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-muted-foreground">Nome</Label>
                <Input value={equipForm.name} onChange={(e) => setEquipForm({ ...equipForm, name: e.target.value })} placeholder="Poço 01" className="bg-secondary border-border" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-muted-foreground">PLC</Label>
                <Select value={equipForm.plc_group_id} onValueChange={(v) => setEquipForm({ ...equipForm, plc_group_id: v, saida: "" })}>
                  <SelectTrigger className="bg-secondary border-border"><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>
                    {(() => {
                      const isPoco = equipForm.type === "poco";
                      const list = cloud.plcs.filter((p) => {
                        if (!isPoco) return true;
                        // Para tipo "poço": esconde PLCs que já têm um poço cadastrado
                        // (exceto se for justamente o poço sendo editado)
                        const usedByPoco = cloud.equipments.find(
                          (e) => e.plc_group_id === p.id && e.type === "poco" && e.id !== editingEquip?.id,
                        );
                        return !usedByPoco;
                      });
                      if (list.length === 0) {
                        return (
                          <div className="px-2 py-3 text-xs text-muted-foreground">
                            {isPoco
                              ? "Todas as PLCs já estão vinculadas a um poço."
                              : "Nenhuma PLC cadastrada."}
                          </div>
                        );
                      }
                      return list.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name} ({p.hw_id})</SelectItem>
                      ));
                    })()}
                  </SelectContent>
                </Select>
              </div>
              {equipForm.type !== "nivel" ? (
                <div>
                  <Label className="text-muted-foreground">Saída</Label>
                  <Select value={equipForm.saida} onValueChange={(v) => setEquipForm({ ...equipForm, saida: v })} disabled={!equipForm.plc_group_id}>
                    <SelectTrigger className="bg-secondary border-border"><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>
                      {equipForm.plc_group_id && availableForPlc(equipForm.plc_group_id, editingEquip?.id).map((s) => (
                        <SelectItem key={s} value={String(s)}>Saída {s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div />
              )}
            </div>

            {equipForm.type === "bombeamento" && (
              <div>
                <Label className="text-muted-foreground">Saídas da PLC</Label>
                <Select value={equipForm.output_count} onValueChange={(v) => setEquipForm({ ...equipForm, output_count: v as "1" | "6" })}>
                  <SelectTrigger className="bg-secondary border-border"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 saída</SelectItem>
                    <SelectItem value="6">6 saídas</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-muted-foreground">Latitude</Label>
                <Input
                  value={equipForm.latitude}
                  onChange={(e) => setEquipForm({ ...equipForm, latitude: e.target.value })}
                  onBlur={(e) => {
                    const v = parseCoord(e.target.value, "S");
                    if (v != null) setEquipForm({ ...equipForm, latitude: formatCoord(v) });
                  }}
                  placeholder='-15.7801 ou 12°58&apos;36.58&quot;S'
                  className="bg-secondary border-border"
                />
              </div>
              <div>
                <Label className="text-muted-foreground">Longitude</Label>
                <Input
                  value={equipForm.longitude}
                  onChange={(e) => setEquipForm({ ...equipForm, longitude: e.target.value })}
                  onBlur={(e) => {
                    const v = parseCoord(e.target.value, "W");
                    if (v != null) setEquipForm({ ...equipForm, longitude: formatCoord(v) });
                  }}
                  placeholder='-47.9292 ou 45°2&apos;9.04&quot;O'
                  className="bg-secondary border-border"
                />
              </div>
            </div>

            {equipForm.type !== "nivel" ? (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-muted-foreground">Horário de Pico</Label>
                  <Input value={equipForm.horas_pico} onChange={(e) => setEquipForm({ ...equipForm, horas_pico: e.target.value })} placeholder="17:00-21:00" className="bg-secondary border-border" />
                </div>
                <div>
                  <Label className="text-muted-foreground">Máx Horas/Dia</Label>
                  <Input value={equipForm.max_horas_dia} onChange={(e) => setEquipForm({ ...equipForm, max_horas_dia: e.target.value })} placeholder="12" className="bg-secondary border-border" />
                </div>
                <div>
                  <Label className="text-muted-foreground">Demanda (kW)</Label>
                  <Input value={equipForm.demanda_kw} onChange={(e) => setEquipForm({ ...equipForm, demanda_kw: e.target.value })} placeholder="15.5" className="bg-secondary border-border" />
                </div>
              </div>
            ) : null}

            {equipForm.type !== "nivel" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-muted-foreground">Potência (kW)</Label>
                  <Input
                    value={equipForm.power_kw}
                    onChange={(e) => setEquipForm({ ...equipForm, power_kw: e.target.value })}
                    placeholder="ex: 75"
                    className="bg-secondary border-border"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">Usado para custo de energia (kWh).</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Vazão estimada (m³/h)</Label>
                  <Input
                    value={equipForm.estimated_flow_m3h}
                    onChange={(e) => setEquipForm({ ...equipForm, estimated_flow_m3h: e.target.value })}
                    placeholder="ex: 120"
                    className="bg-secondary border-border"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">Usado para volume bombeado (m³).</p>
                </div>
              </div>
            )}

            {equipForm.type !== "nivel" && (
              <div className="rounded-md border border-border bg-secondary/30 p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <Gauge className="h-4 w-4 text-primary" />
                  <Label className="text-foreground">Vazão e Consumo de Água</Label>
                </div>
                <div>
                  <Label className="text-muted-foreground text-xs">Modo de medição</Label>
                  <Select
                    value={equipForm.vazao_mode}
                    onValueChange={(v) => setEquipForm({ ...equipForm, vazao_mode: v as "off" | "estimated" | "real" })}
                  >
                    <SelectTrigger className="bg-secondary border-border mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">Desativado</SelectItem>
                      <SelectItem value="estimated">Estimado (calculado por tempo × vazão cadastrada)</SelectItem>
                      <SelectItem value="real">Real (sensor de pulso na placa — N2)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {equipForm.vazao_mode === "estimated" && (
                  <div>
                    <Label className="text-muted-foreground text-xs">Vazão da bomba (m³/h)</Label>
                    <Input
                      value={equipForm.vazao_cadastrada_m3h}
                      onChange={(e) => setEquipForm({ ...equipForm, vazao_cadastrada_m3h: e.target.value })}
                      placeholder="ex: 60"
                      className="bg-secondary border-border mt-1"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      O consumo diário será calculado como vazão × horas ligada no dia.
                    </p>
                  </div>
                )}
                {equipForm.vazao_mode === "real" && (
                  <div className="space-y-2">
                    <div>
                      <Label className="text-muted-foreground text-xs">Fator (m³ por pulso)</Label>
                      <Select
                        value={equipForm.vazao_m3_por_pulso}
                        onValueChange={(v) => setEquipForm({ ...equipForm, vazao_m3_por_pulso: v })}
                      >
                        <SelectTrigger className="bg-secondary border-border mt-1"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3, 5, 10, 25].map((n) => (
                            <SelectItem key={n} value={String(n)}>{n} m³ / pulso</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Vazão instantânea (m³/h) e consumo acumulado (m³) são lidos automaticamente do sensor
                      da placa (N2/N3). Reset do contador diário à meia-noite.
                    </p>
                    {editingEquip && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={async () => {
                          if (!editingEquip) return;
                          const ok = await confirmAction({
                            title: "Resetar Contador de Vazão",
                            description:
                              "Tem certeza que deseja resetar o contador de vazão? O consumo acumulado até agora será salvo no histórico e o contador voltará a zero.",
                            confirmLabel: "Resetar",
                            variant: "destructive",
                          });
                          if (!ok) return;
                          try {
                            // Apenas sinaliza reset pendente. O agente:
                            //  1) detecta a confirmação RV do firmware,
                            //  2) soma o segmento pré-reset ao acumulador do dia,
                            //  3) recalcula flow_total_m3 automaticamente.
                            // NÃO gravar em daily_consumption aqui e NÃO zerar flow_total_m3.
                            const { error } = await supabase
                              .from("equipments")
                              .update({ vazao_reset_pending: true } as never)
                              .eq("id", editingEquip.id);
                            if (error) throw error;

                            toast.success(
                              "Comando RV será enviado ao firmware na próxima leitura. O agente somará o consumo pré-reset ao total do dia.",
                            );
                            await cloud.refresh?.();
                          } catch (err) {
                            console.error("[reset flow counter]", err);
                            toast.error("Falha ao resetar o contador. Tente novamente.");
                          }
                        }}
                      >
                        <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                        Resetar Contador de Vazão
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}



            {equipForm.type !== "nivel" && equipForm.type !== "repetidor" && (
              <div className="flex items-start gap-3 rounded-md border border-border bg-secondary/30 p-3">
                <input
                  id="participates_night_cycle"
                  type="checkbox"
                  checked={equipForm.participates_night_cycle}
                  onChange={(e) => setEquipForm({ ...equipForm, participates_night_cycle: e.target.checked })}
                  className="mt-1 h-4 w-4 accent-primary"
                />
                <div className="flex-1">
                  <Label htmlFor="participates_night_cycle" className="text-foreground cursor-pointer">
                    Participa do ciclo noturno
                  </Label>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Marque para incluir esta bomba no cálculo de eficiência energética (ciclo 21h→18h). Desmarque para bombas de reserva, irrigação diurna ou que não operam à noite.
                  </p>
                </div>
              </div>
            )}

            {equipForm.type === "nivel" && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-muted-foreground">Altura Máx (m)</Label>
                  <Input value={equipForm.max_height} onChange={(e) => setEquipForm({ ...equipForm, max_height: e.target.value })} placeholder="4.0" className="bg-secondary border-border" />
                </div>
                <div>
                  <Label className="text-muted-foreground">Alarme Baixo (%)</Label>
                  <Input value={equipForm.alarm_low} onChange={(e) => setEquipForm({ ...equipForm, alarm_low: e.target.value })} placeholder="20" className="bg-secondary border-border" />
                </div>
                <div>
                  <Label className="text-muted-foreground">Alarme Alto (%)</Label>
                  <Input value={equipForm.alarm_high} onChange={(e) => setEquipForm({ ...equipForm, alarm_high: e.target.value })} placeholder="90" className="bg-secondary border-border" />
                </div>
              </div>
            )}

            {equipForm.type === "nivel" && editingEquip && (
              <div className="rounded-md border border-border bg-secondary/30 p-3">
                <LevelCalibrationCard equip={editingEquip} compact />
              </div>
            )}
            {equipForm.type === "nivel" && !editingEquip && (
              <p className="text-xs text-muted-foreground">
                Salve o equipamento primeiro para acessar a calibração N1/N2.
              </p>
            )}

            <div>
              <div className="flex items-center justify-between">
                <Label className="text-muted-foreground">Setor</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs gap-1"
                  disabled={!cloud.isAdmin}
                  onClick={async () => {
                    const name = window.prompt("Nome do novo setor:")?.trim();
                    if (!name) return;
                    const created = await cloud.createSector(name);
                    if (created) {
                      setEquipForm((f) => ({ ...f, sector_id: created.id }));
                      notifyRegistry.created("Setor", created.name);
                    }
                  }}
                >
                  <Plus className="h-3 w-3" /> Novo
                </Button>
              </div>
              <Select
                value={equipForm.sector_id || "__none__"}
                onValueChange={(v) => setEquipForm({ ...equipForm, sector_id: v === "__none__" ? "" : v })}
              >
                <SelectTrigger className="bg-secondary border-border">
                  <SelectValue placeholder="Selecione um setor" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— Sem setor —</SelectItem>
                  {cloud.sectors.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {cloud.sectors.length === 0 && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  Nenhum setor cadastrado ainda. Use o botão <span className="font-semibold text-foreground">+ Novo</span> acima para criar agora.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-muted-foreground">Fonte (opcional)</Label>
                <Select
                  value={
                    equipForm.fonte_id
                      ? `equip:${equipForm.fonte_id}`
                      : equipForm.fonte_tipo
                        ? `tipo:${equipForm.fonte_tipo}`
                        : "__none__"
                  }
                  onValueChange={(v) => {
                    if (v === "__none__") {
                      setEquipForm({ ...equipForm, fonte_id: "", fonte_tipo: "" });
                    } else if (v.startsWith("equip:")) {
                      const id = v.slice(6);
                      const eq = cloud.equipments.find((x) => x.id === id);
                      const tipo: FonteTipo = eq?.type === "nivel" ? "reservatorio" : "poco";
                      setEquipForm({ ...equipForm, fonte_id: id, fonte_tipo: tipo });
                    } else if (v.startsWith("tipo:")) {
                      setEquipForm({ ...equipForm, fonte_id: "", fonte_tipo: v.slice(5) as EquipFormState["fonte_tipo"] });
                    }
                  }}
                >
                  <SelectTrigger className="bg-secondary border-border"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— Nenhuma —</SelectItem>
                    <SelectItem value="tipo:rio">Rio</SelectItem>
                    <SelectItem value="tipo:riacho">Riacho</SelectItem>
                    <SelectItem value="tipo:canal">Canal</SelectItem>
                    <SelectItem value="tipo:piscina">Piscina</SelectItem>
                    {cloud.equipments
                      .filter((e) => e.type === "poco" && e.id !== editingEquip?.id)
                      .map((e) => (
                        <SelectItem key={e.id} value={`equip:${e.id}`}>
                          Poço — {e.name}
                        </SelectItem>
                      ))}
                    {cloud.equipments
                      .filter((e) => e.type === "nivel" && e.id !== editingEquip?.id)
                      .map((e) => (
                        <SelectItem key={`niv-${e.id}`} value={`equip:${e.id}`}>
                          Nível — {e.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-muted-foreground">Destino (opcional)</Label>
                <Select
                  value={equipForm.alimenta_id || "__none__"}
                  onValueChange={(v) => setEquipForm({ ...equipForm, alimenta_id: v === "__none__" ? "" : v })}
                >
                  <SelectTrigger className="bg-secondary border-border"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— Nenhum —</SelectItem>
                    {cloud.equipments
                      .filter((e) => e.id !== editingEquip?.id && e.type === "nivel")
                      .map((e) => (
                        <SelectItem key={e.id} value={e.id}>Nível — {e.name}</SelectItem>
                      ))}
                    {cloud.equipments.filter((e) => e.id !== editingEquip?.id && e.type === "nivel").length === 0 && (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">Nenhum nível/reservatório cadastrado</div>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Roteamento RF — override por equipamento (opcional) */}
            {equipForm.type !== "nivel" && (
              <div className="border-t border-border pt-3 mt-1 space-y-3">
                <div>
                  <Label className="text-foreground text-sm font-semibold">Roteamento RF (avançado)</Label>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Sobrescreve o roteamento global da fazenda só para este equipamento.
                    Use quando uma bomba específica precisar de outro rádio ou passar por repetidor.
                    Deixe em <span className="font-semibold text-foreground">Padrão da fazenda</span> se não souber.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-muted-foreground">Rádio de transmissão</Label>
                    <Select
                      value={equipForm.rf_radio === "" ? "__default__" : equipForm.rf_radio}
                      onValueChange={(v) =>
                        setEquipForm({ ...equipForm, rf_radio: v === "__default__" ? "" : (v as "R1" | "R2" | "R3") })
                      }
                    >
                      <SelectTrigger className="bg-secondary border-border"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__default__">Padrão da fazenda</SelectItem>
                        <SelectItem value="R1">R1</SelectItem>
                        <SelectItem value="R2">R2</SelectItem>
                        <SelectItem value="R3">R3</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Via repetidor</Label>
                    <Select
                      value={equipForm.rf_via_rep}
                      onValueChange={(v) =>
                        setEquipForm({ ...equipForm, rf_via_rep: v as "default" | "on" | "off" })
                      }
                    >
                      <SelectTrigger className="bg-secondary border-border"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Padrão da fazenda</SelectItem>
                        <SelectItem value="off">Direto (sem repetidor)</SelectItem>
                        <SelectItem value="on">Via repetidor (REP:R3)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEquipDialogOpen(false)}>Cancelar</Button>
            <Button onClick={saveEquip} className="bg-primary text-primary-foreground">Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-foreground">Confirmar exclusão</DialogTitle>
            <DialogDescription>
              Esta ação removerá <strong>{deleteTarget?.name}</strong> permanentemente da nuvem. Não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancelar</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CFG remoto — Bomba (poço/bombeamento) */}
      {cfgTarget && farmId && cfgTsnn && cfgTarget.type !== "repetidor" && (
        <PumpCfgDialog
          open={!!cfgTarget}
          onOpenChange={(o) => { if (!o) setCfgTarget(null); }}
          farmId={farmId}
          tsnn={cfgTsnn}
          plcId={cfgPlc?.id ?? cfgTarget.plc_group_id ?? null}
          equipmentId={cfgTarget.id}
          equipmentName={cfgTarget.name}
        />
      )}
      {/* CFG remoto — Repetidor */}
      {cfgTarget && farmId && cfgTarget.type === "repetidor" && (
        <RepeaterCfgDialog
          open={!!cfgTarget}
          onOpenChange={(o) => { if (!o) setCfgTarget(null); }}
          farmId={farmId}
          equipmentId={cfgTarget.id}
          equipmentName={cfgTarget.name}
        />
      )}
    </div>
  );
};

// Página default — wrapper com guarda de auth
const CadastrosPage = () => (
  <RestrictedAuth title="Cadastros" description="Acesso restrito para administradores">
    <Cadastros />
  </RestrictedAuth>
);

export default CadastrosPage;
