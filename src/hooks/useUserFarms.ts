// useUserFarms — lista as fazendas do usuário e permite trocar a fazenda ativa
// (profiles.default_farm_id). Atualiza o estado e dispara reload das telas
// que dependem de useDefaultFarmId / useCadastrosCloud via window event.
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface UserFarm {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  role: string;
}

export function useUserFarms() {
  const { user } = useAuth();
  const [farms, setFarms] = useState<UserFarm[]>([]);
  const [activeFarmId, setActiveFarmId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const [{ data: profile }, { data: roles }, { data: pa }, { data: mm }] = await Promise.all([
        supabase.from("profiles").select("default_farm_id").eq("id", user.id).maybeSingle(),
        supabase
          .from("user_roles")
          .select("role, farm_id, farms(id, name, city, state)")
          .eq("user_id", user.id),
        supabase.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle(),
        supabase
          .from("master_managers" as any)
          .select("id")
          .eq("user_id", user.id)
          .eq("status", "active")
          .maybeSingle(),
      ]);
      const fallbackActiveFarmId = sessionStorage.getItem("impersonate_farm_id")
        ?? sessionStorage.getItem("demo_farm_id")
        ?? profile?.default_farm_id
        ?? localStorage.getItem(`last_farm:${user.id}`)
        ?? null;
      setActiveFarmId(fallbackActiveFarmId);
      const list: UserFarm[] = [];
      const seen = new Set<string>();

      // Se é Gestor Master ativo: fazendas vêm exclusivamente de master_manager_farms
      if (mm && (mm as any).id) {
        const { data: mmFarms } = await supabase
          .from("master_manager_farms" as any)
          .select("farm_id, farms(id, name, city, state)")
          .eq("manager_id", (mm as any).id);
        for (const link of (mmFarms ?? []) as any[]) {
          const f = link.farms;
          if (f && !seen.has(f.id)) {
            list.push({ ...f, role: "gestor_master" });
            seen.add(f.id);
          }
        }
      } else {
        for (const r of roles ?? []) {
          if (r.farms && !seen.has((r.farms as any).id)) {
            list.push({ ...(r.farms as any), role: r.role as string });
            seen.add((r.farms as any).id);
          }
        }
        // Platform admins enxergam TODAS as fazendas (mesmo sem entry em user_roles)
        if (pa) {
          const { data: allFarms } = await supabase
            .from("farms")
            .select("id, name, city, state")
            .order("name", { ascending: true });
          for (const f of allFarms ?? []) {
            if (!seen.has(f.id)) {
              list.push({ ...f, role: "platform_admin" });
              seen.add(f.id);
            }
          }
        }
      }
      setFarms(list);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);


  useEffect(() => { void load(); }, [load]);

  const setActiveFarm = useCallback(async (farmId: string) => {
    if (!user?.id || farmId === activeFarmId) return false;
    const { error } = await supabase
      .from("profiles").update({ default_farm_id: farmId }).eq("id", user.id);
    if (error) return false;
    localStorage.setItem(`last_farm:${user.id}`, farmId);
    setActiveFarmId(farmId);
    // Notifica outras telas (FarmSwitcher, useDefaultFarmId, etc.)
    window.dispatchEvent(new CustomEvent("farm:changed", { detail: { farmId } }));
    // Recarrega para garantir que todos os hooks releiam o farm_id
    setTimeout(() => window.location.reload(), 100);
    return true;
  }, [user?.id, activeFarmId]);

  return { farms, activeFarmId, loading, setActiveFarm, refresh: load };
}
