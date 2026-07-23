// ─────────────────────────────────────────────────────────────────────────────
// useAutomationActiveEquipments — devolve um Set reativo dos equipmentIds
// que estão de fato em modo automático AGORA: precisam ter ao menos uma
// programação ATIVA na nuvem E o motor global ligado para a fazenda.
// Quando o usuário desliga o automático (engine) ou desativa a programação,
// o badge AUTO some imediatamente do card da bomba.
// ─────────────────────────────────────────────────────────────────────────────
import { useMemo } from "react";
import { useCloudAutomation } from "@/hooks/useCloudAutomation";

export function useAutomationActiveEquipments(): Set<string> {
  const { schedules, engineActive } = useCloudAutomation();
  return useMemo(() => {
    if (!engineActive) return new Set<string>();
    return new Set(schedules.filter((s) => s.active).map((s) => s.equipmentId));
  }, [schedules, engineActive]);
}

