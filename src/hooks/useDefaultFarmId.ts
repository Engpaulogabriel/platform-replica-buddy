// useDefaultFarmId — retorna o farm_id padrão do usuário autenticado
// Fallback: se profiles.default_farm_id for NULL, usa a primeira farm em user_roles
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export function useDefaultFarmId(): string | null {
  const { user } = useAuth();
  const [farmId, setFarmId] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) { setFarmId(null); return; }
    let cancelled = false;

    (async () => {
      // 1) tenta profile.default_farm_id
      const { data: profile } = await supabase
        .from("profiles")
        .select("default_farm_id")
        .eq("id", user.id)
        .maybeSingle();

      let fid = sessionStorage.getItem("impersonate_farm_id")
        ?? sessionStorage.getItem("demo_farm_id")
        ?? (profile as { default_farm_id: string | null } | null)?.default_farm_id
        ?? null;

      // 2) fallback: última fazenda usada no seletor local
      if (!fid) {
        fid = localStorage.getItem(`last_farm:${user.id}`);
      }

      // 3) fallback: primeira farm vinculada via user_roles
      if (!fid) {
        const { data: roles } = await supabase
          .from("user_roles")
          .select("farm_id, role, created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: true })
          .limit(1);
        fid = roles?.[0]?.farm_id ?? null;

      }

      // persiste no profile para próximas leituras
      if (fid) {
        await supabase.from("profiles").update({ default_farm_id: fid }).eq("id", user.id);
      }

      if (!cancelled) setFarmId(fid);
    })();

    return () => { cancelled = true; };
  }, [user?.id]);

  return farmId;
}
