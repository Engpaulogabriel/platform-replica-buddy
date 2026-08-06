// Edge function: license-validate
// Verifica rapidamente se um token e valido (usado em chamadas criticas)
// Nao atualiza last_seen — apenas valida assinatura HMAC + status atual.
//
// v3.25.45/46 — AMARRACAO SERVER-SIDE ANTI-CLONE:
// O agente envia machine_id_hash + fingerprint no corpo. Comparamos com o device
// registrado (device_licenses). Se o hardware diverge em >=2 dos 4 componentes
// (cpu, disco, uuid da placa-mae, MAC) -> 403 machine_mismatch. Isso mata um clone
// que copiou o token/config para OUTRO PC — enforcement PER-CHAMADOR: o agente
// ORIGINAL (fingerprint certo) recebe valid=true e segue operando; o CLONE
// (fingerprint errado) recebe 403 e para (o agente honra apos 3 strikes). NAO
// mexemos na senha da fazenda nem revogamos o device compartilhado — os dois
// autenticam com a MESMA credencial, entao qualquer acao nessa credencial
// derrubaria tambem o original. A distincao e feita SO pelo fingerprint, por
// chamada. Tolerancia de 1 componente (troca legitima de NIC/disco) so atualiza
// o fingerprint registrado (drift). Retrocompativel: agente antigo que nao manda
// fingerprint segue validando como antes.
//
// v3.25.46 — DETECCAO + ALERTA (#3): na 1a deteccao de clone dispara WhatsApp
// "ALERTA SEGURANCA: Tentativa de clone detectada na fazenda X" via
// whatsapp-automation-notify, e conta em device_licenses.fingerprint_mismatch_count.

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
    return x !== "" && y !== "" && x !== y;
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

// Alerta WhatsApp de clone — best-effort, nunca derruba a validacao.
async function fireCloneAlert(supabase: any, farmId: string, diffs: number) {
  try {
    const { data: farm } = await supabase.from("farms").select("name").eq("id", farmId).maybeSingle();
    const farmName = farm?.name ?? "Fazenda";
    await supabase.functions.invoke("whatsapp-automation-notify", {
      body: {
        type: "alert",
        immediate: true,
        source: "clone_guard",
        alert_type: "clone_detected",
        farm_id: farmId,
        farm_name: farmName,
        equipment_name: "Sistema",
        message: `ALERTA SEGURANCA: Tentativa de clone detectada na fazenda ${farmName} — hardware nao autorizado tentou operar com a licenca. O agente clonado foi bloqueado; o original segue normal.`,
        metadata: { diffs },
      },
    });
  } catch (e) {
    console.error("[clone-guard] fireCloneAlert failed:", (e as Error).message);
  }
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

    // ── AMARRACAO ANTI-CLONE (server-side, per-chamador) ────────────────────
    // So aplica se o agente mandou fingerprint E o device tem um registrado.
    if (incomingHash && device.machine_id_hash) {
      const sameHash = incomingHash === device.machine_id_hash;
      if (!sameHash) {
        const diffs = incomingFp ? countHardwareDiffs(incomingFp, device.fingerprint) : 99;
        if (diffs >= 2) {
          // CLONE: outro PC. NAO revogamos o device (mataria o original tambem);
          // apenas negamos ESTA chamada. O original, com fingerprint certo, passa.
          const prevCount = device.fingerprint_mismatch_count ?? 0;
          await supabase.from("device_licenses").update({
            fingerprint_mismatch_count: prevCount + 1,
            last_fingerprint_check: new Date().toISOString(),
          }).eq("id", device.id);
          try {
            await supabase.from("agent_logs").insert({
              farm_id: device.farm_id, level: "error", category: "security",
              message: `CLONE BLOQUEADO (license-validate): hardware diverge em ${diffs} componentes. Device=${String(device.machine_id_hash).slice(0, 12)} tentativa=${String(incomingHash).slice(0, 12)}`,
            });
          } catch (_) { /* agent_logs best-effort */ }
          // Alerta WhatsApp na 1a deteccao do burst (evita spam a cada 30s).
          if (prevCount === 0) {
            await fireCloneAlert(supabase, device.farm_id, diffs);
          }
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
        // Hardware confere: zera o contador de tentativas e marca o check.
        const patch: Record<string, unknown> = { last_fingerprint_check: new Date().toISOString() };
        if ((device.fingerprint_mismatch_count ?? 0) > 0) patch.fingerprint_mismatch_count = 0;
        await supabase.from("device_licenses").update(patch).eq("id", device.id);
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
