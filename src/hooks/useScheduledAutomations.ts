import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Tabela ainda não está nos tipos gerados (types.ts) — usamos casts `as any`,
// no mesmo padrão de useUserFarms / EquipmentPowerConfig.
export type WeekdayCode = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type ShutdownAction = "shutdown_all" | "shutdown_specific";

export interface ScheduledAutomation {
  id: string;
  farm_id: string;
  name: string;
  action: ShutdownAction;
  time_brt: string; // "HH:MM"
  days_of_week: WeekdayCode[];
  excluded_equipment_ids: string[];
  target_equipment_ids: string[];
  retry_interval_min: number;
  max_retries: number;
  alert_after_retries: boolean;
  is_active: boolean;
  last_run_at: string | null;
  last_run_result: any;
  created_at: string;
  updated_at: string;
}

export interface ScheduledAutomationInput {
  name: string;
  action: ShutdownAction;
  time_brt: string;
  days_of_week: WeekdayCode[];
  excluded_equipment_ids: string[];
  target_equipment_ids: string[];
  retry_interval_min: number;
  max_retries: number;
  alert_after_retries: boolean;
}

const TABLE = "scheduled_automations";

function normalize(row: any): ScheduledAutomation {
  return {
    id: row.id,
    farm_id: row.farm_id,
    name: row.name ?? "",
    action: (row.action ?? "shutdown_all") as ShutdownAction,
    time_brt: row.time_brt ?? "17:00",
    days_of_week: (row.days_of_week ?? []) as WeekdayCode[],
    excluded_equipment_ids: (row.excluded_equipment_ids ?? []) as string[],
    target_equipment_ids: (row.target_equipment_ids ?? []) as string[],
    retry_interval_min: row.retry_interval_min ?? 5,
    max_retries: row.max_retries ?? 3,
    alert_after_retries: row.alert_after_retries !== false,
    is_active: row.is_active !== false,
    last_run_at: row.last_run_at ?? null,
    last_run_result: row.last_run_result ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function useScheduledAutomations(farmId: string | null) {
  const [items, setItems] = useState<ScheduledAutomation[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!farmId) { setItems([]); return; }
    setLoading(true);
    const { data, error } = await (supabase as any)
      .from(TABLE)
      .select("*")
      .eq("farm_id", farmId)
      .order("time_brt", { ascending: true });
    if (error) { toast.error("Falha ao carregar automações: " + error.message); setItems([]); }
    else setItems(((data ?? []) as any[]).map(normalize));
    setLoading(false);
  }, [farmId]);

  useEffect(() => { void reload(); }, [reload]);

  const create = useCallback(async (input: ScheduledAutomationInput): Promise<boolean> => {
    if (!farmId) return false;
    const { error } = await (supabase as any).from(TABLE).insert({ farm_id: farmId, ...input } as any);
    if (error) { toast.error("Erro ao criar: " + error.message); return false; }
    toast.success("Automação criada");
    await reload();
    return true;
  }, [farmId, reload]);

  const update = useCallback(async (id: string, patch: Partial<ScheduledAutomationInput>): Promise<boolean> => {
    const { error } = await (supabase as any)
      .from(TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() } as any)
      .eq("id", id);
    if (error) { toast.error("Erro ao salvar: " + error.message); return false; }
    toast.success("Automação atualizada");
    await reload();
    return true;
  }, [reload]);

  const toggleActive = useCallback(async (id: string, active: boolean): Promise<boolean> => {
    const { error } = await (supabase as any)
      .from(TABLE)
      .update({ is_active: active, updated_at: new Date().toISOString() } as any)
      .eq("id", id);
    if (error) { toast.error("Erro: " + error.message); return false; }
    toast.success(active ? "Automação ativada" : "Automação desativada");
    await reload();
    return true;
  }, [reload]);

  const remove = useCallback(async (id: string): Promise<boolean> => {
    const { error } = await (supabase as any).from(TABLE).delete().eq("id", id);
    if (error) { toast.error("Erro ao excluir: " + error.message); return false; }
    toast.success("Automação excluída");
    await reload();
    return true;
  }, [reload]);

  return { items, loading, reload, create, update, toggleActive, remove };
}
