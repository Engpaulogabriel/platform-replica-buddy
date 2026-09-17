// agent-auth — Token rotativo (FASE 2 da segurança do agente).
// ───────────────────────────────────────────────────────────────────────────
// O agente chama este endpoint no boot e a cada heartbeat (30s), enviando o
// fingerprint do hardware + o token atual (se houver). O servidor:
//   1. localiza o device_licenses ativo por machine_id_hash
//   2. (se veio current_token) valida assinatura+exp+jti e confere o fingerprint
//   3. emite um NOVO JWT HS256 com TTL de 5 min (jti novo = rotação)
//   4. grava current_token_jti/expires_at/last_seen no device_licenses
//
// Anti-clone: hardware divergente tentando usar o token de um device →
// incrementa fingerprint_mismatch_count e retorna 403 (o agente trata como
// não-fatal quando a FASE 2 não está em enforcement).
//
// Segredo de assinatura: env AGENT_TOKEN_SECRET (defina em Supabase → Functions).
// verify_jwt=false (o agente manda apikey anon; a validação é feita aqui).
// ───────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SignJWT, jwtVerify } from "https://esm.sh/jose@5.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const TTL_SECONDS = 300; // 5 min

function fingerprintDivergence(stored: any, incoming: any): number {
  // conta quantos componentes fortes divergem (cpu, disk_serial, uuid)
  if (!stored || !incoming) return 0;
  let n = 0;
  for (const k of ["cpu", "disk_serial", "uuid"]) {
    const a = String(stored?.[k] ?? "").trim();
    const b = String(incoming?.[k] ?? "").trim();
    if (a && b && a !== b) n++;
  }
  return n;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const secretStr = Deno.env.get("AGENT_TOKEN_SECRET");
  if (!secretStr) return json({ ok: false, reason: "server_misconfigured" }, 500);
  const secret = new TextEncoder().encode(secretStr);

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const machineIdHash = String(body?.machine_id_hash ?? "").trim();
  const fingerprint = body?.fingerprint ?? null;
  const currentToken = body?.current_token ?? null;
  const agentVersion = body?.agent_version ?? null;
  if (!machineIdHash) return json({ ok: false, reason: "missing_machine_id_hash" }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  // 1) device ativo por machine_id_hash
  const { data: dev } = await supabase
    .from("device_licenses")
    .select("id, farm_id, machine_id_hash, fingerprint, current_token_jti, revoked_at")
    .eq("machine_id_hash", machineIdHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (!dev) return json({ ok: false, reason: "no_active_license" }, 403);

  // 2) fingerprint anti-clone: se divergir em >=2 componentes fortes, é outro HW
  const diverge = fingerprintDivergence(dev.fingerprint, fingerprint);
  if (diverge >= 2) {
    await supabase.rpc("increment_fingerprint_mismatch", { _device_id: dev.id }).catch(async () => {
      // fallback sem RPC: update direto
      await supabase.from("device_licenses")
        .update({ last_fingerprint_check: new Date().toISOString() })
        .eq("id", dev.id);
    });
    return json({ ok: false, reason: "fingerprint_mismatch", divergence: diverge }, 403);
  }

  // 3) valida token atual (best-effort — não é obrigatório p/ re-emitir; só telemetria)
  let rotatedFrom: string | null = null;
  if (currentToken) {
    try {
      const { payload } = await jwtVerify(currentToken, secret);
      if (payload?.jti && payload.jti === dev.current_token_jti && payload?.fp === machineIdHash) {
        rotatedFrom = String(payload.jti);
      }
    } catch { /* token expirado/inválido → apenas re-emite (re-auth) */ }
  }

  // 4) emite novo JWT (rotação)
  const jti = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ fp: machineIdHash, farm_id: dev.farm_id })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(dev.id)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(now + TTL_SECONDS)
    .sign(secret);

  await supabase.from("device_licenses").update({
    current_token_jti: jti,
    current_token_expires_at: new Date((now + TTL_SECONDS) * 1000).toISOString(),
    last_seen_at: new Date().toISOString(),
    last_fingerprint_check: new Date().toISOString(),
    ...(agentVersion ? { agent_version: agentVersion } : {}),
    ...(ip ? { ip_address: ip } : {}),
    updated_at: new Date().toISOString(),
  }).eq("id", dev.id);

  return json({
    ok: true,
    token,
    next_token: token,
    expires_in: TTL_SECONDS,
    device_id: dev.id,
    farm_id: dev.farm_id,
    rotated: rotatedFrom !== null,
  });
});
