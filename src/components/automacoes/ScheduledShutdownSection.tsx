import { useEffect, useMemo, useState } from "react";
import { Power, Plus, Lock, Clock, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  useScheduledAutomations,
  type ScheduledAutomation,
  type ScheduledAutomationInput,
  type ShutdownAction,
  type WeekdayCode,
} from "@/hooks/useScheduledAutomations";

interface EquipmentLite { id: string; name: string; }

interface Props {
  farmId: string | null;
  equipments: EquipmentLite[];
  canEdit: boolean;
}

const DAYS: { code: WeekdayCode; label: string }[] = [
  { code: "mon", label: "Seg" },
  { code: "tue", label: "Ter" },
  { code: "wed", label: "Qua" },
  { code: "thu", label: "Qui" },
  { code: "fri", label: "Sex" },
  { code: "sat", label: "Sáb" },
  { code: "sun", label: "Dom" },
];
const dayLabel = (c: WeekdayCode) => DAYS.find((d) => d.code === c)?.label ?? c;

export function ScheduledShutdownSection({ farmId, equipments, canEdit }: Props) {
  const { items, loading, create, update, toggleActive, remove } = useScheduledAutomations(farmId);
  const [openForm, setOpenForm] = useState(false);
  const [editing, setEditing] = useState<ScheduledAutomation | null>(null);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    equipments.forEach((e) => m.set(e.id, e.name));
    return m;
  }, [equipments]);

  const openNew = () => { setEditing(null); setOpenForm(true); };
  const openEdit = (a: ScheduledAutomation) => { setEditing(a); setOpenForm(true); };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
          <Power className="w-4 h-4" /> Desligamento Programado
        </h2>
        {canEdit ? (
          <Button size="sm" variant="outline" onClick={openNew}>
            <Plus className="w-4 h-4 mr-1" /> Nova regra
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" /> Somente leitura
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground max-w-2xl">
        Desliga as bombas em um horário fixo, independente do modo (Auto/Manual). Tenta várias
        vezes; bombas ligadas via painel local são desligadas de forma forçada. Se alguma resistir,
        envia alerta consolidado no WhatsApp.
      </p>

      {loading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : items.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          Nenhuma regra de desligamento programado. Clique em "Nova regra" para criar.
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((a) => (
            <RuleCard
              key={a.id}
              rule={a}
              nameById={nameById}
              canEdit={canEdit}
              onToggle={(v) => toggleActive(a.id, v)}
              onEdit={() => openEdit(a)}
              onDelete={() => { if (confirm(`Excluir "${a.name}"?`)) void remove(a.id); }}
            />
          ))}
        </div>
      )}

      <RuleFormDialog
        open={openForm}
        onOpenChange={setOpenForm}
        equipments={equipments}
        editing={editing}
        onSubmit={async (input) => {
          const ok = editing ? await update(editing.id, input) : await create(input);
          if (ok) setOpenForm(false);
          return ok;
        }}
      />
    </section>
  );
}

