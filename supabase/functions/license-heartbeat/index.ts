// Edge function: license-heartbeat
// Chamada pelo Electron a cada 1h enquanto online
// Valida JWT, atualiza last_seen_at, retorna NOVO token (rotação)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { create as jwtCreate, verify as jwtVerify, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "missing_token", action: "reactivate" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = auth.slice(7);

    const body = await req.json().catch(() => ({}));
    const machineIdHash = body.machine_id_hash as string | undefined;
    const agentVersion = body.agent_version as string | undefined;

    if (!machineIdHash) {
      return new Response(JSON.stringify({ error: "missing_machine_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const key = await getSigningKey();
    let payload: any;
    try {
      payload = await jwtVerify(token, key);
    } catch (e) {
      return new Response(JSON.stringify({ error: "invalid_token", action: "reactivate" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (payload.machine_id_hash !== machineIdHash) {
      return new Response(JSON.stringify({ error: "machine_mismatch", action: "block" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase.rpc("license_touch_heartbeat", {
      _device_id: payload.sub,
      _machine_id_hash: machineIdHash,
      _agent_version: agentVersion ?? null,
    });

    if (error) {
      return new Response(JSON.stringify({ error: "rpc_failed", detail: error.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = data as { ok: boolean; error?: string; action?: string; token_jti?: string; farm_id?: string };

    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error, action: result.action ?? "block" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rotação de token: emite novo JWT com jti novo
    const newToken = await jwtCreate(
      { alg: "HS256", typ: "JWT" },
      {
        iss: "renov-license",
        sub: payload.sub,
        farm_id: result.farm_id,
        machine_id_hash: machineIdHash,
        jti: result.token_jti,
        iat: getNumericDate(0),
        exp: getNumericDate(60 * 60 * 48),
      },
      key,
    );

    return new Response(JSON.stringify({
      ok: true,
      token: newToken,
      expires_in: 60 * 60 * 48,
      farm_id: result.farm_id,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Unexpected:", err);
    return new Response(JSON.stringify({ error: "internal_error", detail: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
