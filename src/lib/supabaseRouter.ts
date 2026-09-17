// ─────────────────────────────────────────────────────────────────────────────
// supabaseRouter — resolve QUAL backend atende cada fazenda
// ─────────────────────────────────────────────────────────────────────────────
// Regra de ouro: o cliente é resolvido UMA ÚNICA VEZ, no início da operação, a
// partir do farm_id da PRÓPRIA operação — e o objeto retornado é capturado até
// o fim daquele fluxo assíncrono.
//
// NÃO existe Proxy que reavalie a fazenda a cada .from()/.rpc()/.channel().
// Um Proxy assim permitiria que uma operação começasse na Fazenda A e
// terminasse na Fazenda B: commandQueue encadeia ~12 acessos com vários awaits,
// e trocar de fazenda no meio mudaria o destino no meio do caminho.
//
// O export legado `supabase` (integrations/supabase/client) continua sendo o
// cliente ANTIGO. Os 159 importadores atuais seguem inalterados de propósito;
// apenas fluxos explicitamente migrados chamam getSupabaseForFarm().

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabase as oldSupabase } from "@/integrations/supabase/client";
import { isFarmMigrated } from "./migrationRegistry";

export type RenovSupabase = SupabaseClient<Database>;

/** Backend ANTIGO — o singleton histórico, intocado. */
export { oldSupabase };

const NEW_URL = import.meta.env.VITE_SUPABASE_NEW_URL as string | undefined;
const NEW_KEY = import.meta.env.VITE_SUPABASE_NEW_PUBLISHABLE_KEY as string | undefined;

/** O cliente NOVO só existe se as duas variáveis estiverem configuradas. */
export const newSupabase: RenovSupabase | null =
  NEW_URL && NEW_KEY
    ? createClient<Database>(NEW_URL, NEW_KEY, {
        auth: {
          // storageKey própria por project ref (padrão do supabase-js v2):
          // sb-<ref>-auth-token. As duas sessões coexistem sem se sobrescrever.
          storage: typeof localStorage !== "undefined" ? localStorage : undefined,
          persistSession: true,
          autoRefreshToken: true,
        },
      })
    : null;

export function isNewBackendConfigured(): boolean {
  return newSupabase !== null;
}

// ── Estado de autenticação do backend NOVO ───────────────────────────────────
// Mantido em módulo (não em contexto React) porque precisa ser consultável de
// dentro de funções de serviço como commandQueue, que não são componentes.
let _newAuthReady = false;

export function setNewBackendAuthReady(ready: boolean): void {
  _newAuthReady = ready;
}

/** true = há sessão de usuário válida no backend NOVO. */
export function newBackendAuthReady(): boolean {
  return _newAuthReady && newSupabase !== null;
}

/** Sincroniza o flag a partir da sessão realmente presente no cliente NOVO. */
export async function refreshNewBackendAuth(): Promise<boolean> {
  if (!newSupabase) {
    _newAuthReady = false;
    return false;
  }
  try {
    const { data } = await newSupabase.auth.getSession();
    _newAuthReady = Boolean(data?.session?.access_token);
  } catch {
    _newAuthReady = false;
  }
  return _newAuthReady;
}

// ── Resolução de cliente ─────────────────────────────────────────────────────

/** Erro operacional de roteamento. Nunca vira fallback silencioso para OLD. */
export class BackendRoutingError extends Error {
  readonly code: "new_backend_unconfigured" | "new_backend_unauthenticated" | "farm_unknown";
  constructor(code: BackendRoutingError["code"], message: string) {
    super(message);
    this.name = "BackendRoutingError";
    this.code = code;
  }
}

/**
 * LEITURA. Devolve o cliente concreto da fazenda. Capture o retorno e use-o
 * durante todo o fluxo — não chame de novo no meio.
 *
 * Fazenda migrada sem cliente NOVO configurado lança: é preferível a tela
 * mostrar erro a mostrar dado antigo como se fosse atual.
 */
