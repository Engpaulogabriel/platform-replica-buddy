// ─────────────────────────────────────────────────────────────────────────────
// useCommandQueueStatus — observa a fila de comandos (pending/sent) por farm
// ─────────────────────────────────────────────────────────────────────────────
// Reativo via Realtime + refresh manual. Usado no Dashboard / Bridge card
// para mostrar quantos comandos estão na fila aguardando envio.

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface CommandQueueStats {
  pending: number;
  sent: number;
  lastExecutedAt: string | null;
}

export function useCommandQueueStatus(farmId: string | null | undefined): CommandQueueStats {
  const [stats, setStats] = useState<CommandQueueStats>({ pending: 0, sent: 0, lastExecutedAt: null });

  const refresh = useCallback(async () => {
    if (!farmId) return;
    const [pendingRes, sentRes, lastRes] = await Promise.all([
      supabase.from("commands").select("id", { count: "exact", head: true }).eq("farm_id", farmId).eq("status", "pending"),
      supabase.from("commands").select("id", { count: "exact", head: true }).eq("farm_id", farmId).eq("status", "sent"),
      supabase.from("commands").select("responded_at").eq("farm_id", farmId).eq("status", "executed").order("responded_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    setStats({
      pending: pendingRes.count ?? 0,
      sent: sentRes.count ?? 0,
      lastExecutedAt: (lastRes.data as any)?.responded_at ?? null,
    });
  }, [farmId]);

  useEffect(() => {
    if (!farmId) return;
    void refresh();
    const channelName = `queue-stats-${farmId}-${Math.random().toString(36).slice(2, 8)}`;
    const ch = supabase.channel(channelName);
    ch.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "commands", filter: `farm_id=eq.${farmId}` },
      () => { void refresh(); },
    );
    ch.subscribe();
    const interval = setInterval(refresh, 60_000); // Realtime é primário; fallback 60s p/ cota Cloud
    return () => {
      clearInterval(interval);
      try { supabase.removeChannel(ch); } catch { /* ignore */ }
    };
  }, [farmId, refresh]);

  return stats;
}
