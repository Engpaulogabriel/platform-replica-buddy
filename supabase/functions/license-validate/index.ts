// Edge function: license-validate
// Verifica rapidamente se um token é válido (usado em chamadas críticas)
// Não atualiza last_seen — apenas valida assinatura HMAC + status atual

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verify as jwtVerify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

async function getSigningKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("LICENSE_SIGNING_SECRET");
  if (!secret) throw new Error("LICENSE_SIGNING_SECRET not configured");
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ valid: false, error: "missing_token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = auth.slice(7);

    const key = await getSigningKey();
    let payload: any;
    try {
      payload = await jwtVerify(token, key);
    } catch {
      return new Response(JSON.stringify({ valid: false, error: "invalid_signature" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Confere se device ainda está ativo + token_jti bate (anti-replay)
    const { data: device, error } = await supabase
      .from("device_licenses")
      .select("id, farm_id, revoked_at, current_token_jti")
      .eq("id", payload.sub)
      .maybeSingle();

    if (error || !device) {
      return new Response(JSON.stringify({ valid: false, error: "device_not_found" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (device.revoked_at) {
      return new Response(JSON.stringify({ valid: false, error: "revoked" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (device.current_token_jti !== payload.jti) {
      return new Response(JSON.stringify({ valid: false, error: "token_superseded" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Confere status da fazenda
    const { data: farm } = await supabase
      .from("farms")
      .select("license_status")
      .eq("id", device.farm_id)
      .maybeSingle();

    if (farm?.license_status === "suspended") {
      return new Response(JSON.stringify({ valid: false, error: "farm_suspended" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      valid: true,
      device_id: device.id,
      farm_id: device.farm_id,
      expires_at: payload.exp,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Unexpected:", err);
    return new Response(JSON.stringify({ valid: false, error: "internal_error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
