// diag-license — ativação/validação do renov_diag por device_id (anti-clone).
// ───────────────────────────────────────────────────────────────────────────
// A ferramenta chama { action:"check", device_id, device_info } a cada abertura:
//   - device novo → registra como 'pending' (aguarda o admin autorizar) e retorna pending.
//   - device existente → atualiza last_seen e retorna o status atual.
// Resposta: { ok:(status==='authorized'), status, farm_id }. Se copiado p/ outro PC,
// o device_id muda → não há licença autorizada → ok=false → a ferramenta bloqueia.
// A WEB (platform_admin) autoriza/revoga direto na tabela (RLS). verify_jwt=false:
// o registro é público (só marca pending); a AUTORIZAÇÃO é do admin.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const action = String(body?.action ?? "check");
  const deviceId = String(body?.device_id ?? "").trim();
  if (!deviceId || deviceId.length < 16) return json({ ok: false, reason: "missing_device_id" }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const nowIso = new Date().toISOString();

  if (action !== "check") return json({ ok: false, reason: "unknown_action" }, 400);

  const { data: lic } = await supabase
    .from("diag_licenses").select("device_id, status, farm_id, revoked_at").eq("device_id", deviceId).maybeSingle();

  if (!lic) {
    // 1ª vez: registra como pendente (aguardando autorização do admin).
    await supabase.from("diag_licenses").insert({
      device_id: deviceId,
      hostname: String(body?.device_info?.hostname ?? "") || null,
      device_info: body?.device_info ?? {},
      status: "pending", last_seen: nowIso,
    });
    return json({ ok: false, status: "pending" });
  }

  await supabase.from("diag_licenses").update({ last_seen: nowIso, updated_at: nowIso }).eq("device_id", deviceId);
  const status = lic.revoked_at ? "revoked" : String(lic.status);
  return json({ ok: status === "authorized", status, farm_id: lic.farm_id ?? null });
});
