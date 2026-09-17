// Anti-scraping client helpers.
// - Rastreia navegação/ações do usuário (user_activity_log via RPC log_user_activity)
// - Guarda exportações com rate limit server-side (check_export_rate_limit)
// - Fornece o texto de marca d'água usado nos PDFs

import { supabase } from "@/integrations/supabase/client";

let cachedIdentity: { userId: string | null; email: string | null } = { userId: null, email: null };

export async function refreshIdentity() {
  try {
    const { data } = await supabase.auth.getUser();
    cachedIdentity = { userId: data.user?.id ?? null, email: data.user?.email ?? null };
  } catch {
    /* noop */
  }
  return cachedIdentity;
}

export function getCachedIdentity() {
  return cachedIdentity;
}

/** Marca a identidade corrente (email ou id) para logs/marca d'água. */
export function setUserTag(tag: string | null) {
  if (!tag) {
    cachedIdentity = { userId: null, email: null };
    return;
  }
  if (tag.includes("@")) cachedIdentity = { ...cachedIdentity, email: tag };
  else cachedIdentity = { ...cachedIdentity, userId: tag };
}

/** Registra uma ação/navegação. Nunca lança. */
export async function logActivity(
  action: string,
  path?: string,
  metadata: Record<string, unknown> = {},
  farmId?: string | null,
) {
  try {
    await supabase.rpc("log_user_activity" as any, {
      _action: action,
      _path: path ?? (typeof location !== "undefined" ? location.pathname : null),
      _farm_id: farmId ?? null,
      _metadata: metadata as any,
    });
  } catch {
    /* silencioso */
  }
}

export interface GuardResult {
  allowed: boolean;
  reason?: string;
  hits?: number;
  limit?: number;
}

/**
 * Valida o rate limit de exportação no servidor e registra a exportação.
 * Retorna { allowed:false } quando o limite (20/hora) foi atingido.
 */
export async function guardExport(
  reportType: string,
  format: "pdf" | "csv" | "xlsx" | string,
  rowCount = 0,
  farmId?: string | null,
): Promise<GuardResult> {
  try {
    const { data, error } = await supabase.rpc("check_export_rate_limit" as any, {
      _report_type: reportType,
      _format: format,
      _row_count: rowCount,
      _farm_id: farmId ?? null,
    });
    if (error) return { allowed: true }; // falha do check não bloqueia o usuário legítimo
    const row = (Array.isArray(data) ? data[0] : data) as GuardResult | null;
    if (!row) return { allowed: true };
    return row;
  } catch {
    return { allowed: true };
  }
}

/** Texto de marca d'água (usuário + data) aplicado aos PDFs exportados. */
export function getWatermarkText(): string {
  const { email, userId } = cachedIdentity;
  const who = email ?? (userId ? userId.slice(0, 8) : "usuário");
  const when = new Date().toLocaleString("pt-BR");
  return `${who} • ${when}`;
}
