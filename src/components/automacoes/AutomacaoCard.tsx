import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Trash2, Zap, Target, Clock, User } from "lucide-react";
import type { Automacao } from "@/hooks/useAutomacoes";

const DAY_LABEL: Record<string, string> = {
  seg: "Seg", ter: "Ter", qua: "Qua", qui: "Qui", sex: "Sex", sab: "Sáb", dom: "Dom",
};

const CONDITION_LABEL: Record<string, string> = {
  peak_hours_start: "Início do horário de ponta",
  peak_hours_end: "Fim do horário de ponta",
  level_below: "Nível abaixo de",
  level_above: "Nível acima de",
};

interface Props {
  automacao: Automacao;
  equipmentNameById: Map<string, string>;
  onToggle: (id: string, active: boolean) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}


export function AutomacaoCard({ automacao, equipmentNameById, onToggle, onDelete }: Props) {
  const trigger = automacao.triggers[0];
  const action = automacao.actions[0];

  const equipText = (() => {
    if (!action) return "—";
    const ids = action.equipment_ids;
    if (!ids?.length || ids.includes("all")) return "TODAS as bombas";
    const names = ids.map((id) => equipmentNameById.get(id) || id).slice(0, 6);
    return names.join(", ") + (ids.length > 6 ? ` +${ids.length - 6}` : "");
  })();

  const actionLabel = action?.action === "liga" ? "Ligar" : "Desligar";

  const triggerText = (() => {
    if (!trigger) return "—";
    if (trigger.trigger_type === "time") {
      const daysStr = trigger.days?.length
        ? trigger.days.length === 7
          ? "Todos os dias"
          : trigger.days.map((d) => DAY_LABEL[d] || d).join(", ")
        : "—";
      return `${daysStr} às ${trigger.time_value?.slice(0, 5) ?? ""}`;
    }
    if (trigger.trigger_type === "delay") {
      if (trigger.scheduled_for) {
        const d = new Date(trigger.scheduled_for);
        return `Agendado para ${d.toLocaleString("pt-BR")}`;
      }
      return `Daqui ${trigger.delay_minutes ?? "?"} min (única)`;
    }
    if (trigger.trigger_type === "condition") {
      const base = CONDITION_LABEL[trigger.condition_type ?? ""] ?? trigger.condition_type;
      return trigger.condition_value ? `${base} ${trigger.condition_value}%` : base;
    }
    return "—";
  })();

  const lastExec = automacao.last_history;
  const lastExecText = lastExec
    ? `${new Date(lastExec.triggered_at).toLocaleString("pt-BR")} ${lastExec.all_success ? "✅" : "⚠️"}`
    : "Aguardando execução…";

  const oneTimeBadge = automacao.type === "one_time" || trigger?.execute_once;

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Zap className="w-5 h-5 text-primary shrink-0" />
          <div className="min-w-0">
            <h3 className="font-semibold truncate">{automacao.name}</h3>
            <div className="flex gap-1.5 mt-1">
              {oneTimeBadge && <Badge variant="outline" className="text-[10px]">ÚNICA</Badge>}
              <Badge variant="secondary" className="text-[10px]">
                {automacao.type === "rule_based" ? "CONDIÇÃO" : automacao.type === "one_time" ? "PONTUAL" : "RECORRENTE"}
              </Badge>
            </div>
          </div>
        </div>
        <Switch
          checked={automacao.is_active}
          onCheckedChange={(v) => onToggle(automacao.id, v)}
        />
      </div>

      <div className="text-sm space-y-1.5 text-muted-foreground">
        <div className="flex items-start gap-2">
          <Target className="w-4 h-4 mt-0.5 shrink-0" />
          <span><strong className="text-foreground">{actionLabel}</strong> {equipText}</span>
        </div>
        <div className="flex items-start gap-2">
          <Clock className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{triggerText}</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-base leading-none">📊</span>
          <span>Última execução: {lastExecText}</span>
        </div>
        <div className="flex items-start gap-2">
          <User className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Criado por: {automacao.created_by ?? "—"} ({automacao.created_via === "whatsapp" ? "WhatsApp" : "Painel"})
          </span>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => {
            if (confirm(`Excluir automação "${automacao.name}"?`)) onDelete(automacao.id);
          }}
        >
          <Trash2 className="w-4 h-4 mr-1" /> Excluir
        </Button>
      </div>
    </Card>
  );
}
