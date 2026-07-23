// Banner em tempo real avisando:
// 1) Bomba operando em horário de Ponta (18h-21h dia útil)
// 2) Demanda contratada (kW) ultrapassada pela soma das bombas ligadas
//
// Renderizado no AppLayout para aparecer em todas as páginas autenticadas.
import { useEffect, useState } from "react";
import { AlertTriangle, Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useNationalHolidaysSet, DEFAULT_PROD_CFG } from "@/hooks/useProductivityData";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";
import { isPeakNow } from "@/lib/tariff";

interface EqRow {
  id: string;
  name: string;
  power_kw: number | null;
  saida: number | null;
  last_outputs_state: string | null;
  last_communication: string | null;
  communication_status: string | null;
}

const ONLINE_WINDOW_MS = 60_000; // 60s sem RX = offline para alerta de custo

function isCommunicating(eq: EqRow): boolean {
  if (eq.communication_status === "offline") return false;
  if (!eq.last_communication) return false;
  const age = Date.now() - new Date(eq.last_communication).getTime();
  if (Number.isNaN(age) || age > ONLINE_WINDOW_MS) return false;
  return true;
}

function isRunning(eq: EqRow): boolean {
  // Equipamento sem comunicação = estado desconhecido, NÃO conta como ligado
  if (!isCommunicating(eq)) return false;
  const payload = eq.last_outputs_state ?? "";
  const idx = (eq.saida ?? 1) - 1;
  if (payload.length === 1) return payload === "1";
  return payload[idx] === "1";
}

export function PeakHourBanner() {
  const farmId = useDefaultFarmId();
  const { isPlatformAdmin } = usePlatformAdmin();
  const holidays = useNationalHolidaysSet();
  const [equipments, setEquipments] = useState<EqRow[]>([]);
  const [contractedKw, setContractedKw] = useState(0);
  const [now, setNow] = useState(new Date());

  // Tick a cada minuto pra recalcular ponta/fora-ponta
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Busca config + equipamentos com Realtime
  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    const refresh = async () => {
      const [eqRes, cfgRes] = await Promise.all([
        supabase.from("equipments")
          .select("id, name, power_kw, saida, last_outputs_state, last_communication, communication_status")
          .eq("farm_id", farmId).in("type", ["poco", "bombeamento"] as any),
        supabase.from("farm_productivity_config" as any).select("contracted_demand_kw").eq("farm_id", farmId).maybeSingle(),
      ]);
      if (cancelled) return;
      setEquipments((eqRes.data as any) ?? []);
      setContractedKw(Number((cfgRes.data as any)?.contracted_demand_kw ?? DEFAULT_PROD_CFG.contracted_demand_kw));
    };
    void refresh();
    const ch = supabase.channel(`peak-${farmId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "equipments", filter: `farm_id=eq.${farmId}` }, () => void refresh())
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(ch); };
  }, [farmId]);

  if (!farmId || !isPlatformAdmin) return null;
  const peak = isPeakNow(holidays, now);
  const running = equipments.filter(isRunning);
  const runningKw = running.reduce((sum, e) => sum + Number(e.power_kw ?? 0), 0);
  const peakRunning = peak && running.some(e => Number(e.power_kw ?? 0) > 0 || running.length > 0);
  const overDemand = contractedKw > 0 && runningKw > contractedKw;

  if (!peakRunning && !overDemand) return null;

  return (
    <div className="space-y-1">
      {peakRunning && (
        <div className="bg-destructive/10 border-y border-destructive/30 px-4 py-2 flex items-center gap-2 text-destructive text-sm font-medium">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span><strong>HORÁRIO DE PONTA</strong> (18h–21h) — {running.length} bomba(s) ligada(s). Custo de energia elevado.</span>
        </div>
      )}
      {overDemand && (
        <div className="bg-warning/15 border-y border-warning/40 px-4 py-2 flex items-center gap-2 text-warning-foreground text-sm font-medium">
          <Zap className="w-4 h-4 shrink-0 text-warning" />
          <span>
            <strong>Risco de ultrapassagem de demanda:</strong> {runningKw.toFixed(1)} kW em uso vs {contractedKw} kW contratados. Sujeito a multa da concessionária.
          </span>
        </div>
      )}
    </div>
  );
}
