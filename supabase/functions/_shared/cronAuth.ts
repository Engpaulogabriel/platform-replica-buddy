// _shared/cronAuth.ts — guarda das funções agendadas.
// ---------------------------------------------------------------------------
// Estas funções rodam com `verify_jwt = false` porque o pg_cron não tem sessão
// de usuário. Hoje elas aceitam a ANON KEY — que é pública por definição (vai
// no bundle do frontend). Na prática, qualquer pessoa consegue disparar
// desligamento programado, watchdogs e alertas.
//
// A guarda exige um segredo próprio, `CRON_SECRET`, que existe apenas como
// secret de ambiente da Edge Function e no Vault do banco. Aceita também a
// SERVICE_ROLE key, que já é usada legitimamente e nunca sai do servidor.
//
// NÃO aceita: anon key, JWT de usuário comum, query parameter, Origin,
// Referer, IP ou user-agent. Nada disso é autenticação.
//
// O segredo nunca é logado, nunca volta na resposta e nunca vai para migration.

/** Comparação de tempo constante — não vaza o prefixo correto pelo tempo. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  // Compara SEMPRE o mesmo número de bytes; diferença de tamanho vira flag,
  // não atalho de saída.
  const len = Math.max(ea.length, eb.length);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export interface CronAuthEnv {
  cronSecret?: string | null;
  serviceRoleKey?: string | null;
}

export type CronAuthResult =
  | { ok: true; via: "cron_secret" | "service_role" }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * Decide se a requisição pode executar a função agendada.
 * PURA: recebe headers e env, não toca em Deno nem em rede — é isso que
 * torna a regra testável de verdade.
 */
export function isAuthorizedCron(headers: Headers, env: CronAuthEnv): CronAuthResult {
  const secret = (env.cronSecret ?? "").trim();
  const service = (env.serviceRoleKey ?? "").trim();

  // Sem CRON_SECRET configurado, FECHA. Falhar aberto aqui devolveria
  // exatamente o buraco que estamos corrigindo.
  if (!secret) return { ok: false, status: 403, reason: "cron_secret_not_configured" };

  const provided = (headers.get("x-cron-secret") ?? "").trim();
  if (provided && timingSafeEqual(provided, secret)) return { ok: true, via: "cron_secret" };

  // Credencial interna de serviço, que já é usada legitimamente.
  const auth = (headers.get("authorization") ?? "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (service && bearer && timingSafeEqual(bearer, service)) {
    return { ok: true, via: "service_role" };
  }

  // anon key, JWT de usuário, apikey, query param: nada disso passa.
  return { ok: false, status: provided ? 403 : 401, reason: provided ? "invalid_cron_secret" : "missing_cron_secret" };
}

/**
 * Atalho para o topo de cada função: devolve uma Response quando bloqueado, ou
 * `null` para seguir. Não inclui detalhe do segredo na saída.
 */
export function guardCron(req: Request, cors: Record<string, string> = {}): Response | null {
  const res = isAuthorizedCron(req.headers, {
    // deno-lint-ignore no-explicit-any
    cronSecret: (globalThis as any).Deno?.env?.get("CRON_SECRET"),
    // deno-lint-ignore no-explicit-any
    serviceRoleKey: (globalThis as any).Deno?.env?.get("SUPABASE_SERVICE_ROLE_KEY"),
  });
  if (res.ok) return null;
  // Corpo genérico de propósito: não confirma se o segredo existe, qual o
  // tamanho, nem quão perto o chute chegou.
  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: res.status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
