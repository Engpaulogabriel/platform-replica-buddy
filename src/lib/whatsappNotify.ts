// ─────────────────────────────────────────────────────────────────────────────
// notifyWhatsAppImmediate — chamada direta (sem fila/cron) para qualquer
// notificação disparada do interface web. Deve completar em < 3s.
//
// Implementação: usa functions.invoke como caminho primário e mantém fetch
// direto como fallback explícito. Assim temos o caminho padrão do SDK, mas sem
// perder entrega quando o SDK falhar por sessão/preflight/etc.
//
// DUAL-BACKEND: toda notificação aqui é FARM-SCOPED — a Edge Function recebe um
// farm_id e lê, no SEU projeto, operadores, permissões e estado daquela fazenda.
// Invocá-la no projeto errado não dá erro: ela responde 200 usando os dados
// congelados no cutover. Por isso o farmId é o PRIMEIRO parâmetro, obrigatório,
// e o cliente é resolvido a partir dele — inclusive no fallback por fetch, que
// antes montava a URL com as variáveis do projeto antigo.
// ─────────────────────────────────────────────────────────────────────────────
import {
  assertOperationalClient,
  backendEndpointForFarm,
  BackendRoutingError,
  type RenovSupabase,
} from "@/lib/supabaseRouter";

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
  via: "invoke" | "fetch" | "blocked";
  data: unknown;
  raw: string;
}

/** Resultado quando o backend da fazenda não está acessível. Nunca vira OLD. */
function unavailable(reason: string): WhatsAppNotifyDiagnosticResult {
  return { ok: false, status: 0, via: "blocked", data: reason, raw: reason };
}

async function invokeFunction(
  client: RenovSupabase,
  fnName: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; raw: string }> {
  console.log("[MODE_CHANGE] Calling Edge Function via functions.invoke:", fnName, "Body:", body);
  const { data, error } = await client.functions.invoke(fnName, { body });

  if (error) {
    console.error("[MODE_CHANGE] functions.invoke failed:", error);
    return { ok: false, status: (error as { status?: number })?.status ?? 0, raw: JSON.stringify(error) };
  }

  const raw = typeof data === "string" ? data : JSON.stringify(data ?? null);
  console.log("[MODE_CHANGE] functions.invoke response:", raw.slice(0, 1000));
  return { ok: true, status: 200, raw };
}

async function postToFunction(
  client: RenovSupabase,
  farmId: string,
  fnName: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; raw: string }> {
  // Endpoint do backend DA FAZENDA. Sem isto o fallback anulava o roteamento.
  const endpoint = backendEndpointForFarm(farmId);
  if (!endpoint) return { ok: false, status: 0, raw: "backend da fazenda indisponível" };

  const url = `${endpoint.url}/functions/v1/${fnName}`;
  console.log("[MODE_CHANGE] Calling Edge Function via direct fetch fallback:", fnName, "URL:", url, "Body:", body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: endpoint.anonKey,
    Authorization: `Bearer ${endpoint.anonKey}`,
  };
  // Anexa JWT da sessão DESTE backend quando disponível (não obrigatório — a
  // função tem verify_jwt=false). Um JWT do projeto errado seria rejeitado.
  try {
    const { data } = await client.auth.getSession();
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
  farmId: string | null | undefined,
  payload: Record<string, unknown>,
  options: Pick<ImmediateNotificationOptions, "functionName"> = {},
): Promise<WhatsAppNotifyDiagnosticResult> {
  const fn = options.functionName ?? "whatsapp-automation-notify";
  const body = { ...payload, immediate: true, source: payload.source ?? "Teste Diagnóstico" };

  // FAIL-CLOSED: fazenda migrada sem sessão no backend novo não cai para o antigo.
  let client: RenovSupabase;
  try {
    client = assertOperationalClient(farmId);
  } catch (e) {
    const reason = e instanceof BackendRoutingError
      ? e.message
      : "Não foi possível resolver o servidor desta fazenda.";
    console.error("[MODE_CHANGE] notificação bloqueada — roteamento:", reason);
    return unavailable(reason);
  }

  const first = await invokeFunction(client, fn, body);
  if (first.ok) {
    return { ...first, via: "invoke", data: parseRaw(first.raw) };
  }

  const fallback = await postToFunction(client, farmId as string, fn, body);
  return { ...fallback, via: "fetch", data: parseRaw(fallback.raw) };
}

/**
 * `farmId` é o primeiro parâmetro e é OBRIGATÓRIO: sem fazenda não há decisão de
 * roteamento possível, e a notificação é sempre sobre uma fazenda específica.
 */
export async function notifyWhatsAppImmediate(
  farmId: string | null | undefined,
  type: ImmediateNotificationType,
  payload: Record<string, unknown>,
  options: ImmediateNotificationOptions = {},
): Promise<WhatsAppNotifyDiagnosticResult | void> {
  const fn = options.functionName ?? "whatsapp-automation-notify";
  const body = { ...payload, type, immediate: true, source: payload.source ?? "frontend" };
  console.log("[MODE_CHANGE] notifyWhatsAppImmediate start:", { farmId, type, fn, body, fireAndForget: !!options.fireAndForget });

  const invocation = invokeWhatsAppNotificationDiagnostic(farmId, body, { functionName: fn })
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
