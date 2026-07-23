import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AutomacoesAuditPanel } from "@/components/automacoes/AutomacoesAuditPanel";

interface Props { farmId: string | null; }

interface EquipmentLite { id: string; name: string; }
interface AutomationLite { id: string; name: string; }

export default function AuditoriaReportTab({ farmId }: Props) {
  const [equipments, setEquipments] = useState<EquipmentLite[]>([]);
  const [automacoes, setAutomacoes] = useState<AutomationLite[]>([]);

  useEffect(() => {
    if (!farmId) { setEquipments([]); setAutomacoes([]); return; }
    void (async () => {
      const [{ data: eqs }, { data: autos }] = await Promise.all([
        supabase.from("equipments").select("id, name").eq("farm_id", farmId).order("name"),
        supabase.from("automations").select("id, name").eq("farm_id", farmId),
      ]);
      setEquipments((eqs ?? []) as EquipmentLite[]);
      setAutomacoes((autos ?? []) as AutomationLite[]);
    })();
  }, [farmId]);

  const automacaoNameById = useMemo(() => {
    const m = new Map<string, string>();
    automacoes.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [automacoes]);

  return (
    <AutomacoesAuditPanel
      farmId={farmId}
      equipments={equipments}
      automacaoNameById={automacaoNameById}
    />
  );
}
