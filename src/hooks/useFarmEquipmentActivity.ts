// useFarmEquipmentActivity — fonte de verdade do "sistema online"
// ────────────────────────────────────────────────────────────────────
// Em vez de depender de heartbeat WebSocket/Realtime (que está com
// kill-switch ativo), olha para o MAX(updated_at) da tabela equipments.
// Se algum equipamento foi atualizado nos últimos 180s → bridge ONLINE.
//
// Polling HTTP a cada 60s. Recalcula state localmente a cada 15s sem
// fetch — assim a transição online→offline acontece sem esperar o
// próximo poll.

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const POLL_MS = 60_000;
const TICK_MS = 15_000;
const ONLINE_WINDOW_MS = 180_000;  // <180s = online
const OFFLINE_WINDOW_MS = 300_000; // >300s = offline (toast permitido)

export interface FarmEquipmentActivity {
  lastUpdateAt: Date | null;
  ageSeconds: number | null;
  isOnline: boolean;     // <180s
  isHardOffline: boolean; // >300s (gating de toast)
  loading: boolean;
}

export function useFarmEquipmentActivity(farmId: string | null): FarmEquipmentActivity {
  const [lastAt, setLastAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [, force] = useState(0);

  useEffect(() => {
    if (!farmId) {
      setLastAt(null);
      setLoading(false);
      return;
    }
    let mounted = true;

    const fetchOnce = async () => {
      try {
        const { data } = await supabase
          .from("equipments")
          .select("updated_at")
          .eq("farm_id", farmId)
          .order("updated_at", { ascending: false })
          .limit(1);
        if (!mounted) return;
        const iso = (data as { updated_at: string }[] | null)?.[0]?.updated_at;
        if (iso) {
          const t = new Date(iso);
          if (!Number.isNaN(t.getTime())) {
            setLastAt((prev) => (!prev || t > prev ? t : prev));
          }
        }
      } catch {
        /* silencioso */
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void fetchOnce();
    const pollId = setInterval(() => { void fetchOnce(); }, POLL_MS);
    const tickId = setInterval(() => { force((n) => n + 1); }, TICK_MS);

    return () => {
      mounted = false;
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, [farmId]);

  const ageMs = lastAt ? Date.now() - lastAt.getTime() : null;
  const ageSeconds = ageMs != null ? Math.floor(ageMs / 1000) : null;
  const isOnline = ageMs != null && ageMs < ONLINE_WINDOW_MS;
  const isHardOffline = ageMs != null && ageMs > OFFLINE_WINDOW_MS;

  return { lastUpdateAt: lastAt, ageSeconds, isOnline, isHardOffline, loading };
}
