// Daily trial / subscription reminder broadcaster.
// Scheduled via pg_cron to run at 08:00 BRT (11:00 UTC).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPPORT_PHONE = "(77) 98150-3951";

function daysUntil(end: Date): number {
  const ms = end.getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

function fmtBR(d: Date): string {
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Sao_Paulo" });
}

function pickMilestone(daysLeft: number): { code: string; build: (name: string, date: string) => string } | null {
  if (daysLeft === 7) {
    return { code: "t-7", build: (name, date) => `📋 Olá ${name}! Seu período de teste do Gestor de Bombas termina em *7 dias* (${date}). Para continuar usando o sistema, entre em contato com a Renov Tecnologia.` };
  }
  if (daysLeft === 3) {
    return { code: "t-3", build: (name, date) => `⚠️ ${name}, faltam *3 dias* para o fim do seu período de teste (${date}). Após essa data, o acesso será suspenso. Contato: ${SUPPORT_PHONE}` };
  }
  if (daysLeft === 1) {
    return { code: "t-1", build: (name, date) => `🚨 ${name}, seu período de teste termina *amanhã* (${date}). Para não perder o acesso, regularize sua assinatura. Contato: ${SUPPORT_PHONE}` };
  }
  if (daysLeft === 0) {
    return { code: "t-0", build: (name, date) => `❌ ${name}, seu período de teste *expirou hoje*. O acesso ao sistema foi suspenso. Para reativar, entre em contato: ${SUPPORT_PHONE}` };
  }
  return null;
}

async function sendText(api_token: string, phone_number_id: string, to: string, body: string) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phone_number_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${api_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
    });
    if (!res.ok) console.error("[trial-notif] text send failed", to, res.status, await res.text());
    return res.ok;
  } catch (e) {
    console.error("[trial-notif] text err", to, e);
    return false;
  }
}

async function sendTpl(api_token: string, phone_number_id: string, to: string, params: string[]) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phone_number_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${api_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to, type: "template",
        template: { name: "notificacao_geral", language: { code: "pt_BR" }, components: [{
          type: "body", parameters: params.map((p) => ({ type: "text", text: p })),
        }] },
      }),
    });
    if (!res.ok) console.error("[trial-notif] template send failed", to, res.status, await res.text());
    else console.log("[trial-notif] template notificacao_geral sent to", to);
    return res.ok;
  } catch (e) {
    console.error("[trial-notif] template err", to, e);
    return false;
  }
}

async function sendProactive(api_token: string, phone_number_id: string, op: { phone: string; last_message_at?: string | null }, params: string[], freeText: string) {
  const last = op.last_message_at ? new Date(op.last_message_at).getTime() : 0;
  const within24h = last > 0 && (Date.now() - last) < 24 * 60 * 60 * 1000;
  if (within24h) return sendText(api_token, phone_number_id, op.phone, freeText);
  return sendTpl(api_token, phone_number_id, op.phone, params);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: config } = await supabase
    .from("whatsapp_config")
    .select("api_token, bot_number")
    .limit(1)
    .maybeSingle();

  if (!config?.api_token || !config?.bot_number) {
    return new Response(JSON.stringify({ error: "no_whatsapp_config" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: farms } = await supabase
    .from("farms")
    .select("id, name, trial_end_date, subscription_status")
    .not("trial_end_date", "is", null)
    .in("subscription_status", ["trial", "expired"]);

  const expiringSummary: string[] = [];
  let totalSent = 0;

  for (const farm of (farms ?? []) as any[]) {
    if (!farm.trial_end_date) continue;
    const end = new Date(farm.trial_end_date);
    const dleft = daysUntil(end);

    // Expired: force-disable operators + status
    if (dleft < 0 && farm.subscription_status !== "expired") {
      await supabase.from("farms")
        .update({ subscription_status: "expired" })
        .eq("id", farm.id);
      await supabase.from("whatsapp_operators")
        .update({ is_active: false })
        .eq("farm_id", farm.id);
      continue;
    }

    const milestone = pickMilestone(dleft);
    if (!milestone) continue;

    // Skip if already sent
    const { data: alreadySent } = await supabase
      .from("whatsapp_trial_notifications_log")
      .select("id")
      .eq("farm_id", farm.id)
      .eq("milestone", milestone.code)
      .maybeSingle();
    if (alreadySent) continue;

    // Collect operators of this farm (managers + operators)
    const { data: ops } = await supabase
      .from("whatsapp_operators")
      .select("phone, name, role, notification_preference, last_message_at")
      .eq("farm_id", farm.id)
      .eq("is_active", true);

    const recipients = (ops ?? []).filter((o: any) =>
      o.phone && (o.notification_preference ?? "default") !== "mute"
    );

    const dateStr = fmtBR(end);
    for (const r of recipients) {
      const name = (r.name ?? "").split(" ")[0] || farm.name || "produtor";
      const freeText = milestone.build(name, dateStr);
      const ok = await sendProactive(
        config.api_token, config.bot_number, r as any,
        ["Renov Tecnologia Agrícola", freeText.replace(/\*/g, "").slice(0, 900)],
        freeText,
      );
      if (ok) totalSent += 1;
    }

    await supabase.from("whatsapp_trial_notifications_log").insert({
      farm_id: farm.id,
      milestone: milestone.code,
    });

    if (dleft >= 0 && dleft <= 7) {
      expiringSummary.push(`• ${farm.name} — ${dleft === 0 ? "expira hoje" : `em ${dleft}d`} (${dateStr})`);
    }

    // On milestone t-0 also flip status
    if (milestone.code === "t-0") {
      await supabase.from("farms")
        .update({ subscription_status: "expired" })
        .eq("id", farm.id);
      await supabase.from("whatsapp_operators")
        .update({ is_active: false })
        .eq("farm_id", farm.id);
    }
  }

  // Daily summary to super_admins
  if (expiringSummary.length > 0) {
    const { data: admins } = await supabase
      .from("whatsapp_operators")
      .select("phone, notification_preference, is_active, last_message_at")
      .eq("role", "super_admin")
      .eq("is_active", true);
    const body = `📊 *Fazendas com teste expirando:*\n${expiringSummary.join("\n")}`;
    const tplBody = `Fazendas com teste expirando: ${expiringSummary.map((s) => s.replace(/^•\s*/, "")).join(" | ")}`.slice(0, 900);
    for (const a of (admins ?? []) as any[]) {
      if (!a.phone) continue;
      if ((a.notification_preference ?? "default") === "mute") continue;
      await sendProactive(config.api_token, config.bot_number, a, ["Renov Tecnologia Agrícola", tplBody], body);
    }
  }

  return new Response(JSON.stringify({
    status: "ok",
    total_sent: totalSent,
    expiring_count: expiringSummary.length,
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
