// _shared/internalAuth.ts — guarda para funções internas que também podem ser
// chamadas por triggers do banco (pg_net) ou pelo agente Electron autenticado.
//
// Aceita, nesta ordem:
//   1) CRON_SECRET / CRON_SECRET_V2 (header x-cron-secret) ou SERVICE_ROLE bearer
//      → via guardCron.
//   2) header x-internal-secret == INTERNAL_ALERT_SECRET (usado pelos triggers
//      do banco que chamam via net.http_post).
//   3) Bearer JWT de usuário REAL (sessão do agente Electron / painel).
//      A anon key NÃO passa: ela não resolve para um usuário.
//
// Qualquer outra coisa (anon key, apikey, query param) é rejeitada com 401.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { guardCron, timingSafeEqual } from "./cronAuth.ts";

const env = (k: string): string => {
  // deno-lint-ignore no-explicit-any
  return ((globalThis as any).Deno?.env?.get(k) ?? "") as string;
};

const unauthorized = (cors: Record<string, string>) =>
  new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: { ...cors, "Content-Type": "application/json" },
  });

/** Guarda somente para chamadas internas (cron/service-role/trigger). */
export function guardInternal(req: Request, cors: Record<string, string> = {}): Response | null {
  if (guardCron(req, cors) === null) return null;

  const internal = env("INTERNAL_ALERT_SECRET").trim();
  const provided = (req.headers.get("x-internal-secret") ?? "").trim();
  if (internal && provided && timingSafeEqual(provided, internal)) return null;

  return unauthorized(cors);
}

/**
 * Igual a guardInternal, mas também aceita um JWT de usuário autenticado real
 * (necessário para o agente Electron, que chama com a sessão do seu usuário).
 */
export async function guardInternalOrUser(
  req: Request,
  cors: Record<string, string> = {},
): Promise<Response | null> {
  if (guardInternal(req, cors) === null) return null;

  const auth = (req.headers.get("authorization") ?? "").trim();
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const anon = env("SUPABASE_ANON_KEY").trim();
  // anon key nunca é identidade.
  if (!token || (anon && timingSafeEqual(token, anon))) return unauthorized(cors);

  try {
    const client = createClient(env("SUPABASE_URL"), anon || token, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data, error } = await client.auth.getUser(token);
    if (!error && data?.user?.id && data.user.role !== "anon") return null;
  } catch (_e) {
    // cai para 401 abaixo
  }
  return unauthorized(cors);
}