function RuleCard({
  rule, nameById, canEdit, onToggle, onEdit, onDelete,
}: {
  rule: ScheduledAutomation;
  nameById: Map<string, string>;
  canEdit: boolean;
  onToggle: (v: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const days = rule.days_of_week.length === 7
    ? "Todos os dias"
    : (["mon","tue","wed","thu","fri"] as WeekdayCode[]).every((d) => rule.days_of_week.includes(d)) && rule.days_of_week.length === 5
      ? "Seg a Sex"
      : rule.days_of_week.map(dayLabel).join(", ");
  const scope = rule.action === "shutdown_specific"
    ? `Apenas: ${rule.target_equipment_ids.map((id) => nameById.get(id) ?? "?").join(", ") || "—"}`
    : rule.excluded_equipment_ids.length > 0
      ? `Todas exceto: ${rule.excluded_equipment_ids.map((id) => nameById.get(id) ?? "?").join(", ")}`
      : "Todas as bombas";
  const last = rule.last_run_result;

  return (
    <Card className={`p-4 space-y-2 ${rule.is_active ? "" : "opacity-70"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold truncate">{rule.name}</p>
          <p className="text-lg font-bold text-primary flex items-center gap-1.5">
            <Clock className="w-4 h-4" /> {rule.time_brt}
            <span className="text-xs font-normal text-muted-foreground">BRT</span>
          </p>
        </div>
        <Switch checked={rule.is_active} onCheckedChange={onToggle} disabled={!canEdit} />
      </div>

      <div className="text-xs text-muted-foreground space-y-1">
        <p>{days}</p>
        <p>{scope}</p>
        <p>
          {rule.max_retries} tentativa{rule.max_retries === 1 ? "" : "s"} · a cada {rule.retry_interval_min} min ·{" "}
          {rule.alert_after_retries ? "alerta WhatsApp se resistir" : "sem alerta"}
        </p>
      </div>

      {last && (
        <p className="text-[11px] text-muted-foreground">
          Última execução:{" "}
          {rule.last_run_at ? new Date(rule.last_run_at).toLocaleString("pt-BR") : "—"}
          {typeof last.on === "number" && ` · ${last.on} ligada(s)`}
        </p>
      )}

      {canEdit && (
        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onEdit}>Editar</Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive hover:text-destructive" onClick={onDelete}>Excluir</Button>
        </div>
      )}
    </Card>
  );
}

function RuleFormDialog({
  open, onOpenChange, equipments, editing, onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  equipments: EquipmentLite[];
  editing: ScheduledAutomation | null;
  onSubmit: (input: ScheduledAutomationInput) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [action, setAction] = useState<ShutdownAction>("shutdown_all");
  const [timeBrt, setTimeBrt] = useState("17:00");
  const [days, setDays] = useState<WeekdayCode[]>(["mon", "tue", "wed", "thu", "fri"]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [interval, setInterval] = useState(5);
  const [maxRetries, setMaxRetries] = useState(3);
  const [alertAfter, setAlertAfter] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setAction(editing.action);
      setTimeBrt(editing.time_brt);
      setDays(editing.days_of_week.length ? editing.days_of_week : ["mon", "tue", "wed", "thu", "fri"]);
      setExcluded(editing.excluded_equipment_ids);
      setTargets(editing.target_equipment_ids);
      setInterval(editing.retry_interval_min);
      setMaxRetries(editing.max_retries);
      setAlertAfter(editing.alert_after_retries);
    } else {
      setName(""); setAction("shutdown_all"); setTimeBrt("17:00");
      setDays(["mon", "tue", "wed", "thu", "fri"]);
      setExcluded([]); setTargets([]); setInterval(5); setMaxRetries(3); setAlertAfter(true);
    }
  }, [open, editing]);

  const canSubmit = useMemo(() => {
    if (!name.trim() || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(timeBrt) || days.length === 0) return false;
    if (action === "shutdown_specific" && targets.length === 0) return false;
    return true;
  }, [name, timeBrt, days, action, targets]);

  const toggleDay = (d: WeekdayCode) =>
    setDays((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d]));
  const toggleId = (id: string, list: string[], set: (v: string[]) => void) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const handleSubmit = async () => {
    setSubmitting(true);
    const ok = await onSubmit({
      name: name.trim(),
      action,
      time_brt: timeBrt,
      days_of_week: days,
      excluded_equipment_ids: action === "shutdown_all" ? excluded : [],
      target_equipment_ids: action === "shutdown_specific" ? targets : [],
      retry_interval_min: interval,
      max_retries: maxRetries,
      alert_after_retries: alertAfter,
    });
    setSubmitting(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar regra" : "Nova regra de desligamento"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input placeholder="Ex: Desligamento 17h Semear" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Horário (BRT)</Label>
              <Input type="time" value={timeBrt} onChange={(e) => setTimeBrt(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Bombas</Label>
              <Select value={action} onValueChange={(v) => setAction(v as ShutdownAction)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="shutdown_all">Desligar todas</SelectItem>
                  <SelectItem value="shutdown_specific">Apenas selecionadas</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Dias da semana</Label>
            <div className="flex flex-wrap gap-2">
              {DAYS.map((d) => (
                <button
                  key={d.code}
                  type="button"
                  onClick={() => toggleDay(d.code)}
                  className={`px-3 py-1.5 text-xs rounded-md border transition ${
                    days.includes(d.code)
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-foreground border-border hover:bg-muted"
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          {action === "shutdown_all" ? (
            <div className="space-y-2">
              <Label>Não desligar estas bombas (exceções) — {excluded.length}</Label>
              <EquipPicker equipments={equipments} selected={excluded} onToggle={(id) => toggleId(id, excluded, setExcluded)} />
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Desligar apenas estas bombas — {targets.length}</Label>
              <EquipPicker equipments={equipments} selected={targets} onToggle={(id) => toggleId(id, targets, setTargets)} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Tentativas</Label>
              <Input type="number" min={1} max={10} value={maxRetries} onChange={(e) => setMaxRetries(Number(e.target.value))} />
            </div>
            <div className="space-y-2">
              <Label>Intervalo (min)</Label>
              <Input type="number" min={1} max={60} value={interval} onChange={(e) => setInterval(Number(e.target.value))} />
            </div>
          </div>

          <div className="flex items-center gap-2 h-10 px-3 border rounded-md">
            <Checkbox id="alert-after" checked={alertAfter} onCheckedChange={(v) => setAlertAfter(!!v)} />
            <Label htmlFor="alert-after" className="cursor-pointer text-sm flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
              Alertar no WhatsApp se alguma bomba resistir
            </Label>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Cronograma: às {timeBrt} a 1ª tentativa; depois +{interval} min por tentativa (total {maxRetries}).
            Verificação final {interval} min após a última — alerta só se ainda houver bomba ligada.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={!canSubmit || submitting} onClick={handleSubmit}>
            {submitting ? "Salvando…" : editing ? "Salvar" : "Criar regra"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EquipPicker({
  equipments, selected, onToggle,
}: {
  equipments: EquipmentLite[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  if (equipments.length === 0) {
    return <p className="text-xs text-muted-foreground">Nenhum equipamento nesta fazenda.</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto border rounded-md p-3">
      {equipments.map((e) => (
        <label key={e.id} className="flex items-center gap-2 text-sm cursor-pointer">
          <Checkbox checked={selected.includes(e.id)} onCheckedChange={() => onToggle(e.id)} />
          <span className="truncate">{e.name}</span>
        </label>
      ))}
    </div>
  );
}
