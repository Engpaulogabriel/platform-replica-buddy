// critical-alerts-tick/auth.ts — decisão de autorização do tick.
// ---------------------------------------------------------------------------
// Módulo LOCAL desta Edge Function, não compartilhado. Fica aqui de propósito:
// `_shared/cronAuth.ts` é importado por outras seis funções que ainda não foram
// aprovadas para deploy, e mexer nele mudaria o comportamento delas junto.
// Este arquivo é empacotado no mesmo bundle de `index.ts` e não afeta nada fora
// desta função.
//
// POR QUE EXISTE: a decisão precisa ser testável de verdade (sem segredo → 401,
// segredo errado → 401, V2 válido → autoriza). Dentro de `Deno.serve` isso não
// é testável fora do runtime Deno. Aqui é função pura.
//
// ROTAÇÃO: `cron_invoke()` em produção envia o segredo rotacionado
// `CRON_SECRET_V2`. Durante a janela de rotação os dois valores são válidos.
// Nenhum segredo aparece neste arquivo: os valores vêm sempre de
// `Deno.env.get(...)` no chamador, e daqui só sai o NOME de qual casou.

export type CronAuthReason =
  | "cron_secret"          // casou com CRON_SECRET
  | "cron_secret_v2"       // casou com CRON_SECRET_V2 (rotacionado)
  | "service_role"         // bearer com a service_role key
  | "no_secret_presented"  // requisição sem x-cron-secret nem authorization
  | "secret_mismatch"      // veio credencial, mas não confere
  | "not_configured";      // ambiente sem NENHUM segredo — fecha, não abre

export interface CronAuthEnv {
  cronSecret?: string | null;
  cronSecretV2?: string | null;
  serviceRole?: string | null;
}

export interface CronAuthResult {
  ok: boolean;
  /** rótulo, nunca o valor do segredo — pode ir para log com segurança. */
  reason: CronAuthReason;
  /** quantos segredos existem no ambiente. Diagnostica rotação incompleta. */
  secretsConfigured: number;
}

/** Só precisamos de `.get()`; assim o teste não depende do Headers do Deno. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Autoriza a invocação. Fecha por padrão: qualquer caminho que não case com um
 * segredo CONFIGURADO e NÃO VAZIO devolve `ok: false`.
 *
 * Comparação exata (`===`). Não há prefixo, `startsWith`, normalização,
 * curinga nem fallback permissivo — um segredo vazio jamais entra na lista de
 * candidatos, então "sem segredo" nunca casa com "sem segredo".
 */
export function authorizeCron(headers: HeaderReader, env: CronAuthEnv): CronAuthResult {
  const presented = headers.get("x-cron-secret") ?? "";
  const authHeader = headers.get("authorization") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";

  // Só segredos realmente configurados viram candidatos.
  const candidates: Array<[CronAuthReason, string]> = [];
  if (env.cronSecret && env.cronSecret.length > 0) {
    candidates.push(["cron_secret", env.cronSecret]);
  }
  if (env.cronSecretV2 && env.cronSecretV2.length > 0) {
    candidates.push(["cron_secret_v2", env.cronSecretV2]);
  }
  const serviceRole = env.serviceRole ?? "";
  const secretsConfigured = candidates.length;

  // Ambiente sem nenhuma credencial: FECHA. Falhar aberto aqui deixaria a
  // função pública sempre que um secret sumisse do ambiente.
  if (secretsConfigured === 0 && serviceRole.length === 0) {
    return { ok: false, reason: "not_configured", secretsConfigured };
  }

  if (presented.length > 0) {
    for (const [name, value] of candidates) {
      if (presented === value) return { ok: true, reason: name, secretsConfigured };
    }
  }

  if (serviceRole.length > 0 && bearer.length > 0 && bearer === serviceRole) {
    return { ok: true, reason: "service_role", secretsConfigured };
  }

  return {
    ok: false,
    reason: presented.length > 0 || bearer.length > 0
      ? "secret_mismatch" : "no_secret_presented",
    secretsConfigured,
  };
}
