// ─────────────────────────────────────────────────────────────────────────────
// CloudBridgeStatusBadge — Status do Bridge RS-232 baseado em telemetria REAL.
// Conforme regra do projeto: ONLINE se QUALQUER equipamento da fazenda
// atualizou `updated_at` nos últimos 180s. A tabela bridge_heartbeat sozinha
// não é confiável (pode ficar stale enquanto agentes continuam comunicando).
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import { Server } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";

const ONLINE_THRESHOLD_SEC = 180; // 3 min

export function CloudBridgeStatusBadge() {
  const farmId = useDefaultFarmId();
  const [lastTs, setLastTs] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("equipments")
        .select("updated_at")
        .eq("farm_id", farmId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) setLastTs((data as any)?.updated_at ?? null);
    };
    void load();
    const id = setInterval(load, 30_000);
    const tickId = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => { cancelled = true; clearInterval(id); clearInterval(tickId); };
  }, [farmId]);

  if (!lastTs) return null;

  const ageMs = Date.now() - new Date(lastTs).getTime();
  const ageSec = ageMs / 1000;
  const ageMin = ageSec / 60;
  const state: "online" | "offline" = ageSec < ONLINE_THRESHOLD_SEC ? "online" : "offline";

  const color = state === "online" ? "bg-emerald-500" : "bg-red-500";
  const label = state === "online" ? "Online" : "Offline";
  void tick;

  const hb = new Date(lastTs).toLocaleTimeString("pt-BR", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-border bg-card/60">
            <Server className="w-3.5 h-3.5 text-muted-foreground" />
            <span className={`w-2 h-2 rounded-full ${color} ${state !== "online" ? "animate-pulse" : ""}`} />
            <span className="text-[10px] font-medium hidden lg:inline">{label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-xs">
            <div className="font-semibold">Bridge (telemetria): {label}</div>
            <div className="text-muted-foreground">Última atualização: {hb}</div>
            <div className="text-muted-foreground">
              Há {Math.floor(ageMin)} min {Math.floor(ageSec) % 60}s
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
