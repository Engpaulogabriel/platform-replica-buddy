// useRealtimeHealth — monitora saúde da conexão Realtime do Supabase.
// Mantém um canal "heartbeat" sempre subscrito que observa qualquer UPDATE
// em `equipments` da fazenda corrente. Cada evento atualiza `lastEventAt`.
// `status` reflete o subscribe state ("SUBSCRIBED" = conectado).
import { useEffect, useState } from "react";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";

export type RealtimeStatus = "connected" | "connecting" | "disconnected" | "stale";

const STALE_AFTER_MS = 2 * 60_000; // > 2 min sem evento => avisar (silencioso se nada estiver mudando)

export interface RealtimeHealth {
  status: RealtimeStatus;
  subscribed: boolean;
  lastEventAt: number | null;
  ageMs: number | null;
}

export function useRealtimeHealth(): RealtimeHealth {
  const farmId = useDefaultFarmId();
  const [subscribed, setSubscribed] = useState(false);
  const [channelState, setChannelState] = useState<string>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Tick UI a cada 15s para recalcular idade
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!farmId) return;
    // EMERGÊNCIA: Realtime desabilitado globalmente (src/lib/realtimeKillSwitch.ts).
    // Sem canal heartbeat — reporta "disconnected" (app opera 100% via polling HTTP).
    setSubscribed(false);
    setChannelState("CLOSED");
  }, [farmId]);

  const ageMs = lastEventAt ? now - lastEventAt : null;
  let status: RealtimeStatus;
  if (!subscribed) {
    status = channelState === "CHANNEL_ERROR" || channelState === "TIMED_OUT" || channelState === "CLOSED"
      ? "disconnected"
      : "connecting";
  } else if (ageMs !== null && ageMs > STALE_AFTER_MS) {
    status = "stale";
  } else {
    status = "connected";
  }

  return { status, subscribed, lastEventAt, ageMs };
}

export function formatAge(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
