// ─────────────────────────────────────────────────────────────────────────────
// notifyWhatsAppImmediate — chamada direta (sem fila/cron) para qualquer
// notificação disparada do interface web. Deve completar em < 3s.
//
// Implementação: usa supabase.functions.invoke como caminho primário e mantém
// fetch direto como fallback explícito. Assim temos o caminho padrão do SDK,
// mas sem perder entrega quando o SDK falhar por sessão/preflight/etc.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from "@/integrations/supabase/client";

export type ImmediateNotificationType =
  | "mode_change"
  | "equipment_control"
  | "operator_approved"
  | "operator_rejected"
  | "invite_code_created"
  | "operator_permissions_changed"
  | "schedule_change"
  | "alert";

interface ImmediateNotificationOptions {
  /** Edge function alvo. Padrão: whatsapp-automation-notify (suporta todos os tipos). */
  functionName?: string;
  /** Não bloquear o chamador (fire-and-forget). Padrão: false (await). */
  fireAndForget?: boolean;
}

export interface WhatsAppNotifyDiagnosticResult {
  ok: boolean;
  status: number;
  via: "invoke" | "fetch";
  data: unknown;
  raw: string;
}

// Resolve URL e chaves a partir do client gerado (sem hardcode além do
// publishable key, que já é público).
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "";
const SUPABASE_ANON = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? "";

async function invokeFunction(fnName: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; raw: string }> {
  console.log("[MODE_CHANGE] Calling Edge Function via supabase.functions.invoke:", fnName, "Body:", body);
  const { data, error } = await supabase.functions.invoke(fnName, { body });

  if (error) {
    console.error("[MODE_CHANGE] supabase.functions.invoke failed:", error);
    return { ok: false, status: (error as { status?: number })?.status ?? 0, raw: JSON.stringify(error) };
  }

  const raw = typeof data === "string" ? data : JSON.stringify(data ?? null);
  console.log("[MODE_CHANGE] supabase.functions.invoke response:", raw.slice(0, 1000));
  return { ok: true, status: 200, raw };
}

async function postToFunction(fnName: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; raw: string }> {
  const url = `${SUPABASE_URL}/functions/v1/${fnName}`;
  console.log("[MODE_CHANGE] Calling Edge Function via direct fetch fallback:", fnName, "URL:", url, "Body:", body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON,
    Authorization: `Bearer ${SUPABASE_ANON}`,
  };
  // Anexa JWT da sessão atual quando disponível (não obrigatório — a função tem verify_jwt=false).
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      console.log("[MODE_CHANGE] Auth session found; using user JWT for Edge Function call");
    } else {
      console.warn("[MODE_CHANGE] No auth session; using publishable key as bearer for Edge Function call");
    }
  } catch (e) {
    console.warn("[MODE_CHANGE] Failed to read auth session before Edge Function call", e);
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    keepalive: true,
  });
  const raw = await res.text().catch(() => "");
  console.log("[MODE_CHANGE] Edge Function HTTP response:", { fnName, status: res.status, ok: res.ok, raw: raw.slice(0, 1000) });
  return { ok: res.ok, status: res.status, raw };
}

function parseRaw(raw: string): unknown {
  try { return raw ? JSON.parse(raw) : null; } catch { return raw; }
}

export async function invokeWhatsAppNotificationDiagnostic(
  payload: Record<string, unknown>,
  options: Pick<ImmediateNotificationOptions, "functionName"> = {},
): Promise<WhatsAppNotifyDiagnosticResult> {
  const fn = options.functionName ?? "whatsapp-automation-notify";
  const body = { ...payload, immediate: true, source: payload.source ?? "Teste Diagnóstico" };

  const first = await invokeFunction(fn, body);
  if (first.ok) {
    return { ...first, via: "invoke", data: parseRaw(first.raw) };
  }

  const fallback = await postToFunction(fn, body);
  return { ...fallback, via: "fetch", data: parseRaw(fallback.raw) };
}

export async function notifyWhatsAppImmediate(
  type: ImmediateNotificationType,
  payload: Record<string, unknown>,
  options: ImmediateNotificationOptions = {},
): Promise<WhatsAppNotifyDiagnosticResult | void> {
  const fn = options.functionName ?? "whatsapp-automation-notify";
  const body = { ...payload, type, immediate: true, source: payload.source ?? "frontend" };
  console.log("[MODE_CHANGE] notifyWhatsAppImmediate start:", { type, fn, body, fireAndForget: !!options.fireAndForget });

  const invocation = invokeWhatsAppNotificationDiagnostic(body, { functionName: fn })
    .then((result) => {
      const { ok, status, raw, data, via } = result;
      if (!ok) {
        console.error("[MODE_CHANGE] Edge Function response:", null, { status, raw: raw.slice(0, 1000) });
        console.error(`[notifyWhatsAppImmediate:${type}] HTTP ${status}`, raw.slice(0, 400));
      } else {
        console.log("[MODE_CHANGE] Edge Function response:", data, null);
        console.log(`[notifyWhatsAppImmediate:${type}] sent via ${via}`, raw.slice(0, 200));
      }
      return result;
    })
    .catch((e) => {
      console.error("[MODE_CHANGE] Edge Function response:", null, e);
      console.error(`[notifyWhatsAppImmediate:${type}] failed`, e);
      return { ok: false, status: 0, via: "fetch" as const, data: e instanceof Error ? e.message : String(e), raw: e instanceof Error ? e.message : String(e) };
    });

  if (options.fireAndForget) return;
  return invocation;
}
