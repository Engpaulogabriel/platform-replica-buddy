// Health check diário: garante que TODA fazenda ativa tem pelo menos 1 número
// WhatsApp cadastrado para receber alertas. Fazendas descobertas sem operador
// disparam um alerta ao admin global (via whatsapp-alerts com fallback).
//
// Também revisa se cada fazenda teve alguma chamada bem-sucedida à edge function
// nos últimos 7 dias. Se não teve, sinaliza como "silêncio suspeito" (fazenda
// pode estar sem eventos, ou pode haver problema de rota — o admin decide).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const started = new Date().toISOString();
  const report: {
    farms_total: number;
    farms_missing_phone: Array<{ farm_id: string; name: string }>;
    farms_silent_7d: Array<{ farm_id: string; name: string }>;
    admin_notified: number;
  } = { farms_total: 0, farms_missing_phone: [], farms_silent_7d: [], admin_notified: 0 };

  // 1) Lista todas fazendas ativas
  const { data: farms, error: farmsErr } = await supabase
    .from("farms")
    .select("id, name, active")
    .eq("active", true);

  if (farmsErr) {
    console.error("[healthcheck] failed to list farms", farmsErr);
    return new Response(JSON.stringify({ error: farmsErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  report.farms_total = farms?.length ?? 0;

  // 2) Para cada fazenda: tem operador ativo com telefone?
  const { data: ops } = await supabase
    .from("whatsapp_operators")
    .select("farm_id, phone, is_active, receive_alerts")
    .eq("is_active", true);

  const opsByFarm = new Map<string, number>();
  for (const o of (ops ?? []) as any[]) {
    if (!o.phone) continue;
    if (o.receive_alerts === false) continue;
    if (!o.farm_id) continue;
    opsByFarm.set(o.farm_id, (opsByFarm.get(o.farm_id) ?? 0) + 1);
  }

  for (const f of (farms ?? []) as any[]) {
    if ((opsByFarm.get(f.id) ?? 0) === 0) {
      report.farms_missing_phone.push({ farm_id: f.id, name: f.name });
    }
  }

  // 3) Fazendas sem sucesso de envio nos últimos 7 dias
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentLogs } = await supabase
    .from("whatsapp_message_log")
    .select("farm_id, created_at")
    .eq("direction", "outgoing")
    .gte("created_at", since);

  const farmsWithRecent = new Set<string>();
  for (const r of (recentLogs ?? []) as any[]) {
    if (r.farm_id) farmsWithRecent.add(r.farm_id);
  }
  for (const f of (farms ?? []) as any[]) {
    if (!farmsWithRecent.has(f.id)) {
      report.farms_silent_7d.push({ farm_id: f.id, name: f.name });
    }
  }

  // 4) Notifica o admin global para cada fazenda sem telefone (usa fallback)
  const adminFallbackPhones = String(Deno.env.get("WHATSAPP_ADMIN_FALLBACK_PHONES") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  if (report.farms_missing_phone.length && adminFallbackPhones.length) {
    const { data: cfg } = await supabase
      .from("whatsapp_config")
      .select("api_token, phone_number_id")
      .limit(1)
      .maybeSingle();
    if (cfg?.api_token && cfg?.phone_number_id) {
      const list = report.farms_missing_phone.map((f) => `• ${f.name} (${f.farm_id})`).join("\n");
      const msg = `⚠️ *Renov Healthcheck* — Fazendas SEM operador WhatsApp cadastrado:\n\n${list}\n\nEsses locais não receberão alertas locais. Cadastre um responsável em cada fazenda.`;
      for (const phone of adminFallbackPhones) {
        try {
          const digits = phone.replace(/\D/g, "");
          const to = digits.startsWith("55") ? digits : `55${digits}`;
          await fetch(`https://graph.facebook.com/v21.0/${cfg.phone_number_id}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${cfg.api_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: msg } }),
          });
          report.admin_notified++;
        } catch (e) {
          console.error("[healthcheck] admin notify failed", phone, e);
        }
      }
    }
  }

  console.log("[healthcheck] finished", { started, ended: new Date().toISOString(), report });

  return new Response(JSON.stringify({ ok: true, ...report }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
