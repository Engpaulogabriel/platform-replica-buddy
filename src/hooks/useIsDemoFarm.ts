// useIsDemoFarm — diz se a fazenda ativa do usuário é uma fazenda de
// demonstração (farms.is_demo = true). Usado para exibir o banner amarelo
// "MODO DEMONSTRAÇÃO" no Dashboard e para acionar o interceptor de simulação.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "./useDefaultFarmId";

export function useIsDemoFarm() {
  const farmId = useDefaultFarmId();
  const [isDemo, setIsDemo] = useState(false);
  const [farmName, setFarmName] = useState<string | null>(null);

  useEffect(() => {
    if (!farmId) { setIsDemo(false); setFarmName(null); return; }
    let cancelled = false;
    void supabase
      .from("farms")
      .select("is_demo, name")
      .eq("id", farmId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setIsDemo(Boolean(data?.is_demo));
        setFarmName(data?.name ?? null);
      });
    return () => { cancelled = true; };
  }, [farmId]);

  return { isDemo, farmName, farmId };
}
