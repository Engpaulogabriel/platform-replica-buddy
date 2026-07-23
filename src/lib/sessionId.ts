// Identificador ESTÁVEL da sessão (não rotaciona como o refresh_token do Supabase).
// É o `session_id` devolvido pelo login-proxy e gravado em active_sessions.
// Persistimos em localStorage para que sobreviva a reloads e a rotações
// automáticas de refresh_token feitas pelo supabase-js.
const STORAGE_KEY = "renov-active-session-id";

export function getStoredSessionId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredSessionId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* noop */
  }
}

export function clearStoredSessionId(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}
