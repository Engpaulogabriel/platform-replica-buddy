// Hook que lê o status do agente Electron headless via tabela site_health.
// Heartbeat do agente: a cada 30s (independente da serial — prova que internet + agente estão vivos).
// Regras simplificadas (2026-06-10): SEM estado "instável".
//   • last_heartbeat < 180s  → online  (verde discreto)
//   • > 180s ou sem registro → offline (badge vermelho)

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// Mantém "unstable" no union por compatibilidade de tipo com consumidores antigos,
// mas o hook NUNCA retorna esse valor — só "online" ou "offline".
export type AgentHealthState = "online" | "unstable" | "offline";

export interface SiteHealth {
  state: AgentHealthState;
  lastHeartbeat: Date | null;
  ageSeconds: number | null;
  comPort: string | null;
  comConnected: boolean;
  agentVersion: string | null;
  pendingCommands: number;
  uptimeSeconds: number;
  lastError: string | null;
  loading: boolean;
}

const EMPTY: SiteHealth = {
  state: "offline",
  lastHeartbeat: null,
  ageSeconds: null,
  comPort: null,
  comConnected: false,
  agentVersion: null,
  pendingCommands: 0,
  uptimeSeconds: 0,
  lastError: null,
  loading: true,
};

// Threshold: 60s. Agente envia heartbeat a cada 30s — 60s = 2 batidas perdidas.
// Também respeita agent_status='offline' (graceful shutdown do Electron).
const OFFLINE_THRESHOLD_S = 60;

function classify(lastHb: Date | null, agentStatus?: string | null): { state: AgentHealthState; age: number | null } {
  if (!lastHb) return { state: "offline", age: null };
  if (agentStatus === "offline") {
    return { state: "offline", age: Math.floor((Date.now() - lastHb.getTime()) / 1000) };
  }
  const age = Math.floor((Date.now() - lastHb.getTime()) / 1000);
  if (age < OFFLINE_THRESHOLD_S) return { state: "online", age };
  return { state: "offline", age };
}

export function useSiteHealth(farmId: string | null) {
  const [health, setHealth] = useState<SiteHealth>(EMPTY);

  useEffect(() => {
    if (!farmId) { setHealth({ ...EMPTY, loading: false }); return; }
    let mounted = true;

    const apply = (row: any) => {
      if (!mounted) return;
      const lastHb = row?.last_heartbeat ? new Date(row.last_heartbeat) : null;
      const { state, age } = classify(lastHb, row?.agent_status);
      setHealth({
        state,
        lastHeartbeat: lastHb,
        ageSeconds: age,
        comPort: row?.com_port ?? null,
        // Se agente reportou offline (graceful shutdown), a porta COM também
        // não está mais operacional, independentemente do valor persistido.
        comConnected: state === "online" && !!row?.com_connected,
        agentVersion: row?.agent_version ?? null,
        pendingCommands: row?.pending_commands ?? 0,
        uptimeSeconds: row?.uptime_seconds ?? 0,
        lastError: row?.last_error ?? null,
        loading: false,
      });
    };

    const fetchOnce = async () => {
      const { data } = await supabase
        .from("site_health")
        .select("*")
        .eq("farm_id", farmId)
        .maybeSingle();
      apply(data);
    };
    void fetchOnce();

    // Polling HTTP (Realtime está com kill-switch global). 20s = detecta
    // shutdown do Electron rápido (heartbeat threshold é 60s).
    const pollId = setInterval(() => { void fetchOnce(); }, 20_000);

    // Realtime opcional (best-effort — se estiver ativo, atualiza instantâneo)
    const channelName = `site_health:${farmId}:${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase.channel(channelName);
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "site_health", filter: `farm_id=eq.${farmId}` },
      (payload) => apply((payload.new as any) || (payload.old as any)),
    );
    channel.subscribe();

    // Refresh local da idade a cada 5s (não consulta DB) — reage rápido a quedas
    const tick = setInterval(() => {
      setHealth((h) => {
        if (!h.lastHeartbeat) return h;
        const { state, age } = classify(h.lastHeartbeat);
        if (state === h.state && age === h.ageSeconds) return h;
        // Se transicionou para offline, também derruba comConnected
        const comConnected = state === "online" ? h.comConnected : false;
        return { ...h, state, ageSeconds: age, comConnected };
      });
    }, 5_000);

    return () => {
      mounted = false;
      clearInterval(pollId);
      try { supabase.removeChannel(channel); } catch { /* ignore */ }
      clearInterval(tick);
    };
  }, [farmId]);

  return health;
}

export function formatAge(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s atrás`;
  if (seconds < 3600) return `${Math.floor(seconds/60)}min atrás`;
  return `${Math.floor(seconds/3600)}h atrás`;
}
