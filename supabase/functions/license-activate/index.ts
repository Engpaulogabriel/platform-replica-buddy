// Edge function: license-activate
// Chamada pelo Electron .exe na 1ª inicialização ou após troca de PC
// Recebe license_key + machine fingerprint, retorna JWT assinado HMAC

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { create as jwtCreate, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ActivatePayload {
  license_key: string;
  machine_id_hash: string;        // SHA-256 de cpuId+diskSerial+macAddr (já hasheado pelo Electron)
  fingerprint?: {
    cpu?: string;
    disk_serial?: string;
    mac_addresses?: string[];
    hostname?: string;
    os?: string;
    arch?: string;
  };
  agent_version?: string;
}

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
    const body = (await req.json()) as ActivatePayload;
    if (!body.license_key || typeof body.license_key !== "string" || body.license_key.length < 8) {
      return new Response(JSON.stringify({ error: "invalid_license_key" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!body.machine_id_hash || body.machine_id_hash.length < 16) {
      return new Response(JSON.stringify({ error: "invalid_machine_id_hash" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Captura IP de origem
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    const { data, error } = await supabase.rpc("license_register_device", {
      _license_key: body.license_key,
      _machine_id_hash: body.machine_id_hash,
      _fingerprint: body.fingerprint ?? {},
      _agent_version: body.agent_version ?? null,
      _ip_address: ip,
    });

    if (error) {
      console.error("RPC error:", error);
      return new Response(JSON.stringify({ error: "rpc_failed", detail: error.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = data as { ok: boolean; error?: string; message?: string; device_id?: string; farm_id?: string; token_jti?: string };

    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error, message: result.message }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Gera JWT HMAC válido por 48h. Renovado a cada heartbeat.
    const key = await getSigningKey();
    const token = await jwtCreate(
      { alg: "HS256", typ: "JWT" },
      {
        iss: "renov-license",
        sub: result.device_id,
        farm_id: result.farm_id,
        machine_id_hash: body.machine_id_hash,
        jti: result.token_jti,
        iat: getNumericDate(0),
        exp: getNumericDate(60 * 60 * 48), // 48h
      },
      key,
    );

    return new Response(JSON.stringify({
      ok: true,
      device_id: result.device_id,
      farm_id: result.farm_id,
      token,
      expires_in: 60 * 60 * 48,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({ error: "internal_error", detail: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
