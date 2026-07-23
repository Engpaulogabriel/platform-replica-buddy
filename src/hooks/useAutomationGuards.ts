// ─────────────────────────────────────────────────────────────────────────────
// useAutomationGuards — observa a tabela `automation_guards` na nuvem e
// devolve um Set reativo dos equipmentIds com guard ativo.
// (Voltou a usar canal próprio após bug de freeze no barramento compartilhado.)
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";

export function useAutomationGuards(): Set<string> {
  const farmId = useDefaultFarmId();
  const [set, setSet] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!farmId) { setSet(new Set()); return; }
    let cancelled = false;

    const refresh = async () => {
      const { data } = await supabase
        .from("automation_guards")
        .select("equipment_id")
        .eq("farm_id", farmId);
      if (cancelled) return;
      setSet(new Set((data ?? []).map((r) => r.equipment_id as string)));
    };

    void refresh();

    // EMERGÊNCIA: Realtime desabilitado globalmente (src/lib/realtimeKillSwitch.ts).
    // Polling HTTP simples a cada 15s.
    const poll = setInterval(() => { void refresh(); }, 15_000);

    const onLocal = () => { void refresh(); };
    window.addEventListener("automation-guard:updated", onLocal);

    return () => {
      cancelled = true;
      clearInterval(poll);
      window.removeEventListener("automation-guard:updated", onLocal);
    };
  }, [farmId]);

  return set;
}
