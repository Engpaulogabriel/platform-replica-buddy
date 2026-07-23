// useUserOnline — detecta perda de internet do USUÁRIO no navegador.
// Combina navigator.onLine + heartbeat HEAD ao Supabase a cada 30s.
// NÃO confunda com status do agente/bridge na fazenda — esse hook fala
// exclusivamente sobre a conexão do dispositivo do usuário com a internet.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";

interface UserOnlineState {
  online: boolean;
  lastOkAt: number; // ms epoch da última verificação OK
  reconnectingNow: boolean;
  /** true após ≥3 falhas consecutivas mas ainda não declarado offline duro.
   *  Usado para mostrar banner amarelo "Reconectando…" (Starlink microcortes). */
  softReconnecting: boolean;
}

const Ctx = createContext<UserOnlineState>({ online: true, lastOkAt: Date.now(), reconnectingNow: false, softReconnecting: false });

const HEARTBEAT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL as string | undefined;

async function heartbeat(): Promise<boolean> {
  if (!SUPABASE_URL) return navigator.onLine;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HEARTBEAT_TIMEOUT_MS);
    // /auth/v1/health responde rápido (200) sem JWT
    // Qualquer resposta HTTP (mesmo 401/4xx) prova que há internet — só nos
    // importa se o fetch chegou ao servidor. res.ok seria false em 401 e
    // marcaria o usuário como offline incorretamente.
    await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      method: "GET",
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

export function UserOnlineProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState<boolean>(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [lastOkAt, setLastOkAt] = useState<number>(Date.now());
  const [reconnectingNow, setReconnectingNow] = useState(false);
  const [softReconnecting, setSoftReconnecting] = useState(false);
  const lastStateRef = useRef<boolean>(online);
  const failuresRef = useRef<number>(0);

  useEffect(() => {
    const onOnline = async () => {
      setReconnectingNow(true);
      const ok = await heartbeat();
      setReconnectingNow(false);
      if (ok) {
        failuresRef.current = 0;
        setSoftReconnecting(false);
        setOnline(true);
        setLastOkAt(Date.now());
      }
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const navOk = typeof navigator === "undefined" ? true : navigator.onLine;
      if (!navOk) {
        failuresRef.current += 1;
        setOnline(false);
        return;
      }
      const ok = await heartbeat();
      if (cancelled) return;
      if (ok) {
        failuresRef.current = 0;
        setSoftReconnecting(false);
        setOnline(true);
        setLastOkAt(Date.now());
      } else {
        failuresRef.current += 1;
        // 1-2 falhas: silencioso (microinterrupção Starlink).
        // 3-4 falhas: banner amarelo discreto "Reconectando…".
        // 5+ falhas: declara offline duro (banner vermelho).
        if (failuresRef.current >= 5) {
          setSoftReconnecting(false);
          setOnline(false);
        } else if (failuresRef.current >= 3) {
          setSoftReconnecting(true);
        }
      }
    };
    void tick();
    const id = setInterval(tick, HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // Quando volta online após estar offline, força refresh dos dados (queries)
  useEffect(() => {
    if (lastStateRef.current === online) return;
    const wasOffline = lastStateRef.current === false;
    lastStateRef.current = online;
    if (online && wasOffline) {
      // Reativa subscriptions Supabase
      try { supabase.realtime.connect(); } catch { /* ignore */ }
      // Sinaliza para o app que pode revalidar (componentes podem ouvir)
      window.dispatchEvent(new CustomEvent("user-online:reconnected"));
    }
  }, [online]);

  return (
    <Ctx.Provider value={{ online, lastOkAt, reconnectingNow, softReconnecting }}>
      {children}
    </Ctx.Provider>
  );
}

export function useUserOnline() {
  return useContext(Ctx);
}
