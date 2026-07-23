// Edge function: license-provision
// ------------------------------------------------------------------
// Chamada UMA ÚNICA VEZ pelo agente Electron no primeiro boot.
//
// Recebe:
//   - provisioning_token (PROV-XXXX-XXXX-XXXX-XXXX) embutido no provisioning.json
//   - machine_id_hash (SHA-256 hardware do PC do cliente)
//   - fingerprint (CPU, disco, MAC)
//   - agent_version
//
// Devolve credenciais COMPLETAS para o agente operar 100% autônomo:
//   - email + senha do usuário automático (a senha NUNCA mais sai daqui)
//   - role: agent_writer na fazenda
//   - device_id + farm_id + JWT da licença (48h)
//
// O token é one-shot: marca consumed_at e nunca mais funciona.
// ------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { create as jwtCreate, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ProvisionPayload {
  provisioning_token: string;
  machine_id_hash: string;
  fingerprint?: Record<string, unknown>;
  agent_version?: string;
}

function generateSecurePassword(): string {
  // 32 chars hex (128 bits de entropia) — nunca digitada por humano
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
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
    const body = (await req.json()) as ProvisionPayload;

    // Validação
    if (!body.provisioning_token || !/^PROV-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(body.provisioning_token)) {
      return new Response(JSON.stringify({ error: "invalid_token_format" }), {
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

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    // 1) Busca e valida token (ainda não consumido, não revogado, não expirado)
    const { data: tokenRow, error: tokenErr } = await supabase
      .from("provisioning_tokens")
      .select("id, farm_id, consumed_at, revoked_at, expires_at")
      .eq("token", body.provisioning_token)
      .maybeSingle();

    if (tokenErr || !tokenRow) {
      return new Response(JSON.stringify({ error: "token_not_found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (tokenRow.consumed_at) {
      return new Response(JSON.stringify({ error: "token_already_used", consumed_at: tokenRow.consumed_at }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (tokenRow.revoked_at) {
      return new Response(JSON.stringify({ error: "token_revoked" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
      return new Response(JSON.stringify({ error: "token_expired" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const farmId = tokenRow.farm_id as string;

    // 2) Busca licença da fazenda
    const { data: farm, error: farmErr } = await supabase
      .from("farms")
      .select("id, name, license_key, license_status")
      .eq("id", farmId)
      .single();

    if (farmErr || !farm || !farm.license_key) {
      return new Response(JSON.stringify({ error: "farm_or_license_missing" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3) Garantir credencial automática para a fazenda
    let { data: cred } = await supabase
      .from("agent_credentials")
      .select("id, auth_user_id, email")
      .eq("farm_id", farmId)
      .maybeSingle();

    let agentEmail: string;
    let agentPassword: string = generateSecurePassword();
    let agentUserId: string;

    if (!cred) {
      // Cria usuário novo: agente-<farmIdShort>@agents.renov.internal
      const farmIdShort = farmId.slice(0, 8);
      agentEmail = `agente-${farmIdShort}@agents.renov.internal`;

      const { data: newUser, error: userErr } = await supabase.auth.admin.createUser({
        email: agentEmail,
        password: agentPassword,
        email_confirm: true,
        user_metadata: { kind: "agent", farm_id: farmId },
      });

      if (userErr || !newUser.user) {
        console.error("createUser error:", userErr);
        return new Response(JSON.stringify({ error: "user_create_failed", detail: userErr?.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      agentUserId = newUser.user.id;

      // Profile
      await supabase.from("profiles").upsert({
        id: agentUserId,
        email: agentEmail,
        full_name: `Agente ${farm.name}`,
        default_farm_id: farmId,
      });

      // Role agent_writer (se enum não existir, cai pra writer/operator)
      // Tentamos vários até funcionar
      const candidateRoles = ["agent_writer", "writer", "operator"];
      let roleSet = false;
      for (const r of candidateRoles) {
        const { error: roleErr } = await supabase.from("user_roles").insert({
          user_id: agentUserId,
          farm_id: farmId,
          role: r,
        });
        if (!roleErr) { roleSet = true; break; }
      }
      if (!roleSet) {
        console.warn("Não consegui setar role pro agente");
      }

      await supabase.from("agent_credentials").insert({
        farm_id: farmId,
        auth_user_id: agentUserId,
        email: agentEmail,
      });
    } else {
      // Já existe — rotaciona a senha
      agentUserId = cred.auth_user_id;
      agentEmail = cred.email;

      const { error: pwErr } = await supabase.auth.admin.updateUserById(agentUserId, {
        password: agentPassword,
      });
      if (pwErr) {
        console.error("password rotate error:", pwErr);
        return new Response(JSON.stringify({ error: "password_rotate_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await supabase
        .from("agent_credentials")
        .update({ rotated_at: new Date().toISOString() })
        .eq("farm_id", farmId);
    }

    // 4) Ativa licença (chama a RPC que já existe)
    const { data: actData, error: actErr } = await supabase.rpc("license_register_device", {
      _license_key: farm.license_key,
      _machine_id_hash: body.machine_id_hash,
      _fingerprint: body.fingerprint ?? {},
      _agent_version: body.agent_version ?? null,
      _ip_address: ip,
    });

    if (actErr) {
      console.error("license_register_device error:", actErr);
      return new Response(JSON.stringify({ error: "license_activation_failed", detail: actErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const actResult = actData as { ok: boolean; error?: string; message?: string; device_id?: string; farm_id?: string; token_jti?: string };
    if (!actResult.ok) {
      return new Response(JSON.stringify({ error: actResult.error, message: actResult.message }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5) Gera JWT da licença
    const key = await getSigningKey();
    const licenseJwt = await jwtCreate(
      { alg: "HS256", typ: "JWT" },
      {
        iss: "renov-license",
        sub: actResult.device_id,
        farm_id: actResult.farm_id,
        machine_id_hash: body.machine_id_hash,
        jti: actResult.token_jti,
        iat: getNumericDate(0),
        exp: getNumericDate(60 * 60 * 48),
      },
      key,
    );

    // 6) Marca token como consumido
    await supabase
      .from("provisioning_tokens")
      .update({
        consumed_at: new Date().toISOString(),
        consumed_by_machine_hash: body.machine_id_hash,
        consumed_ip: ip,
      })
      .eq("id", tokenRow.id);

    // 7) Devolve TUDO que o agente precisa pra rodar
    return new Response(JSON.stringify({
      ok: true,
      farm_id: farmId,
      farm_name: farm.name,
      device_id: actResult.device_id,
      // Credenciais Supabase Auth (vão pro Credential Manager Windows via DPAPI)
      auth: {
        email: agentEmail,
        password: agentPassword,
      },
      // JWT da licença (48h)
      license: {
        token: licenseJwt,
        expires_in: 60 * 60 * 48,
      },
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("license-provision error:", err);
    return new Response(JSON.stringify({ error: "internal_error", detail: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