export function getSupabaseForFarm(farmId: string | null | undefined): RenovSupabase {
  if (!isFarmMigrated(farmId)) return oldSupabase;
  if (!newSupabase) {
    throw new BackendRoutingError(
      "new_backend_unconfigured",
      "Backend da fazenda migrada não está configurado neste build.",
    );
  }
  return newSupabase;
}

/**
 * Variante tolerante para hooks de leitura: devolve null em vez de lançar,
 * para o hook exibir estado de indisponibilidade sem quebrar a árvore React.
 * NUNCA devolve o cliente ANTIGO para uma fazenda migrada.
 */
export function tryGetSupabaseForFarm(
  farmId: string | null | undefined,
): { client: RenovSupabase; migrated: boolean } | { client: null; migrated: true; reason: string } {
  if (!isFarmMigrated(farmId)) return { client: oldSupabase, migrated: false };
  if (!newSupabase) {
    return { client: null, migrated: true, reason: "Backend da fazenda migrada não configurado." };
  }
  return { client: newSupabase, migrated: true };
}

/**
 * ESCRITA OPERACIONAL (ON, OFF, Atualizar Status, agent_commands).
 * FAIL-CLOSED: sem farmId, sem cliente ou sem sessão no NOVO, lança.
 * Jamais devolve OLD para uma fazenda migrada.
 */
export function assertOperationalClient(farmId: string | null | undefined): RenovSupabase {
  if (!farmId) {
    throw new BackendRoutingError(
      "farm_unknown",
      "Operação sem fazenda identificada — comando recusado.",
    );
  }
  if (!isFarmMigrated(farmId)) return oldSupabase;
  if (!newSupabase) {
    throw new BackendRoutingError(
      "new_backend_unconfigured",
      "Backend da fazenda migrada não está configurado neste build.",
    );
  }
  if (!newBackendAuthReady()) {
    throw new BackendRoutingError(
      "new_backend_unauthenticated",
      "Esta fazenda foi migrada para o novo servidor. Saia e entre novamente para habilitar o controle remoto.",
    );
  }
  return newSupabase;
}

/** Rótulo curto para telemetria/log e para os testes de roteamento. */
export function backendLabelForFarm(farmId: string | null | undefined): "NEW" | "OLD" {
  return isFarmMigrated(farmId) ? "NEW" : "OLD";
}

// ── Dual auth ────────────────────────────────────────────────────────────────
/**
 * Autentica no backend NOVO com as MESMAS credenciais, logo após o login normal.
 * A senha é usada e descartada — nada é armazenado, e o JWT do backend antigo
 * nunca é enviado ao novo (chaves de assinatura diferentes; provado: PGRST301).
 *
 * Falhar aqui NUNCA bloqueia o acesso às fazendas do backend antigo: apenas
 * deixa newBackendAuthReady() em false, e as fazendas migradas ficam
 * fail-closed para escrita.
 */
export async function signInNewBackend(email: string, password: string): Promise<boolean> {
  if (!newSupabase) { setNewBackendAuthReady(false); return false; }
  try {
    const { data, error } = await newSupabase.auth.signInWithPassword({ email, password });
    const ok = !error && Boolean(data?.session?.access_token);
    setNewBackendAuthReady(ok);
    return ok;
  } catch {
    setNewBackendAuthReady(false);
    return false;
  }
}

/** Encerra a sessão do backend novo (usar junto do logout principal). */
export async function signOutNewBackend(): Promise<void> {
  setNewBackendAuthReady(false);
  if (!newSupabase) return;
  try { await newSupabase.auth.signOut(); } catch { /* noop */ }
}

// Sessão pré-existente (ex.: usuário que já estava logado quando o deploy saiu,
// ou que recarregou a página): sincroniza o flag a partir do que está no storage.
void refreshNewBackendAuth();
