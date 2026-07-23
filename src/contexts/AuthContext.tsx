import { createContext, useContext, useEffect, useState, ReactNode, useRef, useCallback } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { resetAutomationLogSync } from "@/lib/automationLog";
import { signInViaProxy, claimActiveSession } from "@/lib/loginProxy";
import { startBehavioralGuard, stopBehavioralGuard, trackHit } from "@/lib/apiHitTracker";
import { startFingerprintGuard, stopFingerprintGuard } from "@/lib/fingerprintGuard";
import { getStoredSessionId, clearStoredSessionId } from "@/lib/sessionId";
import { toast } from "@/hooks/use-toast";

interface AuthContextType {
  isAuthenticated: boolean;
  user: User | null;
  session: Session | null;
  loading: boolean;
  login: (
    email: string,
    password: string,
    extra?: { captchaV3?: string; captchaV2?: string },
  ) => Promise<{ ok: boolean; error?: string; needsCaptchaV2?: boolean; retryAfterSeconds?: number }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

type AuthLogoutReason =
  | "active_session_check"
  | "fingerprint_mismatch"
  | "token_refresh_failed"
  | "manual_logout"
  | "behavioral_guard"
  | "supabase_signed_out";

// Intervalo entre checks de sessão única (polling — Realtime está desligado).
// Mantém a proteção, mas evita falsos positivos em redes rurais/Starlink instáveis.
const SESSION_CHECK_MS = 5 * 60_000;
const AUTH_REFRESH_CHECK_MS = 60_000;
const AUTH_REFRESH_SKEW_SECONDS = 10 * 60;
const AUTH_REFRESH_RETRY_ATTEMPTS = 3;
const AUTH_REFRESH_RETRY_DELAY_MS = 5_000;

// "Remember me" seguro: refresh_token criptografado com AES-GCM (chave derivada
// do device fingerprint) + TTL de 7 dias. Impede uso do token em outra máquina.
import {
  savePersistedRefreshToken as persistRefreshToken,
  readPersistedRefreshToken,
  clearPersistedRefreshToken,
} from "@/lib/persistRefresh";

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function logAuthLogout(reason: AuthLogoutReason) {
  console.log("[AUTH] Logout triggered by:", reason);
}

function isFatalRefreshError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  const normalized = message.toLowerCase();
  return normalized.includes("refresh token")
    && (
      normalized.includes("not found")
      || normalized.includes("invalid")
      || normalized.includes("expired")
      || normalized.includes("revoked")
    );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const takeoverShownRef = useRef(false);
  const pendingLogoutReasonRef = useRef<AuthLogoutReason | null>(null);
  const refreshInFlightRef = useRef(false);
  const missingSessionCountRef = useRef(0);

