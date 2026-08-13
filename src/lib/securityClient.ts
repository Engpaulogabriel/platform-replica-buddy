// securityClient.ts — callers do sistema anti-scraping (chamam a edge api-rate-limiter)
// + watermark de PDF. Best-effort: nunca quebra a UX (falha → segue).
//
// Como usar:
//   • Navegação (auditoria): chame logActivity(location.pathname) num efeito de
//     mudança de rota (ex.: no App, useEffect em useLocation()).
//   • Rate-limit opcional: checkRate('api') antes de rajadas; checkRate('export')
//     antes de exportar. (O grosso da contenção é a RLS — ver instruções.)
//   • Export: chame guardExport('pdf', nome) ANTES de gerar; se allowed=false,
//     avise o usuário e não gere. Depois de gerar o PDF, aplique watermarkPdf(doc, email).
import { supabase } from "@/integrations/supabase/client";

function getSessionId(): string {
  try {
    let sid = sessionStorage.getItem("renov_sid");
    if (!sid) { sid = crypto.randomUUID(); sessionStorage.setItem("renov_sid", sid); }
    return sid;
  } catch { return "no-session"; }
}

async function call(body: Record<string, unknown>): Promise<any> {
  try {
    const { data } = await supabase.functions.invoke("api-rate-limiter", {
      body: { ...body, session_id: getSessionId() },
    });
    return data ?? { ok: true };
  } catch {
    return { ok: true, degraded: true }; // fail-open: guarda nunca bloqueia a app
  }
}

/** Auditoria de navegação (user_activity_log). Fire-and-forget. */
export function logActivity(path: string, method = "GET"): void {
  void call({ action: "log", path, method });
}

/** Rate-limit por sessão. cls: 'api' (300/min) | 'export' (30/min). */
export async function checkRate(cls: "api" | "export" = "api"): Promise<{ allowed: boolean; blocked_until?: string }> {
  const r = await call({ action: "rate", class: cls });
  return { allowed: r?.ok !== false, blocked_until: r?.blocked_until };
}

/** Limite de exportação (10 pdf/h · 30 csv/dia; admin 3x). Chame ANTES de gerar. */
export async function guardExport(exportType: "pdf" | "csv", fileName?: string): Promise<{ allowed: boolean; used?: number; limit?: number }> {
  const r = await call({ action: "export", export_type: exportType, file_name: fileName });
  return { allowed: r?.ok !== false, used: r?.used, limit: r?.limit };
}

/**
 * Watermark de atribuição em cada página de um jsPDF. Rodapé em fonte 1pt, cor
 * quase-branca (invisível em tela/impressão comum, mas legível ao dar zoom/copiar).
 * Passe o email/id do usuário logado. Best-effort: não lança.
 */
export function watermarkPdf(doc: any, userTag: string): void {
  try {
    const stamp = `RENOV • ${userTag} • ${new Date().toISOString()}`;
    const pages = doc.internal.getNumberOfPages();
    const w = doc.internal.pageSize.getWidth();
    const h = doc.internal.pageSize.getHeight();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFontSize(1);
      doc.setTextColor(252, 252, 252); // quase branco
      // repete ao longo do rodapé p/ sobreviver a recortes
      doc.text(stamp, 4, h - 2);
      doc.text(stamp, w / 2, h - 2);
    }
    // restaura defaults comuns p/ não afetar quem continuar desenhando
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(10);
  } catch { /* nunca quebra a exportação */ }
}
