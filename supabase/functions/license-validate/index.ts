// Edge function: license-validate
// Verifica se o token de licença é válido + amarração anti-clone (fingerprint binding).
// O Bearer é o license token do device (HMAC), NÃO um JWT Supabase => verify_jwt = false.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verify as jwtVerify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const MAX_MISMATCHES = 3;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ valid: false, error: "missing_token" }, 401);
    const token = auth.slice(7);

    // Corpo opcional com a identidade de hardware do device
    let body: Record<string, unknown> = {};
    if (req.method !== "GET") {
      try { body = await req.json(); } catch { body = {}; }
    }
    const rawMachineId = typeof body.machine_id === "string" ? body.machine_id : null;
    const providedHash = typeof body.machine_id_hash === "string"
      ? body.machine_id_hash
      : rawMachineId
        ? await sha256Hex(rawMachineId)
        : null;

    const key = await getSigningKey();
    let payload: any;
    try {
      payload = await jwtVerify(token, key);
    } catch {
      return json({ valid: false, error: "invalid_signature" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: device, error } = await supabase
      .from("device_licenses")
      .select("id, farm_id, revoked_at, current_token_jti, machine_id_hash, fingerprint_mismatch_count")
      .eq("id", payload.sub)
      .maybeSingle();

    if (error || !device) return json({ valid: false, error: "device_not_found" }, 401);
    if (device.revoked_at) return json({ valid: false, error: "revoked" }, 403);
    if (device.current_token_jti !== payload.jti) return json({ valid: false, error: "token_superseded" }, 401);

    // ── Amarração anti-clone: o hash de máquina precisa bater com o registrado ──
    if (providedHash) {
      if (providedHash !== device.machine_id_hash) {
        const nextCount = (device.fingerprint_mismatch_count ?? 0) + 1;
        const shouldRevoke = nextCount >= MAX_MISMATCHES;

        await supabase
          .from("device_licenses")
          .update({
            fingerprint_mismatch_count: nextCount,
            last_fingerprint_check: new Date().toISOString(),
            ...(shouldRevoke
              ? { revoked_at: new Date().toISOString(), revoked_reason: "fingerprint_mismatch" }
              : {}),
          })
          .eq("id", device.id);

        await supabase.from("tampering_events").insert({
          device_license_id: device.id,
          farm_id: device.farm_id,
          kind: "hardware_changed",
          level: shouldRevoke ? "critical" : "warn",
          details: {
            expected_prefix: String(device.machine_id_hash).slice(0, 8),
            received_prefix: providedHash.slice(0, 8),
            mismatch_count: nextCount,
            revoked: shouldRevoke,
          },
        });

        return json({
          valid: false,
          error: shouldRevoke ? "revoked_fingerprint_mismatch" : "fingerprint_mismatch",
          mismatch_count: nextCount,
        }, 403);
      }

      // Match: zera contador e marca a checagem
      await supabase
        .from("device_licenses")
        .update({ fingerprint_mismatch_count: 0, last_fingerprint_check: new Date().toISOString() })
        .eq("id", device.id);
    }

    const { data: farm } = await supabase
      .from("farms")
      .select("license_status")
      .eq("id", device.farm_id)
      .maybeSingle();

    if (farm?.license_status === "suspended") return json({ valid: false, error: "farm_suspended" }, 403);

    return json({
      valid: true,
      device_id: device.id,
      farm_id: device.farm_id,
      fingerprint_checked: !!providedHash,
      expires_at: payload.exp,
    });
  } catch (err) {
    console.error("Unexpected:", err);
    return json({ valid: false, error: "internal_error" }, 500);
  }
});
