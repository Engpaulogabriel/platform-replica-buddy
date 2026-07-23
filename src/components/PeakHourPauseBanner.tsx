// Banner that shows "Captação pausada — Horário de Ponta" when the peak-hour
// auto-shutdown feature is enabled and the current local time is inside the
// configured peak window for the active farm.
import { useEffect, useState } from "react";
import { PauseCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";

interface Cfg {
  enabled: boolean;
  start_time: string;
  end_time: string;
}

function hhmmNow(tz: string): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz,
    }).format(new Date());
  } catch {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  }
}

export function PeakHourPauseBanner() {
  const farmId = useDefaultFarmId();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [tz, setTz] = useState<string>("America/Sao_Paulo");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    const refresh = async () => {
      const [cRes, fRes] = await Promise.all([
        supabase.from("peak_hour_config" as any)
          .select("enabled, start_time, end_time").eq("farm_id", farmId).maybeSingle(),
        supabase.from("farms").select("timezone").eq("id", farmId).maybeSingle(),
      ]);
      if (cancelled) return;
      const d = cRes.data as any;
      setCfg(d ? {
        enabled: !!d.enabled,
        start_time: String(d.start_time).slice(0, 5),
        end_time: String(d.end_time).slice(0, 5),
      } : null);
      setTz(((fRes.data as any)?.timezone) || "America/Sao_Paulo");
    };
    void refresh();
    const id = setInterval(refresh, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [farmId]);

  if (!cfg?.enabled) return null;
  const now = hhmmNow(tz);
  void tick;
  const inWindow = now >= cfg.start_time && now < cfg.end_time;
  if (!inWindow) return null;

  return (
    <div className="bg-warning/15 border-y border-warning/40 px-4 py-2 flex items-center gap-2 text-sm font-medium text-warning-foreground">
      <PauseCircle className="w-4 h-4 shrink-0 text-warning" />
      <span>
        <strong>Captação pausada — Horário de Ponta</strong> ({cfg.start_time}–{cfg.end_time}).
      </span>
    </div>
  );
}
