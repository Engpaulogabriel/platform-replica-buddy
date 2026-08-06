// Edge function: license-validate
// Verifica rapidamente se um token e valido (usado em chamadas criticas)
// Nao atualiza last_seen — apenas valida assinatura HMAC + status atual.
//
// v3.25.45 — AMARRACAO SERVER-SIDE ANTI-CLONE:
// O agente envia machine_id_hash + fingerprint no corpo. Comparamos com o device
// registrado (device_licenses). Se o hardware diverge em >=2 dos 4 componentes
// (cpu, disco, uuid da placa-mae, MAC) -> 403 machine_mismatch. Isso mata um clone
// que copiou o token/config para OUTRO PC — enforcement server-side, o atacante
// nao patcheia. Tolerancia de 1 componente (troca legitima de NIC/disco) so
// atualiza o fingerprint registrado (drift), sem bloquear. Retrocompativel:
// agente antigo que nao manda fingerprint segue validando como antes.

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

// Conta em quantos dos 4 componentes-nucleo o hardware diverge. Ignora um
// componente quando qualquer lado esta vazio (nao da pra comparar) — mesma
// politica do diffHardware client-side. MAC diverge se NAO ha nenhuma
// interseccao entre as listas (troca de NIC muda a lista mas mantem outras).
function countHardwareDiffs(cur: any, reg: any): number {
  if (!cur || !reg) return 0;
  let diffs = 0;
  const scalar = (a: unknown, b: unknown) => {
    const x = String(a ?? "").trim();
    const y = String(b ?? "").trim();
    return x && y && x !== y;
  };
  if (scalar(cur.cpu, reg.cpu)) diffs++;
  if (scalar(cur.disk_serial, reg.disk_serial)) diffs++;
  if (scalar(cur.uuid, reg.uuid)) diffs++;
  const curMacs: string[] = Array.isArray(cur.mac_addresses) ? cur.mac_addresses.map((m: string) => String(m).toLowerCase()) : [];
  const regMacs: string[] = Array.isArray(reg.mac_addresses) ? reg.mac_addresses.map((m: string) => String(m).toLowerCase()) : [];
  if (curMacs.length && regMacs.length) {
    const overlap = curMacs.some((m) => regMacs.includes(m));
    if (!overlap) diffs++;
  }
  return diffs;
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

    // Corpo opcional (agentes antigos nao mandam) — anti-clone usa se presente.
    const body = await req.json().catch(() => ({} as any));
    const incomingHash: string = typeof body?.machine_id_hash === "string" ? body.machine_id_hash : "";
    const incomingFp = body?.fingerprint && typeof body.fingerprint === "object" ? body.fingerprint : null;

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

    // Confere se device ainda esta ativo + token_jti bate (anti-replay) + hardware.
    const { data: device, error } = await supabase
      .from("device_licenses")
      .select("id, farm_id, revoked_at, current_token_jti, machine_id_hash, fingerprint, fingerprint_mismatch_count")
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

    // ── AMARRACAO ANTI-CLONE (server-side) ──────────────────────────────────
    // So aplica se o agente mandou fingerprint E o device tem um registrado.
    if (incomingHash && device.machine_id_hash) {
      const sameHash = incomingHash === device.machine_id_hash;
      if (!sameHash) {
        const diffs = incomingFp ? countHardwareDiffs(incomingFp, device.fingerprint) : 99;
        if (diffs >= 2) {
          // CLONE: outro PC. Registra e bloqueia (o agente honra apos strikes).
          await supabase.from("device_licenses").update({
            fingerprint_mismatch_count: (device.fingerprint_mismatch_count ?? 0) + 1,
            last_fingerprint_check: new Date().toISOString(),
          }).eq("id", device.id);
          try {
            await supabase.from("agent_logs").insert({
              farm_id: device.farm_id, level: "error", category: "security",
              message: `CLONE BLOQUEADO (license-validate): hardware diverge em ${diffs} componentes. Device=${String(device.machine_id_hash).slice(0, 12)} tentativa=${String(incomingHash).slice(0, 12)}`,
            });
          } catch (_) { /* agent_logs best-effort */ }
          return new Response(JSON.stringify({ valid: false, error: "machine_mismatch", diffs }), {
            status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        // Drift de 0-1 componente (troca legitima): atualiza o registrado, nao bloqueia.
        await supabase.from("device_licenses").update({
          machine_id_hash: incomingHash,
          fingerprint: incomingFp ?? device.fingerprint,
          last_fingerprint_check: new Date().toISOString(),
        }).eq("id", device.id);
      } else {
        await supabase.from("device_licenses").update({
          last_fingerprint_check: new Date().toISOString(),
        }).eq("id", device.id);
      }
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
