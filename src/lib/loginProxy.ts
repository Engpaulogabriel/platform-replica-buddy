// Cliente do login-proxy. Chama a Edge Function, aplica a sessão retornada
// no supabase-js local (para persistir tokens em localStorage) e devolve
// um resultado padronizado. Suporta a flag futura de reCAPTCHA (v3+v2).
import { supabase } from "@/integrations/supabase/client";
import { setStoredSessionId } from "@/lib/sessionId";
import { getDeviceInfo } from "@/lib/deviceFingerprint";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY     = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export type LoginProxyResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string; needsCaptchaV2?: boolean; retryAfterSeconds?: number };

export interface LoginProxyInput {
  email: string;
  password: string;
  captchaV3?: string;
  captchaV2?: string;
}

export async function signInViaProxy(input: LoginProxyInput): Promise<LoginProxyResult> {
  let device_fp = "";
  try { device_fp = (await getDeviceInfo()).fingerprint; } catch { /* opcional */ }

  const url = `${SUPABASE_URL}/functions/v1/login-proxy`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "apikey": ANON_KEY,
      },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        captcha_v3: input.captchaV3,
        captcha_v2: input.captchaV2,
        device_fp,
        user_agent: navigator.userAgent,
      }),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network_error" };
  }

  let data: any = null;
  try { data = await resp.json(); } catch { /* noop */ }

  if (resp.status === 200 && data?.session?.access_token) {
    const { error } = await supabase.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    if (error) return { ok: false, error: error.message };
    const sessionId: string = data.session_id ?? data.session.refresh_token;
    // Persiste o id ESTÁVEL da sessão (não rotaciona) para o check de sessão única.
    setStoredSessionId(sessionId);
    return { ok: true, sessionId };
  }

  if (resp.status === 428) {
    return { ok: false, error: data?.error ?? "captcha_required_v2", needsCaptchaV2: true };
  }
  if (resp.status === 429) {
    return {
      ok: false,
      error: "ip_blocked",
      retryAfterSeconds: Number(data?.retry_after_seconds ?? 0),
    };
  }
  if (resp.status === 401) {
    return { ok: false, error: "invalid_credentials" };
  }
  return { ok: false, error: data?.error ?? `http_${resp.status}` };
}

/** Chama a RPC pública que registra a sessão do cliente e derruba anteriores. */
export async function claimActiveSession(sessionId: string): Promise<void> {
  let device_fp = "";
  try { device_fp = (await getDeviceInfo()).fingerprint; } catch { /* opcional */ }
  try {
    await supabase.rpc("claim_active_session", {
      _session_id: sessionId,
      _device_fp: device_fp,
      _ip: "",
      _user_agent: navigator.userAgent,
    });
  } catch (e) {
    console.warn("[claim_active_session] falhou", e);
  }
}
