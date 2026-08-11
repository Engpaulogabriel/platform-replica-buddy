// Resolve o órgão ambiental responsável pela outorga a partir do ESTADO da
// fazenda (farms.state_code → environmental_agencies). INEMA é só da Bahia.
// Enquanto carrega / se não achar, cai no default INEMA-BA (o pedido diz que a
// Semear é BA e a maioria da base é Bahia).
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface EnvironmentalAgency {
  state_code: string;
  state_name: string;
  agency_name: string;
  agency_acronym: string;
}

const DEFAULT_AGENCY: EnvironmentalAgency = {
  state_code: "BA",
  state_name: "Bahia",
  agency_name: "Instituto do Meio Ambiente e Recursos Hídricos",
  agency_acronym: "INEMA",
};

export function useEnvironmentalAgency(farmId: string | null | undefined): { agency: EnvironmentalAgency; loading: boolean } {
  const [agency, setAgency] = useState<EnvironmentalAgency>(DEFAULT_AGENCY);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!farmId) { setAgency(DEFAULT_AGENCY); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const { data: farm } = await supabase
        .from("farms").select("state_code" as any).eq("id", farmId).maybeSingle();
      const code = String((farm as any)?.state_code ?? "BA").toUpperCase().slice(0, 2);
      const { data: ag } = await supabase
        .from("environmental_agencies" as any)
        .select("state_code, state_name, agency_name, agency_acronym")
        .eq("state_code", code)
        .maybeSingle();
      if (cancelled) return;
      setAgency((ag as any) ?? { ...DEFAULT_AGENCY, state_code: code });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [farmId]);

  return { agency, loading };
}
