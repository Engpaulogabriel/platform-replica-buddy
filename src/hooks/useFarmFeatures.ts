// useFarmFeatures — Lê os módulos habilitados (`farms.modules`) para a fazenda
// atualmente selecionada. Platform admins SEMPRE veem todos os módulos como
// ativos (toggles afetam apenas a visão do cliente).
//
// Chaves cobertas:
//   - energia           → página /demanda-energia e widgets de energia
//   - vazao_consumo     → aba "Vazão e Consumo" em Relatórios
//   - niveis            → seção de Reservatórios no Dashboard e aba "Níveis" em Relatórios
//
// Novas fazendas vêm com TODAS desativadas (admin precisa habilitar).
// Fazendas pré-existentes foram migradas com TODAS ativas para não quebrar nada.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";

export interface FarmFeatures {
  energia: boolean;
  vazao_consumo: boolean;
  niveis: boolean;
  inema: boolean;
  loading: boolean;
}

const DEFAULT_OFF: FarmFeatures = {
  energia: false,
  vazao_consumo: false,
  niveis: false,
  inema: false,
  loading: true,
};

const ALL_ON: Omit<FarmFeatures, "loading"> = {
  energia: true,
  vazao_consumo: true,
  niveis: true,
  inema: true,
};

export function useFarmFeatures(farmIdOverride?: string | null): FarmFeatures {
  const fallbackFarmId = useDefaultFarmId();
  const farmId = farmIdOverride ?? fallbackFarmId;
  const { isPlatformAdmin, loading: adminLoading } = usePlatformAdmin();
  const [state, setState] = useState<FarmFeatures>(DEFAULT_OFF);

  useEffect(() => {
    let cancelled = false;

    if (adminLoading) return;

    // Platform admin sempre enxerga tudo
    if (isPlatformAdmin) {
      setState({ ...ALL_ON, loading: false });
      return;
    }

    if (!farmId) {
      // sem fazenda: fail-open para módulos legados, mas INEMA é opt-in (sempre false)
      setState({ ...ALL_ON, inema: false, loading: false });
      return;
    }

    setState((s) => ({ ...s, loading: true }));

    void supabase
      .from("farms")
      .select("modules, inema_enabled")
      .eq("id", farmId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const mods = (data?.modules ?? {}) as Record<string, unknown>;
        setState({
          energia: mods.energia !== false,
          vazao_consumo: mods.vazao_consumo !== false,
          niveis: mods.niveis !== false,
          inema: Boolean((data as any)?.inema_enabled),
          loading: false,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [farmId, isPlatformAdmin, adminLoading]);

  return state;
}
