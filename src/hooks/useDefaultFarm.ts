// useDefaultFarm — retorna { id, name } da fazenda padrão (nuvem) do usuário logado.
// Usado para agrupar bombas no Dashboard e listar no SectorsConfig sem cair em "Sem fazenda".
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface DefaultFarm {
  id: string;
  name: string;
}

export function useDefaultFarm(): { farm: DefaultFarm | null; loading: boolean } {
  const { user } = useAuth();
  const [farm, setFarm] = useState<DefaultFarm | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setFarm(null);
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const { data: prof } = await supabase
          .from("profiles").select("default_farm_id").eq("id", user.id).maybeSingle();
        const fid = prof?.default_farm_id;
        if (!fid) { if (!cancelled) { setFarm(null); setLoading(false); } return; }
        const { data: f } = await supabase
          .from("farms").select("id,name").eq("id", fid).maybeSingle();
        if (cancelled) return;
        setFarm(f ? { id: f.id, name: f.name } : null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  return { farm, loading };
}
