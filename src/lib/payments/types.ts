// Result explícito em vez de exceção: gateway fora do ar é ESPERADO, não
// excepcional. Forçar o chamador a tratar `ok:false` é o que impede um PSP
// indisponível de derrubar a plataforma.

export interface ProviderError {
  code: string;
  message: string;
  /** Se `true`, o chamador pode repetir com a MESMA idempotencyKey. */
  retryable: boolean;
  providerCode?: string | null;
  raw?: Record<string, unknown>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ProviderError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (code: string, message: string, retryable = false,
                     extra: Partial<ProviderError> = {}): Result<never> =>
  ({ ok: false, error: { code, message, retryable, ...extra } });

/** Erros que valem retry: rede e indisponibilidade. Recusa de negócio, não. */
export const RETRYABLE = new Set(["timeout", "network", "provider_unavailable", "rate_limited"]);

/**
 * Executa com timeout. Gateway lento NUNCA pode travar a plataforma —
 * a Sprint 3 já garante que o dado financeiro é derivado, então uma chamada
 * perdida não corrompe nada: só não confirma.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, rotulo: string): Promise<Result<T>> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    const valor = await Promise.race([
      p,
      new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${rotulo}: timeout ${ms}ms`)), ms); }),
    ]);
    return ok(valor as T);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = /timeout/i.test(msg) ? "timeout" : "network";
    return fail(code, msg, true);
  } finally { if (t) clearTimeout(t); }
}
