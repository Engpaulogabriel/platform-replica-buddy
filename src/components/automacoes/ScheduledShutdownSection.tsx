// ScheduledShutdownSection — automações programadas (tabela scheduled_automations).
// Lista as regras da fazenda com Nome/Horário/Dias/Equipamentos/Status e permite
// ativar/desativar quando o usuário tem permissão de edição.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, Power, CalendarDays } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface EquipmentLite {
  id: string;
  name: string;
}

interface ScheduledAutomation {
  id: string;
  name: string;
  action: string;
  time_brt: string;
  days_of_week: string[];
  target_equipment_ids: string[];
  excluded_equipment_ids: string[];
  is_active: boolean;
  last_run_at: string | null;
}

const DAY_LABELS: Record<string, string> = {
  mon: "Seg", tue: "Ter", wed: "Qua", thu: "Qui", fri: "Sex", sat: "Sáb", sun: "Dom",
  seg: "Seg", ter: "Ter", qua: "Qua", qui: "Qui", sex: "Sex", sab: "Sáb", dom: "Dom",
  "1": "Seg", "2": "Ter", "3": "Qua", "4": "Qui", "5": "Sex", "6": "Sáb", "0": "Dom",
};

const dayLabel = (d: string) => DAY_LABELS[String(d).toLowerCase()] ?? d;

interface Props {
  farmId: string | null | undefined;
  equipments: EquipmentLite[];
  canEdit: boolean;
}

export function ScheduledShutdownSection({ farmId, equipments, canEdit }: Props) {
  const [rows, setRows] = useState<ScheduledAutomation[]>([]);
  const [loading, setLoading] = useState(false);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    equipments.forEach((e) => m.set(e.id, e.name));
    return m;
  }, [equipments]);

  const reload = useCallback(async () => {
    if (!farmId) {
      setRows([]);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from("scheduled_automations")
      .select("id,name,action,time_brt,days_of_week,target_equipment_ids,excluded_equipment_ids,is_active,last_run_at")
      .eq("farm_id", farmId)
      .order("time_brt");
    setRows(((data ?? []) as unknown) as ScheduledAutomation[]);
    setLoading(false);
  }, [farmId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = async (row: ScheduledAutomation) => {
    if (!canEdit) return;
    const { error } = await supabase
      .from("scheduled_automations")
      .update({ is_active: !row.is_active })
      .eq("id", row.id);
    if (error) {
      toast.error("Não foi possível alterar a automação");
      return;
    }
    toast.success(row.is_active ? "Automação desativada" : "Automação ativada");
    void reload();
  };

  if (!loading && rows.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        Automações Programadas ({rows.length})
      </h2>
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((row) => {
          const targets = row.target_equipment_ids?.length
            ? row.target_equipment_ids.map((id) => nameById.get(id) ?? id)
            : ["Todos os equipamentos"];
          const excluded = (row.excluded_equipment_ids ?? []).map((id) => nameById.get(id) ?? id);
          return (
            <Card key={row.id} className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold truncate">{row.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.action === "turn_off" || row.action === "off" ? "Desligar" : row.action}
                  </p>
                </div>
                <span
                  className={`text-[11px] px-2 py-0.5 rounded-full border ${
                    row.is_active
                      ? "border-primary/40 text-primary"
                      : "border-muted-foreground/30 text-muted-foreground"
                  }`}
                >
                  {row.is_active ? "Ativa" : "Inativa"}
                </span>
              </div>

              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" /> {row.time_brt?.slice(0, 5)} (BRT)
                </span>
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="w-3.5 h-3.5" />
                  {(row.days_of_week ?? []).map(dayLabel).join(", ") || "Todos os dias"}
                </span>
              </div>

              <div className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Equipamentos: </span>
                {targets.join(", ")}
                {excluded.length > 0 && (
                  <>
                    <br />
                    <span className="font-medium text-foreground">Excluídos: </span>
                    {excluded.join(", ")}
                  </>
                )}
              </div>

              {row.last_run_at && (
                <p className="text-[11px] text-muted-foreground">
                  Última execução: {new Date(row.last_run_at).toLocaleString("pt-BR")}
                </p>
              )}

              {canEdit && (
                <Button variant="outline" size="sm" onClick={() => void toggle(row)}>
                  <Power className="w-3.5 h-3.5 mr-1.5" />
                  {row.is_active ? "Desativar" : "Ativar"}
                </Button>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}

export default ScheduledShutdownSection;
