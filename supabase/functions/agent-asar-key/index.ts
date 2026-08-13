// agent-asar-key — Entrega da chave AES do asar cifrado (FASE 3).
// ───────────────────────────────────────────────────────────────────────────
// O LOADER do agente chama este endpoint no boot com fingerprint + versão (+ token
// rotativo opcional). O servidor valida o device (device_licenses por
// machine_id_hash, não revogado, fingerprint sem divergência forte) e SÓ então
// retorna a chave AES-256 (base64) daquela versão. Sem a chave, o asar.enc não
// executa. Copiar o asar p/ outro PC → fingerprint diverge → 403.
//
// A chave NUNCA é persistida em disco pelo servidor; vem de agent_release_keys
// (tabela sem policy, só service_role). verify_jwt=false (validação é aqui).
// ───────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@5.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function fingerprintDivergence(stored: any, incoming: any): number {
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

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const machineIdHash = String(body?.machine_id_hash ?? "").trim();
  const fingerprint = body?.fingerprint ?? null;
  const version = String(body?.version ?? "").trim();
  const token = body?.token ?? null;
  if (!machineIdHash || !version) return json({ ok: false, reason: "missing_params" }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 1) device ativo por machine_id_hash
  const { data: dev } = await supabase
    .from("device_licenses")
    .select("id, farm_id, machine_id_hash, fingerprint, current_token_jti, revoked_at")
    .eq("machine_id_hash", machineIdHash)
    .is("revoked_at", null)
    .maybeSingle();
  if (!dev) return json({ ok: false, reason: "no_active_license" }, 403);

  // 2) anti-clone por fingerprint
  const diverge = fingerprintDivergence(dev.fingerprint, fingerprint);
  if (diverge >= 2) {
    await supabase.rpc("increment_fingerprint_mismatch", { _device_id: dev.id }).catch(() => {});
    return json({ ok: false, reason: "fingerprint_mismatch", divergence: diverge }, 403);
  }

  // 3) token rotativo (opcional — reforço anti-replay). Se veio, precisa bater.
  if (token) {
    const secretStr = Deno.env.get("AGENT_TOKEN_SECRET");
    if (secretStr) {
      try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(secretStr));
        if (payload?.fp !== machineIdHash) return json({ ok: false, reason: "token_fp_mismatch" }, 403);
      } catch { return json({ ok: false, reason: "token_invalid" }, 403); }
    }
  }

  // 4) entrega a chave da versão pedida
  const { data: keyRow } = await supabase
    .from("agent_release_keys")
    .select("aes_key, algo")
    .eq("version", version)
    .maybeSingle();
  if (!keyRow?.aes_key) return json({ ok: false, reason: "no_key_for_version", version }, 404);

  await supabase.from("device_licenses")
    .update({ last_seen_at: new Date().toISOString(), last_fingerprint_check: new Date().toISOString() })
    .eq("id", dev.id);

  // 5) OTA do main.enc: signed URL do artefato cifrado em Storage
  //    (agent-releases/<version>/main.enc). O loader baixa isto no 1º boot da
  //    versão, decifra com aes_key e guarda o CÓDIGO em cache local selado. Se o
  //    objeto não existir (build antigo empacotou main.enc em resources/), enc_url
  //    vem null e o loader cai no resources/ como fonte. createSignedUrl NÃO valida
  //    existência — download 404 → loader trata como ausente.
  let enc_url: string | null = null;
  try {
    const { data: signed } = await supabase.storage
      .from("agent-releases")
      .createSignedUrl(`${version}/main.enc`, 86400);
    enc_url = signed?.signedUrl ?? null;
  } catch { enc_url = null; }

  return json({ ok: true, aes_key: keyRow.aes_key, algo: keyRow.algo ?? "aes-256-gcm", version, enc_url });
});
