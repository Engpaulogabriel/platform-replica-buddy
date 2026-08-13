// api-rate-limiter — guarda por request autenticada (chamada pelo client).
// ───────────────────────────────────────────────────────────────────────────
// action:
//   'log'    → registra em user_activity_log (path, method, ip, ua, session).
//   'rate'   → check_and_bump_rate_limit (300/min api · 30/min export). 429 se
//              estourar; registra flag 'rate_limited'; WhatsApp na 3ª reincidência.
//   'export' → check_export_limit (10 pdf/h · 30 csv/dia; admin 3x) + export_log.
//
// COBERTURA (honesto): só cobre o que o client roteia por AQUI. Leituras diretas
// ao PostgREST não passam. A contenção de massa é a RLS. verify_jwt=false: a
// identidade vem do JWT (claim sub) e a whitelist trata service_role/agente.
// UA de IA → 403 vazio (camada pública). Browser normal e agente Electron passam.
// ───────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders, securityHeaders, jsonResp, isAiBot, isWhitelisted,
  userIdFromReq, clientIp, alertSuperAdmins,
} from "../_shared/security.ts";

const RATE_API_PER_MIN = 300;
const RATE_EXPORT_PER_MIN = 30;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const ua = req.headers.get("user-agent");
  // 6) bloqueio de crawlers de IA (403 corpo vazio) — antes de qualquer coisa.
  if (isAiBot(ua)) return new Response("", { status: 403, headers: securityHeaders });

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Whitelist: agente Electron / service_role não são limitados nem logados.
  if (isWhitelisted(req, serviceKey)) return jsonResp({ ok: true, whitelisted: true });

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const action = String(body?.action ?? "log");
  const userId = userIdFromReq(req);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey!);

  try {
    if (action === "rate") {
      const isExport = String(body?.class ?? "api") === "export";
      const endpoint = isExport ? "export" : "api";
      const limit = isExport ? RATE_EXPORT_PER_MIN : RATE_API_PER_MIN;
      const { data: r } = await supabase.rpc("check_and_bump_rate_limit", {
        _user_id: userId, _endpoint: endpoint, _limit: limit, _window_seconds: 60,
      });
      const res = (r ?? {}) as any;
      if (res.allowed === false) {
        // registra a violação no activity log
        await supabase.from("user_activity_log").insert({
          user_id: userId, session_id: body?.session_id ?? null, path: body?.path ?? endpoint,
          method: body?.method ?? "RATE", ip: clientIp(req), user_agent: ua, flag: "rate_limited",
        });
        // 3ª reincidência no dia → alerta WhatsApp
        if ((res.daily_violations ?? 0) >= 3 || res.reason === "blocked") {
          await alertSuperAdmins(supabase, "🚨 Rate-limit / possível scraping",
            "Plataforma RENOV", `Usuário ${String(userId).slice(0, 8)} bloqueado por excesso de requests (${endpoint}).`,
            res.blocked_until ? `Bloqueado até ${new Date(res.blocked_until).toLocaleString("pt-BR")}` : "Reincidência no dia");
        }
        return new Response(JSON.stringify({ ok: false, ...res }), {
          status: 429, headers: { ...securityHeaders, "Retry-After": "60" },
        });
      }
      return jsonResp({ ok: true, ...res });
    }

    if (action === "export") {
      const type = String(body?.export_type ?? "pdf").toLowerCase();
      const { data: r } = await supabase.rpc("check_export_limit", { _user_id: userId, _export_type: type });
      const res = (r ?? {}) as any;
      if (res.allowed === false) {
        await supabase.from("user_activity_log").insert({
          user_id: userId, session_id: body?.session_id ?? null, path: `export:${type}`,
          method: "EXPORT", ip: clientIp(req), user_agent: ua, flag: "export_limited",
        });
        return new Response(JSON.stringify({ ok: false, ...res }), { status: 429, headers: securityHeaders });
      }
      // registra o export concedido (com watermark aplicado no client)
      await supabase.from("export_log").insert({
        user_id: userId, export_type: type, file_name: String(body?.file_name ?? "").slice(0, 200) || null,
      });
      return jsonResp({ ok: true, ...res });
    }

    // action 'log' (default) — auditoria de navegação
    await supabase.from("user_activity_log").insert({
      user_id: userId, session_id: body?.session_id ?? null,
      path: String(body?.path ?? "").slice(0, 500) || null, method: body?.method ?? "GET",
      ip: clientIp(req), user_agent: ua, flag: body?.flag ?? null,
    });
    return jsonResp({ ok: true });
  } catch (e) {
    // Guarda NUNCA quebra a app: em erro, deixa passar (fail-open) e loga no console.
    console.error("[api-rate-limiter]", e instanceof Error ? e.message : String(e));
    return jsonResp({ ok: true, degraded: true });
  }
});
