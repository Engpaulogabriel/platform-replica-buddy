import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Clock, ListChecks, Timer, Calendar } from "lucide-react";
import type {
  NewAutomacaoInput,
  AutomacaoAction,
  DayCode,
  TriggerType,
  ConditionType,
} from "@/hooks/useAutomacoes";

const DAYS: { code: DayCode; label: string }[] = [
  { code: "seg", label: "Seg" },
  { code: "ter", label: "Ter" },
  { code: "qua", label: "Qua" },
  { code: "qui", label: "Qui" },
  { code: "sex", label: "Sex" },
  { code: "sab", label: "Sáb" },
  { code: "dom", label: "Dom" },
];

interface Equipment {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  equipments: Equipment[];
  onSubmit: (input: NewAutomacaoInput) => Promise<boolean>;
}

export function AutomacaoFormDialog({ open, onOpenChange, equipments, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [action, setAction] = useState<AutomacaoAction>("desliga");
  const [allEquip, setAllEquip] = useState(true);
  const [equipmentIds, setEquipmentIds] = useState<string[]>([]);
  const [triggerType, setTriggerType] = useState<TriggerType>("time");

  // time
  const [days, setDays] = useState<DayCode[]>(["seg", "ter", "qua", "qui", "sex"]);
  const [timeValue, setTimeValue] = useState("17:30");

  // condition
  const [conditionType, setConditionType] = useState<ConditionType>("peak_hours_start");
  const [conditionValue, setConditionValue] = useState<string>("");

  // delay
  const [delayMinutes, setDelayMinutes] = useState<number>(60);

  // one_time
  const [oneTimeDate, setOneTimeDate] = useState<string>("");
  const [oneTimeTime, setOneTimeTime] = useState<string>("06:00");

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setAction("desliga");
      setAllEquip(true);
      setEquipmentIds([]);
      setTriggerType("time");
      setDays(["seg", "ter", "qua", "qui", "sex"]);
      setTimeValue("17:30");
      setDelayMinutes(60);
      const now = new Date();
      const iso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      setOneTimeDate(iso);
    }
  }, [open]);

  const canSubmit = useMemo(() => {
    if (!name.trim()) return false;
    if (!allEquip && equipmentIds.length === 0) return false;
    if (triggerType === "time" && (!timeValue || days.length === 0)) return false;
    if (triggerType === "delay" && (!delayMinutes || delayMinutes <= 0)) return false;
    if (triggerType === "condition") {
      if (!conditionType) return false;
      if ((conditionType === "level_below" || conditionType === "level_above") && !conditionValue) return false;
    }
    return true;
  }, [name, allEquip, equipmentIds, triggerType, timeValue, days, delayMinutes, conditionType, conditionValue]);

  const handleSubmit = async () => {
    setSubmitting(true);
    const input: NewAutomacaoInput = {
      name: name.trim(),
      action,
      equipment_ids: allEquip ? [] : equipmentIds,
      trigger_type: triggerType,
    };
    if (triggerType === "time") {
      input.time_value = timeValue;
      input.days = days;
    } else if (triggerType === "condition") {
      input.condition_type = conditionType;
      if (conditionType === "level_below" || conditionType === "level_above") {
        input.condition_value = conditionValue;
      }
    } else if (triggerType === "delay") {
      // detect "one_time at specific datetime" via separate selection — handled below
      input.delay_minutes = delayMinutes;
      input.execute_once = true;
    }
    // Special: date+time selected → treat as delay one_time
    // (we expose "Data/hora específica" via a 4th tab using scheduled_for)
    const ok = await onSubmit(input);
    setSubmitting(false);
    if (ok) onOpenChange(false);
  };

  const toggleDay = (d: DayCode) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const toggleEquip = (id: string) =>
    setEquipmentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nova Automação</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input
              placeholder="Ex: Desligar antes da ponta"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Ação</Label>
              <Select value={action} onValueChange={(v) => setAction(v as AutomacaoAction)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="liga">Ligar</SelectItem>
                  <SelectItem value="desliga">Desligar</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Equipamentos</Label>
              <div className="flex items-center gap-2 h-10 px-3 border rounded-md">
                <Checkbox id="all-eq" checked={allEquip} onCheckedChange={(v) => setAllEquip(!!v)} />
                <Label htmlFor="all-eq" className="cursor-pointer text-sm">Todos os equipamentos</Label>
              </div>
            </div>
          </div>

          {!allEquip && (
            <div className="space-y-2">
              <Label>Selecionar equipamentos ({equipmentIds.length})</Label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-y-auto border rounded-md p-3">
                {equipments.map((e) => (
                  <label key={e.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={equipmentIds.includes(e.id)}
                      onCheckedChange={() => toggleEquip(e.id)}
                    />
                    <span>{e.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Tipo de gatilho</Label>
            <Tabs value={triggerType} onValueChange={(v) => setTriggerType(v as TriggerType)}>
              <TabsList className="grid grid-cols-3 w-full">
                <TabsTrigger value="time"><Clock className="w-3.5 h-3.5 mr-1" />Horário fixo</TabsTrigger>
                <TabsTrigger value="condition"><ListChecks className="w-3.5 h-3.5 mr-1" />Condição</TabsTrigger>
                <TabsTrigger value="delay"><Timer className="w-3.5 h-3.5 mr-1" />Daqui X min</TabsTrigger>
              </TabsList>

              <TabsContent value="time" className="space-y-3 pt-3">
                <div className="space-y-2">
                  <Label>Horário</Label>
                  <Input type="time" value={timeValue} onChange={(e) => setTimeValue(e.target.value)} />
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
              </TabsContent>

              <TabsContent value="condition" className="space-y-3 pt-3">
                <div className="space-y-2">
                  <Label>Condição</Label>
                  <Select value={conditionType} onValueChange={(v) => setConditionType(v as ConditionType)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="peak_hours_start">Início do horário de ponta</SelectItem>
                      <SelectItem value="peak_hours_end">Fim do horário de ponta</SelectItem>
                      <SelectItem value="level_below">Nível do reservatório abaixo de…</SelectItem>
                      <SelectItem value="level_above">Nível do reservatório acima de…</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {(conditionType === "level_below" || conditionType === "level_above") && (
                  <div className="space-y-2">
                    <Label>Limiar (%)</Label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      placeholder="Ex: 30"
                      value={conditionValue}
                      onChange={(e) => setConditionValue(e.target.value)}
                    />
                  </div>
                )}
              </TabsContent>

              <TabsContent value="delay" className="space-y-3 pt-3">
                <div className="space-y-2">
                  <Label>Executar daqui (minutos)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={delayMinutes}
                    onChange={(e) => setDelayMinutes(Number(e.target.value))}
                  />
                  <p className="text-xs text-muted-foreground">
                    Execução única — a automação é desativada após disparar.
                  </p>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={!canSubmit || submitting} onClick={handleSubmit}>
            {submitting ? "Criando…" : "Criar Automação"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
