// useAutomacoes — CRUD para automações independentes (Fase 1)
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { notifyWhatsAppImmediate } from "@/lib/whatsappNotify";

function fmtHM(t?: string | null): string {
  if (!t) return "—";
  const m = /^(\d{2}):(\d{2})/.exec(t);
  return m ? `${m[1]}:${m[2]}` : t;
}

function fmtNowBR(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}, ${hh}:${mi}h`;
}


export type AutomacaoType = "scheduled" | "rule_based" | "one_time";
export type AutomacaoAction = "liga" | "desliga";
export type TriggerType = "time" | "condition" | "delay";
export type ConditionType =
  | "peak_hours_start"
  | "peak_hours_end"
  | "level_below"
  | "level_above";

export type DayCode = "seg" | "ter" | "qua" | "qui" | "sex" | "sab" | "dom";

export interface AutomacaoTrigger {
  id: string;
  automation_id: string;
  trigger_type: TriggerType;
  time_value: string | null;
  days: DayCode[] | null;
  condition_type: ConditionType | null;
  condition_value: string | null;
  delay_minutes: number | null;
  execute_once: boolean;
  last_executed_at: string | null;
  scheduled_for: string | null;
}

export interface AutomacaoActionRow {
  id: string;
  automation_id: string;
  equipment_ids: string[];
  action: AutomacaoAction;
  order: number;
}

export interface Automacao {
  id: string;
  farm_id: string;
  name: string;
  type: AutomacaoType;
  is_active: boolean;
  created_by: string | null;
  created_via: "whatsapp" | "frontend";
  created_at: string;
  updated_at: string;
  triggers: AutomacaoTrigger[];
  actions: AutomacaoActionRow[];
  last_history?: {
    triggered_at: string;
    all_success: boolean;
    actions_executed: any[];
  } | null;
}

export interface NewAutomacaoInput {
  name: string;
  action: AutomacaoAction;
  equipment_ids: string[]; // [] => all
  trigger_type: TriggerType;
  // time
  time_value?: string;
  days?: DayCode[];
  // condition
  condition_type?: ConditionType;
  condition_value?: string;
  // delay / one_time
  delay_minutes?: number;
  scheduled_for?: string; // ISO
  execute_once?: boolean;
}

export function useAutomacoes(farmId: string | null) {
  const [items, setItems] = useState<Automacao[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!farmId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data: autos, error } = await supabase
        .from("automations")
        .select("*")
        .eq("farm_id", farmId)
        .order("created_at", { ascending: false });
      if (error) throw error;

      const ids = (autos ?? []).map((a) => a.id);
      const [triggersRes, actionsRes, histRes] = await Promise.all([
        ids.length
          ? supabase.from("automation_triggers").select("*").in("automation_id", ids)
          : Promise.resolve({ data: [], error: null } as any),
        ids.length
          ? supabase.from("automation_actions").select("*").in("automation_id", ids)
          : Promise.resolve({ data: [], error: null } as any),
        ids.length
          ? supabase
              .from("automation_execution_history")
              .select("automation_id, triggered_at, all_success, actions_executed")
              .in("automation_id", ids)
              .order("triggered_at", { ascending: false })
          : Promise.resolve({ data: [], error: null } as any),
      ]);

      const triggers = (triggersRes.data ?? []) as any[];
      const actions = (actionsRes.data ?? []) as any[];
      const hist = (histRes.data ?? []) as any[];
      const histByAuto = new Map<string, any>();
      for (const h of hist) {
        if (!histByAuto.has(h.automation_id)) histByAuto.set(h.automation_id, h);
      }

      const list: Automacao[] = (autos ?? []).map((a) => ({
        ...(a as any),
        triggers: triggers.filter((t) => t.automation_id === a.id) as AutomacaoTrigger[],
        actions: actions
          .filter((x) => x.automation_id === a.id)
          .map((x) => ({
            ...x,
            equipment_ids: Array.isArray(x.equipment_ids) ? x.equipment_ids : [],
          })) as AutomacaoActionRow[],
        last_history: histByAuto.get(a.id) ?? null,
      }));
      setItems(list);
    } catch (e: any) {
      console.error("[useAutomacoes] load", e);
      toast.error("Falha ao carregar automações");
    } finally {
      setLoading(false);
    }
  }, [farmId]);

  useEffect(() => {
    void load();
  }, [load]);

  const writeAudit = useCallback(
    async (row: {
      automation_id: string | null;
      event_type: "created" | "updated" | "deleted" | "activated" | "deactivated";
      equipment_ids: string[];
      action: AutomacaoAction | null;
      performed_by_name: string | null;
      performed_by_email: string | null;
      trigger_type: string | null;
      scheduled_time: string | null;
      notes?: string | null;
    }) => {
      if (!farmId) return;
      await supabase.from("automation_audit_log").insert({
        ...row,
        farm_id: farmId,
        performed_via: "frontend",
        result_details: [],
      });
    },
    [farmId],
  );

  const notifyScheduleChange = useCallback(
    async (message: string, actorName: string) => {
      if (!farmId) return;
      try {
        await notifyWhatsAppImmediate(
          "schedule_change",
          {
            farm_id: farmId,
            actor_name: actorName || "Usuário Web",
            via: "web",
            message,
          },
          { fireAndForget: true },
        );
      } catch (e) {
        console.warn("[useAutomacoes] notifyScheduleChange failed (retry enqueued server-side)", e);
      }
    },
    [farmId],
  );



  const create = useCallback(
    async (input: NewAutomacaoInput, createdBy: string | null) => {
      if (!farmId) return false;
      try {
        const type: AutomacaoType =
          input.trigger_type === "condition"
            ? "rule_based"
            : input.execute_once || input.scheduled_for || input.delay_minutes
            ? "one_time"
            : "scheduled";

        const { data: auto, error: e1 } = await supabase
          .from("automations")
          .insert({
            farm_id: farmId,
            name: input.name,
            type,
            is_active: true,
            created_by: createdBy,
            created_via: "frontend",
          })
          .select("*")
          .single();
        if (e1 || !auto) throw e1;

        const equipmentIds = input.equipment_ids.length ? input.equipment_ids : ["all"];

        const triggerRow: any = {
          automation_id: auto.id,
          trigger_type: input.trigger_type,
          time_value: input.time_value ?? null,
          days: input.days ?? null,
          condition_type: input.condition_type ?? null,
          condition_value: input.condition_value ?? null,
          delay_minutes: input.delay_minutes ?? null,
          execute_once: !!input.execute_once,
          scheduled_for: input.scheduled_for ?? null,
        };

        if (input.trigger_type === "delay" && input.delay_minutes && !input.scheduled_for) {
          triggerRow.scheduled_for = new Date(
            Date.now() + input.delay_minutes * 60_000,
          ).toISOString();
          triggerRow.execute_once = true;
        }

        const [{ error: e2 }, { error: e3 }] = await Promise.all([
          supabase.from("automation_triggers").insert(triggerRow),
          supabase.from("automation_actions").insert({
            automation_id: auto.id,
            equipment_ids: equipmentIds,
            action: input.action,
            order: 0,
          }),
        ]);
        if (e2 || e3) throw e2 || e3;

        const auditTriggerType =
          input.trigger_type === "time"
            ? "time_trigger"
            : input.trigger_type === "condition"
            ? "condition_trigger"
            : input.trigger_type === "delay"
            ? "delay"
            : "one_time";

        await writeAudit({
          automation_id: auto.id,
          event_type: "created",
          equipment_ids: equipmentIds,
          action: input.action,
          performed_by_name: createdBy,
          performed_by_email: createdBy,
          trigger_type: auditTriggerType,
          scheduled_time: input.time_value ?? null,
          notes: `Automação "${input.name}" criada via painel`,
        });

        // WhatsApp: notify schedule creation (never dedup)
        const actionLabel = input.action === "liga" ? "Liga" : "Desliga";
        const timeLabel = fmtHM(input.time_value);
        const msg =
          `📝 Programação criada — Fazenda [nome]\n` +
          `Por: ${createdBy ?? "Usuário Web"}\n` +
          `Via: Painel Web\n` +
          `Horário: ${fmtNowBR()}\n\n` +
          `Alterações:\n` +
          `* ${input.name} — ${actionLabel} ${timeLabel}`;
        void notifyScheduleChange(msg, createdBy ?? "Usuário Web");

        toast.success("Automação criada");
        await load();
        return true;
      } catch (e: any) {
        console.error("[useAutomacoes] create", e);
        toast.error(e?.message || "Falha ao criar automação");
        return false;
      }
    },
    [farmId, load, writeAudit, notifyScheduleChange],
  );

  const toggleActive = useCallback(
    async (id: string, active: boolean, actor: string | null) => {
      const target = items.find((a) => a.id === id);
      const { error } = await supabase
        .from("automations")
        .update({ is_active: active })
        .eq("id", id);
      if (error) {
        toast.error("Falha ao alterar status");
        return;
      }
      setItems((prev) => prev.map((a) => (a.id === id ? { ...a, is_active: active } : a)));
      await writeAudit({
        automation_id: id,
        event_type: active ? "activated" : "deactivated",
        equipment_ids: target?.actions[0]?.equipment_ids ?? [],
        action: target?.actions[0]?.action ?? null,
        performed_by_name: actor,
        performed_by_email: actor,
        trigger_type: null,
        scheduled_time: target?.triggers[0]?.time_value ?? null,
        notes: `${active ? "Ativada" : "Desativada"} via painel`,
      });

      const timeLabel = fmtHM(target?.triggers[0]?.time_value);
      const msg =
        `📝 Programação ${active ? "reativada" : "pausada"} — Fazenda [nome]\n` +
        `Por: ${actor ?? "Usuário Web"}\n` +
        `Via: Painel Web\n` +
        `Horário: ${fmtNowBR()}\n\n` +
        `Alterações:\n` +
        `* ${target?.name ?? id} — ${active ? "Reativada" : "Pausada"} (horário ${timeLabel})`;
      void notifyScheduleChange(msg, actor ?? "Usuário Web");
    },
    [items, writeAudit, notifyScheduleChange],
  );

  const remove = useCallback(
    async (id: string, actor: string | null) => {
      const target = items.find((a) => a.id === id);
      const { error } = await supabase.from("automations").delete().eq("id", id);
      if (error) {
        toast.error("Falha ao excluir automação");
        return;
      }
      toast.success("Automação excluída");
      setItems((prev) => prev.filter((a) => a.id !== id));
      await writeAudit({
        automation_id: null,
        event_type: "deleted",
        equipment_ids: target?.actions[0]?.equipment_ids ?? [],
        action: target?.actions[0]?.action ?? null,
        performed_by_name: actor,
        performed_by_email: actor,
        trigger_type: null,
        scheduled_time: target?.triggers[0]?.time_value ?? null,
        notes: `Automação "${target?.name ?? id}" excluída`,
      });

      const msg =
        `📝 Programação excluída — Fazenda [nome]\n` +
        `Por: ${actor ?? "Usuário Web"}\n` +
        `Via: Painel Web\n` +
        `Horário: ${fmtNowBR()}\n\n` +
        `Alterações:\n` +
        `* ${target?.name ?? id} — Removido do automático`;
      void notifyScheduleChange(msg, actor ?? "Usuário Web");
    },
    [items, writeAudit, notifyScheduleChange],
  );


  return { items, loading, reload: load, create, toggleActive, remove };
}
