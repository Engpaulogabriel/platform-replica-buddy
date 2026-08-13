// _shared/security.ts — helpers do sistema anti-IA/anti-scraping.
// Importado por api-rate-limiter e security-anomaly-watchdog.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-renov-agent",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// X-Robots-Tag em TODA resposta (defesa em profundidade; o CDN também deve setar).
export const securityHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
};

export function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: securityHeaders });
}

// User-agents de crawlers de IA a bloquear (camada pública, antes do login).
const AI_BOT_UA = /(GPTBot|ChatGPT-User|OAI-SearchBot|Google-Extended|CCBot|Bytespider|Amazonbot|PerplexityBot|ClaudeBot|Claude-Web|anthropic-ai|Anthropic|Applebot-Extended|Diffbot|Omgili|ImagesiftBot|cohere-ai|YouBot)/i;
export function isAiBot(ua: string | null): boolean {
  return !!ua && AI_BOT_UA.test(ua);
}

// User-agents normais de browser — NUNCA bloquear (whitelist).
const BROWSER_UA = /(Mozilla\/5\.0.*(Chrome|Safari|Firefox|Edg|Edge|OPR|Opera)|Chrome|Safari|Firefox|Edg)/i;
export function looksLikeBrowser(ua: string | null): boolean {
  return !!ua && BROWSER_UA.test(ua) && !isAiBot(ua);
}

// Whitelist de chamadas internas que NÃO passam por rate-limit:
//  • service_role key (apikey == service_role)
//  • Agente Electron: header x-renov-agent OU JWT com claim `fp` (token da FASE 2)
export function isWhitelisted(req: Request, serviceKey: string | undefined): boolean {
  const apikey = req.headers.get("apikey") ?? "";
  if (serviceKey && apikey === serviceKey) return true;
  if (req.headers.get("x-renov-agent")) return true;
  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  const claims = decodeJwtPayload(jwt);
  if (claims && (claims.fp || claims.role === "service_role")) return true;
  return false;
}

// Decode SEM verificar assinatura — só para ler claims (user_id, fp). A autorização
// real é a RLS/edge; aqui é só roteamento (whitelist/identidade).
export function decodeJwtPayload(jwt: string): any | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(pad));
  } catch { return null; }
}
export function userIdFromReq(req: Request): string | null {
  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  const c = decodeJwtPayload(jwt);
  return (c && (c.sub || c.user_id)) || null;
}

export function clientIp(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("cf-connecting-ip") ?? null;
}

// Alerta WhatsApp aos super_admins (pipeline direto via whatsapp_config).
export async function alertSuperAdmins(supabase: any, title: string, farmName: string, detail: string, extra: string): Promise<void> {
  try {
    const { data: cfg } = await supabase.from("whatsapp_config")
      .select("api_token, phone_number_id")
      .not("api_token", "is", null).not("phone_number_id", "is", null)
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!cfg?.api_token || !cfg?.phone_number_id) return;

    const { data: ops } = await supabase.from("whatsapp_operators")
      .select("phone, role, is_active")
      .eq("is_active", true);
    let recipients = ((ops ?? []) as any[])
      .filter((o) => o.phone && String(o.role ?? "").toLowerCase() === "super_admin")
      .map((o) => String(o.phone).replace(/\D/g, ""));
    // Fallback: sufixos confirmados dos super_admins.
    if (recipients.length === 0) {
      recipients = ((ops ?? []) as any[])
        .filter((o) => o.phone && /(99608294|81503951)$/.test(String(o.phone).replace(/\D/g, "")))
        .map((o) => String(o.phone).replace(/\D/g, ""));
    }
    if (recipients.length === 0) return;

    const params = [title, farmName, detail, extra]
      .map((s) => String(s).replace(/[\r\n\t]+/g, " ").slice(0, 1000));
    for (const to of recipients) {
      await fetch(`https://graph.facebook.com/v20.0/${cfg.phone_number_id}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.api_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp", to, type: "template",
          template: { name: "alerta_equipamento", language: { code: "pt_BR" },
            components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }] },
        }),
      }).catch(() => {});
    }
  } catch (_) { /* alerta é best-effort */ }
}
