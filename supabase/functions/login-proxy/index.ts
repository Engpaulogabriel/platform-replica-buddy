// Login Proxy — valida captcha, aplica rate limit por IP, faz o signIn
// server-side com service_role e devolve a sessão ao cliente.
//
// Payload esperado (JSON):
//   { email, password, captcha_v3?, captcha_v2?, device_fp?, user_agent? }
//
// Respostas:
//   200 { session, needs_captcha_v2?: boolean }
//   400 { error: "invalid_input" }
//   401 { error: "invalid_credentials" }
//   428 { error: "captcha_required_v2" }  // v3 score baixo, cliente deve renderizar v2
//   429 { error: "ip_blocked", retry_after_seconds }
//   500 { error: "server_error" }

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { z } from "npm:zod@3";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RECAPTCHA_ENABLED    = (Deno.env.get("RECAPTCHA_ENABLED") ?? "false") === "true";
const RECAPTCHA_V3_SECRET  = Deno.env.get("RECAPTCHA_V3_SECRET_KEY") ?? "";
const RECAPTCHA_V2_SECRET  = Deno.env.get("RECAPTCHA_V2_SECRET_KEY") ?? "";
const RECAPTCHA_V3_MIN     = Number(Deno.env.get("RECAPTCHA_V3_MIN_SCORE") ?? "0.5");

const BodySchema = z.object({
  email:      z.string().trim().email().max(255),
  password:   z.string().min(1).max(200),
  captcha_v3: z.string().max(4000).optional(),
  captcha_v2: z.string().max(4000).optional(),
  device_fp:  z.string().max(200).optional(),
  user_agent: z.string().max(500).optional(),
});

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function getIp(req: Request): string {
  const h = req.headers;
  const raw = h.get("cf-connecting-ip")
    ?? h.get("x-real-ip")
    ?? h.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "0.0.0.0";
  return raw;
}

async function verifyRecaptcha(secret: string, token: string, remoteip: string) {
  const params = new URLSearchParams({ secret, response: token, remoteip });
  const r = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  return await r.json() as { success: boolean; score?: number; "error-codes"?: string[] };
}

async function isIpBlocked(ip: string) {
  const { data } = await admin
    .from("ip_blocks")
    .select("blocked_until, level, reason")
    .eq("ip", ip)
    .maybeSingle();
  if (!data) return null;
  const until = new Date(data.blocked_until).getTime();
  if (until > Date.now()) {
    return { retry_after: Math.ceil((until - Date.now()) / 1000), level: data.level, reason: data.reason };
  }
  return null;
}

async function recordAttempt(ip: string, email: string, success: boolean, reason: string, ua: string, score?: number) {
  await admin.from("login_attempts").insert({
    ip, email, success, reason, user_agent: ua, captcha_score: score ?? null,
  });
}

async function raiseAlertIfNeeded(ip: string, email: string) {
  const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count } = await admin
    .from("login_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip)
    .eq("success", false)
    .gte("created_at", oneHourAgo);

  const fails = count ?? 0;
  if (fails < 5) return;

  if (fails >= 10) {
    const until = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await admin.from("ip_blocks").upsert({
      ip, blocked_until: until, level: 2, reason: `10+ falhas em 1h`, updated_at: new Date().toISOString(),
    });
    await admin.from("security_alerts").insert({
      alert_type: "ip_block_24h",
      ip, email,
      details: { description: `${fails} tentativas de login falharam em 1h` },
      action_taken: "IP bloqueado por 24 horas",
    });
  } else if (fails >= 5) {
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    await admin.from("ip_blocks").upsert({
      ip, blocked_until: until, level: 1, reason: `5+ falhas em 1h`, updated_at: new Date().toISOString(),
    });
    await admin.from("security_alerts").insert({
      alert_type: "ip_block_30min",
      ip, email,
      details: { description: `${fails} tentativas de login falharam em 1h` },
      action_taken: "IP bloqueado por 30 minutos",
    });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
  const ip = getIp(req);

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: jsonHeaders });
    }

    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: "invalid_input" }), { status: 400, headers: jsonHeaders });
    }
    const { email, password, captcha_v3, captcha_v2, device_fp, user_agent } = parsed.data;
    const ua = user_agent ?? req.headers.get("user-agent") ?? "";

    // Rate limit por IP
    const blocked = await isIpBlocked(ip);
    if (blocked) {
      return new Response(
        JSON.stringify({ error: "ip_blocked", retry_after_seconds: blocked.retry_after, reason: blocked.reason }),
        { status: 429, headers: jsonHeaders },
      );
    }

    // Captcha (feature-flag)
    let v3Score: number | undefined;
    if (RECAPTCHA_ENABLED && RECAPTCHA_V3_SECRET) {
      if (!captcha_v3) {
        return new Response(JSON.stringify({ error: "captcha_required_v3" }), { status: 428, headers: jsonHeaders });
      }
      const v3 = await verifyRecaptcha(RECAPTCHA_V3_SECRET, captcha_v3, ip);
      v3Score = v3.score;
      if (!v3.success) {
        await recordAttempt(ip, email, false, "captcha_v3_failed", ua, v3Score);
        return new Response(JSON.stringify({ error: "captcha_required_v2" }), { status: 428, headers: jsonHeaders });
      }
      if ((v3.score ?? 0) < RECAPTCHA_V3_MIN) {
        // score baixo — exige v2
        if (!captcha_v2) {
          return new Response(JSON.stringify({ error: "captcha_required_v2", score: v3.score }), { status: 428, headers: jsonHeaders });
        }
        const v2 = await verifyRecaptcha(RECAPTCHA_V2_SECRET, captcha_v2, ip);
        if (!v2.success) {
          await recordAttempt(ip, email, false, "captcha_v2_failed", ua, v3Score);
          return new Response(JSON.stringify({ error: "captcha_required_v2" }), { status: 428, headers: jsonHeaders });
        }
      }
    }

    // Login via service role
    const { data, error } = await admin.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      await recordAttempt(ip, email, false, error?.message ?? "invalid_credentials", ua, v3Score);
      await raiseAlertIfNeeded(ip, email);
      return new Response(JSON.stringify({ error: "invalid_credentials" }), { status: 401, headers: jsonHeaders });
    }

    await recordAttempt(ip, email, true, "ok", ua, v3Score);

    // Registra sessão ativa (derruba anteriores)
    const sessionId = data.session.refresh_token; // token único da sessão
    try {
      // Revoga anteriores
      await admin
        .from("active_sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("user_id", data.user.id)
        .is("revoked_at", null);
      // Registra atual
      await admin.from("active_sessions").upsert({
        session_id: sessionId,
        user_id: data.user.id,
        device_fp: device_fp ?? null,
        ip,
        user_agent: ua,
        last_seen_at: new Date().toISOString(),
        revoked_at: null,
      });
    } catch (e) {
      console.error("[login-proxy] active_sessions error", e);
    }

    return new Response(
      JSON.stringify({
        session: {
          access_token:  data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at:    data.session.expires_at,
          expires_in:    data.session.expires_in,
          token_type:    data.session.token_type,
          user:          data.user,
        },
        session_id: sessionId,
      }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (e) {
    console.error("[login-proxy] fatal", e);
    return new Response(JSON.stringify({ error: "server_error" }), { status: 500, headers: jsonHeaders });
  }
});
