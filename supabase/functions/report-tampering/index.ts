// Edge function: report-tampering
// ─────────────────────────────────────────────────────────────────────────────
// Recebe relatório de adulteração do agente Electron.
//
// SEGURANÇA: O agente pode estar adulterado, então não confiamos no JWT dele.
// Validação por:
//   1) farm_id + license_key precisam combinar (consulta na tabela farms).
//   2) Header `X-Tamper-Signature` = HMAC-SHA256(LICENSE_SIGNING_SECRET, body_raw)
//      para garantir que o reporte vem de quem possui o segredo compartilhado
//      embutido no agente. Sem essa assinatura, qualquer um conhecendo o
//      farm_id + license_key poderia revogar a licença remotamente (DoS).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-tamper-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface TamperingPayload {
  farm_id: string;
  license_key: string;
  device_license_id?: string;
  kind:
    | "asar_modified"
    | "hardware_changed"
    | "config_replaced"
    | "integrity_check_failed"
    | "unsigned_binary"
    | "other";
  level?: "info" | "warn" | "critical";
  details?: Record<string, unknown>;
  expected_hash?: string;
  actual_hash?: string;
  agent_version?: string;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const rawBody = await req.text();
    const signingSecret = Deno.env.get("LICENSE_SIGNING_SECRET") ?? "";
    if (!signingSecret) {
      console.error("[report-tampering] LICENSE_SIGNING_SECRET não configurado");
      return new Response(JSON.stringify({ error: "server_misconfigured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sigHeader = (req.headers.get("X-Tamper-Signature") ?? "").trim().toLowerCase();
    if (!sigHeader) {
      return new Response(JSON.stringify({ error: "missing_signature" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const expectedSig = await hmacHex(signingSecret, rawBody);
    if (!safeEquals(sigHeader, expectedSig)) {
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let body: TamperingPayload;
    try {
      body = JSON.parse(rawBody) as TamperingPayload;
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!body.farm_id || !body.license_key || !body.kind) {
      return new Response(JSON.stringify({ error: "missing_fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: farm } = await supabase
      .from("farms")
      .select("id")
      .eq("id", body.farm_id)
      .eq("license_key", body.license_key)
      .maybeSingle();

    if (!farm) {
      return new Response(JSON.stringify({ error: "invalid_farm_or_license" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const level =
      body.level ??
      (body.kind === "asar_modified" || body.kind === "config_replaced"
        ? "critical"
        : "warn");

    const { error: insertErr } = await supabase.from("tampering_events").insert({
      farm_id: body.farm_id,
      device_license_id: body.device_license_id ?? null,
      kind: body.kind,
      level,
      details: body.details ?? {},
      expected_hash: body.expected_hash ?? null,
      actual_hash: body.actual_hash ?? null,
      agent_version: body.agent_version ?? null,
    });

    if (insertErr) {
      console.error("insert tampering error:", insertErr);
      return new Response(JSON.stringify({ error: "insert_failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let auto_revoked = false;
    if (
      level === "critical" &&
      (body.kind === "asar_modified" || body.kind === "config_replaced")
    ) {
      const { error: revErr } = await supabase
        .from("device_licenses")
        .update({
          revoked_at: new Date().toISOString(),
          revoked_reason: `Auto-revogado por adulteração: ${body.kind}`,
        })
        .eq("farm_id", body.farm_id)
        .is("revoked_at", null);

      if (!revErr) auto_revoked = true;
    }

    return new Response(JSON.stringify({ ok: true, level, auto_revoked }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("report-tampering error:", err);
    return new Response(
      JSON.stringify({ error: "internal_error", detail: String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
