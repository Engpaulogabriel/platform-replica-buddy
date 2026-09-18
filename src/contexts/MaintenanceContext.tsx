// MaintenanceContext — ordens de manutenção ABERTAS da fazenda ativa.
// Usado para exibir badge automático nos cards/tabela de bombas.
// Funciona com ou sem Provider: o hook faz o fetch por conta própria quando
// não há contexto montado (polling 60s).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getSupabaseForFarm } from "@/lib/supabaseRouter";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";

export interface OpenMaintenanceOrder {
  id: string;
  equipment_id: string | null;
  equipment_name: string | null;
  problem_type: string;
  priority: string;
  description: string | null;
  status: string;
  created_at: string;
}

interface MaintenanceCtx {
  orders: OpenMaintenanceOrder[];
  getForEquipment: (equipmentId: string) => OpenMaintenanceOrder | undefined;
  reload: () => Promise<void>;
}

const Ctx = createContext<MaintenanceCtx | null>(null);

function useOpenMaintenanceData(): MaintenanceCtx {
  const farmId = useDefaultFarmId();
  const [orders, setOrders] = useState<OpenMaintenanceOrder[]>([]);

  const reload = useCallback(async () => {
    if (!farmId) {
      setOrders([]);
      return;
    }
    const { data } = await getSupabaseForFarm(farmId)
      .from("maintenance_orders")
      .select("id,equipment_id,equipment_name,problem_type,priority,description,status,created_at")
      .eq("farm_id", farmId)
      .neq("status", "concluida")
      .order("created_at", { ascending: false });
    setOrders(((data ?? []) as unknown) as OpenMaintenanceOrder[]);
  }, [farmId]);

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), 60_000);
    return () => clearInterval(id);
  }, [reload]);

  const byEquipment = useMemo(() => {
    const m = new Map<string, OpenMaintenanceOrder>();
    for (const o of orders) {
      if (o.equipment_id && !m.has(o.equipment_id)) m.set(o.equipment_id, o);
    }
    return m;
  }, [orders]);

  const getForEquipment = useCallback(
    (equipmentId: string) => byEquipment.get(equipmentId),
    [byEquipment],
  );

  return { orders, getForEquipment, reload };
}

export function MaintenanceProvider({ children }: { children: ReactNode }) {
  const value = useOpenMaintenanceData();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOpenMaintenance(): MaintenanceCtx {
  const ctx = useContext(Ctx);
  const fallback = useOpenMaintenanceData();
  return ctx ?? fallback;
}
