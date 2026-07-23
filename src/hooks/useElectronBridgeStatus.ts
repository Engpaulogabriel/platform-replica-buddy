// ─────────────────────────────────────────────────────────────────────────────
// useElectronBridgeStatus — status da comunicação com a bridge Electron .exe
// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat: bridge envia PING\r a cada 30s se inativa.
// Status "ping_timeout" = firmware não respondeu → stale.
// Status "ping_sent" = aguardando resposta.
// Qualquer dado recebido (onData) = heartbeat válido.

import { useEffect, useMemo, useState } from "react";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useSiteHealth } from "@/hooks/useSiteHealth";

export type BridgeStatus = "ok" | "no-port" | "stale" | "no-bridge" | "error";

const HEARTBEAT_WINDOW_MS = 30_000;
// Heartbeat do agente é a cada 30s. Após 3 batidas perdidas (90s) começa a degradar.
// Acima de 180s (6 batidas perdidas) → bridge OFFLINE (vermelho).
const STALE_WINDOW_MS = 180_000;
const POLL_MS = 5_000;

export interface ElectronBridgeStatus {
  present: boolean;
  portOpen: boolean;
  lastBeatAt: number | null;
  loadError?: string;
  status: BridgeStatus;
  pingState: "idle" | "waiting" | "timeout";
}

const computeStatus = (
  present: boolean,
  portOpen: boolean,
  lastBeatAt: number | null,
  loadError?: string,
  _pingState?: string,
): BridgeStatus => {
  if (!present) return "no-bridge";
  if (loadError) return "error";
  if (!portOpen) return "no-port";
  const age = lastBeatAt ? Date.now() - lastBeatAt : null;
  // 2026-06-10: SEM estado "connecting/instável" para o usuário.
  // Tudo abaixo de 180s = ok. Acima disso = offline (stale, vermelho).
  if (age === null) return "ok"; // porta acabou de abrir
  if (age < STALE_WINDOW_MS) return "ok";
  return "stale";
};

export function useElectronBridgeStatus(): ElectronBridgeStatus {
  const farmId = useDefaultFarmId();
  const remoteHealth = useSiteHealth(farmId);
  
  const [localPresent] = useState(() => !!(window as any).serialAPI);
  const [portOpen, setPortOpen] = useState(false);
  const [lastBeatAt, setLastBeatAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [pingState, setPingState] = useState<"idle" | "waiting" | "timeout">("idle");
  const [, force] = useState(0);

  useEffect(() => {
    const api = (window as any).serialAPI;
    if (!api) return;

    try {
      const health = api.health?.();
      if (health?.serialLoadError) setLoadError(health.serialLoadError);
    } catch (e: any) {
      setLoadError(e?.message ?? String(e));
    }

    const beat = () => {
      setLastBeatAt(Date.now());
      setPingState("idle");
    };

    const offData = api.onData?.(beat) ?? (() => {});
    const offStatus = api.onStatus?.((evt: { type: string; message?: string }) => {
      if (evt?.type === "open") { setPortOpen(true); beat(); }
      if (evt?.type === "close") { setPortOpen(false); setPingState("idle"); }
      if (evt?.type === "ping_sent") setPingState("waiting");
      if (evt?.type === "ping_timeout") setPingState("timeout");
      if (evt?.type === "ping_fail") setPingState("timeout");
      // Any data-bearing event is a beat
      if (evt?.type !== "ping_sent" && evt?.type !== "ping_timeout" && evt?.type !== "ping_fail") {
        beat();
      }
    }) ?? (() => {});

    try { setPortOpen(!!api.isOpen?.()); } catch { /* ignore */ }

    const id = setInterval(() => {
      try { setPortOpen(!!api.isOpen?.()); } catch { /* ignore */ }
      force((n) => n + 1);
    }, POLL_MS);

    return () => {
      clearInterval(id);
      try { offData?.(); } catch { /* ignore */ }
      try { offStatus?.(); } catch { /* ignore */ }
    };
  }, []);

  // ─── FONTE DE VERDADE: heartbeat do agente Electron (site_health) ────────
  // 2026-07-12: bug crítico — antes usávamos `equipments.updated_at` como
  // fallback, mas essa coluna é tocada por escritas do cloud/edge functions
  // mesmo com o Electron fechado, causando falso "online". Agora só
  // `site_health.last_heartbeat` (< 60s) prova que o agente está vivo.
  const remoteState = useMemo<ElectronBridgeStatus | null>(() => {
    if (remoteHealth.loading) return null;

    const heartbeatAt = remoteHealth.lastHeartbeat?.getTime() ?? null;
    if (!heartbeatAt) return null;

    const online = remoteHealth.state === "online";
    const status: BridgeStatus = online
      ? (remoteHealth.comConnected ? "ok" : "no-port")
      : "stale";

    return {
      present: true,
      portOpen: online && remoteHealth.comConnected,
      lastBeatAt: heartbeatAt,
      loadError: remoteHealth.lastError ?? undefined,
      pingState: online ? "idle" : "timeout",
      status,
    };
  }, [remoteHealth]);

  if (remoteState) return remoteState;

  // Ainda carregando e sem bridge local → modo web
  if (!localPresent) {
    return {
      present: false,
      portOpen: false,
      lastBeatAt: null,
      loadError: undefined,
      pingState: "idle",
      status: "no-bridge",
    };
  }

  const status = computeStatus(localPresent, portOpen, lastBeatAt, loadError, pingState);
  return { present: localPresent, portOpen, lastBeatAt, loadError, status, pingState };
}

export const formatBeatAge = (ts: number | null): string => {
  if (!ts) return "nunca";
  const ms = Date.now() - ts;
  if (ms < 0) return "agora";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `há ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  return `há ${h}h`;
};
