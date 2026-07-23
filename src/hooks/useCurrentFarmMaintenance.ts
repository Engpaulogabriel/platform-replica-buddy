// useCurrentFarmMaintenance — auto-resolve do farm_id via profile do usuário logado
// e delega ao useFarmMaintenance. Usado nos componentes do dashboard para gating.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useFarmMaintenance, type FarmMaintenanceState } from "./useFarmMaintenance";

export function useCurrentFarmMaintenance(): FarmMaintenanceState {
  const { user } = useAuth();
  const [farmId, setFarmId] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) { setFarmId(null); return; }
    let cancelled = false;
    void supabase.from("profiles").select("default_farm_id").eq("id", user.id).maybeSingle()
      .then(({ data }) => { if (!cancelled) setFarmId(data?.default_farm_id ?? null); });
    return () => { cancelled = true; };
  }, [user?.id]);

  return useFarmMaintenance(farmId);
}
