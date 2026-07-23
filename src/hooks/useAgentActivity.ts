// useAgentActivity — detecta se o agente Electron está vivo via atividade
// indireta (logs e respostas a comandos), independentemente do heartbeat
// no site_health (que pode estar travado por bug do agente .exe).
//
// v2 (redução de cota Cloud): substituiu polling HTTP de 10s por
// Supabase Realtime (WebSocket). Faz 1 fetch inicial e depois reage a
// INSERT em agent_logs e UPDATE em commands via subscription.
// Custo: ~3 requests/sessão em vez de ~26 mil/dia.

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const TICK_MS = 30_000; // recalcula isLive (passagem do tempo) a cada 30s — state only, sem fetch
const ACTIVITY_WINDOW_MS = 120_000; // considera "vivo" se houve atividade nos últimos 120s

export interface AgentActivity {
  lastActivityAt: Date | null;
  ageSeconds: number | null;
  isLive: boolean;
  loading: boolean; // true até o primeiro fetch terminar
}

export function useAgentActivity(farmId: string | null): AgentActivity {
  const [lastAt, setLastAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [, force] = useState(0);

  useEffect(() => {
    if (!farmId) { setLastAt(null); setLoading(false); return; }
    let mounted = true;
    setLoading(true);

    const bumpFromIso = (iso: string | null | undefined) => {
      if (!iso) return;
      const t = new Date(iso);
      if (Number.isNaN(t.getTime())) return;
      setLastAt((prev) => (!prev || t > prev ? t : prev));
    };

    // 1. Fetch inicial (1x). Depois disso, atividade só via Realtime.
    const fetchInitial = async () => {
      try {
        const [logRes, sentRes, respRes] = await Promise.all([
          supabase
            .from("agent_logs")
            .select("created_at")
            .eq("farm_id", farmId)
            .order("created_at", { ascending: false })
            .limit(1),
          supabase
            .from("commands")
            .select("sent_at")
            .eq("farm_id", farmId)
            .not("sent_at", "is", null)
            .order("sent_at", { ascending: false })
            .limit(1),
          supabase
            .from("commands")
            .select("responded_at")
            .eq("farm_id", farmId)
            .not("responded_at", "is", null)
            .order("responded_at", { ascending: false })
            .limit(1),
        ]);
        if (!mounted) return;
        bumpFromIso((logRes.data as { created_at: string }[] | null)?.[0]?.created_at);
        bumpFromIso((sentRes.data as { sent_at: string }[] | null)?.[0]?.sent_at);
        bumpFromIso((respRes.data as { responded_at: string }[] | null)?.[0]?.responded_at);
      } catch {
        /* silencioso */
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void fetchInitial();

    // 2. Realtime: dispara em qualquer atividade do agente.
    const channelName = `agent-activity-${farmId}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_logs", filter: `farm_id=eq.${farmId}` },
        (payload) => bumpFromIso((payload.new as { created_at?: string })?.created_at),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "commands", filter: `farm_id=eq.${farmId}` },
        (payload) => {
          const row = payload.new as { sent_at?: string | null; responded_at?: string | null };
          bumpFromIso(row?.sent_at);
          bumpFromIso(row?.responded_at);
        },
      )
      .subscribe();

    // 3. Tick de UI (state-only, sem fetch) p/ recalcular ageSeconds/isLive.
    const tickId = setInterval(() => { force((n) => n + 1); }, TICK_MS);

    return () => {
      mounted = false;
      clearInterval(tickId);
      try { supabase.removeChannel(channel); } catch { /* ignore */ }
    };
  }, [farmId]);

  const ageSeconds = lastAt ? Math.floor((Date.now() - lastAt.getTime()) / 1000) : null;
  const isLive = !!lastAt && (Date.now() - lastAt.getTime()) < ACTIVITY_WINDOW_MS;
  return { lastActivityAt: lastAt, ageSeconds, isLive, loading };
}