  const signOutWithReason = useCallback(async (reason: AuthLogoutReason) => {
    pendingLogoutReasonRef.current = reason;
    logAuthLogout(reason);
    try { await supabase.auth.signOut(); } catch { /* noop */ }
  }, []);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (event === "TOKEN_REFRESHED") {
        console.log("[AUTH] Token refreshed successfully");
        if (newSession?.refresh_token) void persistRefreshToken(newSession.refresh_token);
      }
      if (event === "SIGNED_IN" && newSession?.refresh_token) {
        void persistRefreshToken(newSession.refresh_token);
      }
      if (event === "SIGNED_OUT") {
        // Se não foi logout manual/motivo conhecido, tenta recuperar antes de derrubar
        // a sessão (rede rural instável faz GoTrue emitir SIGNED_OUT quando o
        // refresh falha por timeout, mesmo com refresh_token ainda válido).
        if (!pendingLogoutReasonRef.current) {
          logAuthLogout("supabase_signed_out");
          void (async () => {
            for (let attempt = 1; attempt <= AUTH_REFRESH_RETRY_ATTEMPTS; attempt++) {
              try {
                const { data, error } = await supabase.auth.refreshSession();
                if (!error && data.session) {
                  console.log("[AUTH] Recovered session after SIGNED_OUT", { attempt });
                  void persistRefreshToken(data.session.refresh_token);
                  setSession(data.session);
                  setUser(data.session.user);
                  return;
                }
                if (isFatalRefreshError(error)) break;
              } catch (e) {
                console.log("[AUTH] Recovery attempt failed", e);
              }
              await wait(AUTH_REFRESH_RETRY_DELAY_MS);
            }
            // Recuperação falhou: agora sim, limpa estado local
            clearPersistedRefreshToken();
            setSession(null);
            setUser(null);
            clearStoredSessionId();
          })();
          return;
        }
        // Logout manual/motivo conhecido → limpa remember-me também
        if (pendingLogoutReasonRef.current === "manual_logout") {
          clearPersistedRefreshToken();
        }
        pendingLogoutReasonRef.current = null;
        clearStoredSessionId();
      }
      setSession(newSession);
      setUser(newSession?.user ?? null);
    });

    // Init: se não houver sessão viva, tenta restaurar via refresh_token persistido
    void (async () => {
      try {
        const { data: { session: existing } } = await supabase.auth.getSession();
        if (existing) {
          setSession(existing);
          setUser(existing.user);
          void persistRefreshToken(existing.refresh_token);
          return;
        }
        const persisted = await readPersistedRefreshToken();
        if (persisted) {
          console.log("[AUTH] Attempting silent re-auth from persisted refresh_token");
          const { data, error } = await supabase.auth.refreshSession({ refresh_token: persisted });
          if (!error && data.session) {
            console.log("[AUTH] Silent re-auth succeeded");
            void persistRefreshToken(data.session.refresh_token);
            setSession(data.session);
            setUser(data.session.user);
            return;
          }
          console.log("[AUTH] Silent re-auth failed, clearing persisted token", error?.message);
          clearPersistedRefreshToken();
        }
        setSession(null);
        setUser(null);
      } catch {
        setSession(null);
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();

    return () => subscription.unsubscribe();
  }, []);

  // Refresh proativo a cada 45min — garante rotação antes do JWT expirar em 60min,
  // mesmo se o auto-refresh interno do supabase-js falhar por rede instável.
  useEffect(() => {
    if (!session?.refresh_token) return;
    void persistRefreshToken(session.refresh_token);
    const REFRESH_INTERVAL = 45 * 60 * 1000;
    const interval = window.setInterval(async () => {
      console.log("[AUTH] Proactive token refresh…");
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (error) console.warn("[AUTH] Proactive refresh failed, will retry", error.message);
        else {
          console.log("[AUTH] Token refreshed proactively");
          if (data.session?.refresh_token) void persistRefreshToken(data.session.refresh_token);
        }
      } catch (e) {
        console.warn("[AUTH] Proactive refresh threw", e);
      }
    }, REFRESH_INTERVAL);
    return () => window.clearInterval(interval);
  }, [session?.refresh_token]);

  // Watchdog do auto-refresh: o supabase-js já faz refresh automático, mas em
  // rede instável reforçamos com retry antes do token expirar. Falha de rede
  // NÃO derruba sessão; apenas registra diagnóstico e tenta novamente depois.
  useEffect(() => {
    if (!session?.refresh_token) return;
    let cancelled = false;

    const shouldRefreshSoon = () => {
      if (!session.expires_at) return true;
      return (session.expires_at * 1000) - Date.now() <= AUTH_REFRESH_SKEW_SECONDS * 1000;
    };

    const refreshWithRetry = async () => {
      if (refreshInFlightRef.current || cancelled) return;
      refreshInFlightRef.current = true;
      let lastError: unknown = null;
      try {
        for (let attempt = 1; attempt <= AUTH_REFRESH_RETRY_ATTEMPTS; attempt++) {
          const { data, error } = await supabase.auth.refreshSession();
          if (!error && data.session) {
            console.log("[AUTH] Token refresh watchdog succeeded", { attempt });
            return;
          }
          lastError = error;
          if (attempt < AUTH_REFRESH_RETRY_ATTEMPTS) await wait(AUTH_REFRESH_RETRY_DELAY_MS);
        }
        console.log("[AUTH] Token refresh failed after retries", lastError);
        if (isFatalRefreshError(lastError)) {
          await signOutWithReason("token_refresh_failed");
        }
        // Erro de rede/timeout não encerra sessão; tenta novamente no próximo ciclo.
      } catch (error) {
        console.log("[AUTH] Token refresh retry skipped after network error", error);
      } finally {
        refreshInFlightRef.current = false;
      }
    };

    const checkRefresh = () => {
      if (!shouldRefreshSoon()) return;
      void refreshWithRetry();
    };

    checkRefresh();
    const interval = window.setInterval(checkRefresh, AUTH_REFRESH_CHECK_MS);
    const onVisible = () => { if (document.visibilityState === "visible") checkRefresh(); };
    const onOnline = () => checkRefresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [session?.refresh_token, session?.expires_at, signOutWithReason]);

  // Sessão única: verifica periodicamente se a linha em active_sessions
  // ainda pertence a esta sessão. Se foi revogada (login em outro dispositivo),
  // desloga com aviso.
  useEffect(() => {
    if (!user?.id) return;
    // Usa o session_id ESTÁVEL persistido no login (não o refresh_token,
    // que rotaciona a cada auto-refresh do supabase-js e causaria falso
    // "sessão tomada por outro dispositivo" em reloads).
    const currentSid = getStoredSessionId();
    if (!currentSid) return;
    let cancelled = false;

    const check = async () => {
      try {
        const { data, error } = await supabase
          .from("active_sessions")
          .select("session_id, revoked_at")
          .eq("user_id", user.id)
          .eq("session_id", currentSid)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          console.warn("[AUTH] active_session_check ignored after query error", error.message);
          return;
        }

        // Só encerra quando o backend confirma revoked_at explícito.
        // Linha ausente pode ser heartbeat perdido / RLS transiente / rede rural,
        // então exigimos 3 checks consecutivos (~15 min) antes de derrubar.
        if (data?.revoked_at) {
          if (takeoverShownRef.current) return;
          takeoverShownRef.current = true;
          toast({
            title: "Sessão encerrada",
            description: "Sua sessão foi encerrada porque houve login em outro dispositivo.",
            variant: "destructive",
          });
          await signOutWithReason("active_session_check");
        } else if (!data) {
          missingSessionCountRef.current += 1;
          console.warn("[AUTH] active_session row missing", { count: missingSessionCountRef.current });
          if (missingSessionCountRef.current >= 3) {
            if (takeoverShownRef.current) return;
            takeoverShownRef.current = true;
            toast({
              title: "Sessão encerrada",
              description: "Sua sessão foi encerrada porque houve login em outro dispositivo.",
              variant: "destructive",
            });
            await signOutWithReason("active_session_check");
          }
        } else {
          missingSessionCountRef.current = 0;
          // Heartbeat leve
          void supabase.rpc("touch_active_session", { _session_id: currentSid }).then(() => {}, () => {});
        }
      } catch (error) {
        console.warn("[AUTH] active_session_check ignored after network error", error);
      }
    };

    // Primeira verificação imediata + intervalo
    void check();
    const t = window.setInterval(check, SESSION_CHECK_MS);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [user?.id, signOutWithReason]);

  // F2 — Guardas de anti-scraping e fingerprint mismatch
  useEffect(() => {
    if (!user?.id) return;
    const sid = getStoredSessionId();
    if (!sid) return;

    trackHit(location.pathname);

    startBehavioralGuard((reason) => {
      toast({
        title: "Atividade suspeita detectada",
        description: `Sua sessão foi encerrada por segurança (${reason}).`,
        variant: "destructive",
      });
      void signOutWithReason("behavioral_guard");
    });

    startFingerprintGuard(sid, user.id, () => {
      toast({
        title: "Dispositivo alterado",
        description: "Sua sessão foi encerrada porque o dispositivo mudou.",
        variant: "destructive",
      });
      void signOutWithReason("fingerprint_mismatch");
    });

    return () => {
      stopBehavioralGuard();
      stopFingerprintGuard();
    };
  }, [user?.id, signOutWithReason]);

  const login: AuthContextType["login"] = async (email, password, extra) => {
    try {
      const res = await signInViaProxy({
        email,
        password,
        captchaV3: extra?.captchaV3,
        captchaV2: extra?.captchaV2,
      });
      if (res.ok !== true) {
        const fail = res as { ok: false; error: string; needsCaptchaV2?: boolean; retryAfterSeconds?: number };
        return {
          ok: false,
          error: fail.error,
          needsCaptchaV2: fail.needsCaptchaV2,
          retryAfterSeconds: fail.retryAfterSeconds,
        };
      }
      takeoverShownRef.current = false;
      await claimActiveSession(res.sessionId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Falha ao entrar" };
    }
  };

  const logout = async () => {
    try {
      const sid = getStoredSessionId();
      if (user?.id && sid) {
        await supabase
          .from("active_sessions")
          .update({ revoked_at: new Date().toISOString() })
          .eq("session_id", sid);
      }
    } catch { /* noop */ }
    clearStoredSessionId();
    await signOutWithReason("manual_logout");
    resetAutomationLogSync();
  };

  return (
    <AuthContext.Provider value={{
      isAuthenticated: !!session,
      user,
      session,
      loading,
      login,
      logout,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
