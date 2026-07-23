// Broadcast/mass messaging via WhatsApp.
// Called from the platform admin UI to send announcements to operators.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Body {
  message?: string;
  target?: string; // 'all' | 'farm:<id>' | 'role:operator' | 'role:manager'
  farm_id?: string | null;
  test_only_phone?: string | null;
  scheduled_at?: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Body = {};
  try { body = await req.json(); } catch { /* noop */ }

  const message = (body.message ?? "").toString().trim();
  if (!message || message.length > 4000) {
    return new Response(JSON.stringify({ error: "invalid_message" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const target = (body.target ?? "all").toString();

  // ── Auth: caller must be platform admin (RLS-protected RPC handles the check)
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userRes } = await userClient.auth.getUser();
  const userId = userRes?.user?.id ?? null;
  if (!userId) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { data: isAdminRes } = await supabase.rpc("is_platform_admin" as any, { _uid: userId });
  if (isAdminRes !== true) {
    // some installs use is_platform_admin without arg — fall back to manual check
    const { data: pa } = await supabase
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!pa) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Schedule for later → just store the row, no send
  if (body.scheduled_at) {
    const { data: row, error } = await supabase.from("whatsapp_broadcasts").insert({
      message,
      target,
      farm_id: body.farm_id ?? null,
      sent_by: userRes?.user?.email ?? userId,
      status: "pending",
      scheduled_at: body.scheduled_at,
    }).select().single();
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ status: "scheduled", broadcast: row }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Resolve targets
  const test = body.test_only_phone ?? null;
  let phones: string[] = [];
  if (test) {
    phones = [test];
  } else {
    let q = supabase
      .from("whatsapp_operators")
      .select("phone, role, farm_id, is_active, notification_preference")
      .eq("is_active", true);

    if (target.startsWith("farm:")) {
      q = q.eq("farm_id", target.slice(5));
    } else if (body.farm_id) {
      q = q.eq("farm_id", body.farm_id);
    }
    if (target === "role:manager") q = q.in("role", ["manager", "super_admin"]);
    if (target === "role:operator") q = q.eq("role", "operator");

    const { data: ops } = await q;
    phones = Array.from(new Set((ops ?? [])
      .filter((o: any) => (o.notification_preference ?? "default") !== "mute")
      .map((o: any) => o.phone)
      .filter(Boolean)));
  }

  // Insert broadcast row (sending)
  const { data: bRow, error: bErr } = await supabase.from("whatsapp_broadcasts").insert({
    message,
    target,
    farm_id: body.farm_id ?? null,
    sent_by: userRes?.user?.email ?? userId,
    status: "sending",
  }).select().single();
  if (bErr) {
    return new Response(JSON.stringify({ error: bErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: config } = await supabase
    .from("whatsapp_config")
    .select("api_token, bot_number")
    .limit(1)
    .maybeSingle();

  if (!config?.api_token || !config?.bot_number) {
    await supabase.from("whatsapp_broadcasts")
      .update({ status: "failed" })
      .eq("id", bRow.id);
    return new Response(JSON.stringify({ error: "no_whatsapp_config" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let sentCount = 0;
  for (const to of phones) {
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/${config.bot_number}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.api_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: message },
        }),
      });
      if (res.ok) sentCount += 1;
      else console.error("[broadcast] send failed", to, res.status, await res.text());
    } catch (e) {
      console.error("[broadcast] err", to, e);
    }
  }

  await supabase.from("whatsapp_broadcasts").update({
    status: sentCount > 0 ? "sent" : "failed",
    sent_count: sentCount,
    sent_at: new Date().toISOString(),
  }).eq("id", bRow.id);

  return new Response(JSON.stringify({ status: "ok", sent_count: sentCount, target_count: phones.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
