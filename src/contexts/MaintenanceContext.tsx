// Ordens de manutenção ABERTAS por equipamento — alimenta o badge automático no
// dashboard (poço/bomba/reservatório). Um único provider por página carrega as
// ordens da fazenda ativa (com Realtime + refresh 60s); os cards consomem via
// useOpenMaintenance() sem acoplar ao hook pesado de equipamentos.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { MaintenanceOrder } from "@/lib/maintenanceTypes";

export type OpenMaintenance = Pick<MaintenanceOrder, "id" | "problem_type" | "description" | "priority" | "status">;

interface MaintenanceCtx {
  getForEquipment: (equipmentId: string | null | undefined) => OpenMaintenance | undefined;
}

const Ctx = createContext<MaintenanceCtx>({ getForEquipment: () => undefined });

export function OpenMaintenanceProvider({ farmId, children }: { farmId: string | null; children: ReactNode }) {
  const [map, setMap] = useState<Map<string, OpenMaintenance>>(new Map());

  useEffect(() => {
    if (!farmId) { setMap(new Map()); return; }
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("maintenance_orders")
        .select("id, equipment_id, problem_type, description, priority, status")
        .eq("farm_id", farmId)
        .neq("status", "concluido");
      if (cancelled) return;
      const m = new Map<string, OpenMaintenance>();
      for (const o of (data ?? []) as any[]) {
        if (!o.equipment_id) continue;
        // Se houver várias ordens abertas, a de maior prioridade vence no badge.
        const prev = m.get(o.equipment_id);
        const rank = (p: string) => (p === "alta" ? 3 : p === "media" ? 2 : 1);
        if (!prev || rank(o.priority) > rank(prev.priority)) {
          m.set(o.equipment_id, { id: o.id, problem_type: o.problem_type, description: o.description, priority: o.priority, status: o.status });
        }
      }
      setMap(m);
    };
    void load();
    const id = window.setInterval(load, 60_000);
    const ch = supabase
      .channel(`maint-${farmId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "maintenance_orders", filter: `farm_id=eq.${farmId}` }, () => void load())
      .subscribe();
    return () => { cancelled = true; window.clearInterval(id); void supabase.removeChannel(ch); };
  }, [farmId]);

  const value = useMemo<MaintenanceCtx>(() => ({
    getForEquipment: (equipmentId) => (equipmentId ? map.get(equipmentId) : undefined),
  }), [map]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOpenMaintenance(): MaintenanceCtx {
  return useContext(Ctx);
}
