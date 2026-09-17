import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return new Response(JSON.stringify({ error: "missing_bearer" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userRes, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userRes?.user) {
    return new Response(JSON.stringify({ error: "invalid_or_expired_token" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* noop */ }

  const { farm_id, bridge_name = "main", electron_version, ip_address, uptime_seconds } = body || {};

  if (!farm_id) {
    return new Response(JSON.stringify({ error: "farm_id required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(url, service);

  // Ownership check: caller must have farm access.
  const { data: hasAccess, error: accessErr } = await supabase.rpc(
    "has_farm_access",
    { _user_id: userRes.user.id, _farm_id: farm_id },
  );
  if (accessErr || !hasAccess) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const xff = req.headers.get("x-forwarded-for");
  const ip = ip_address || (xff ? xff.split(",")[0].trim() : null);

  const { error } = await supabase
    .from("bridge_heartbeat")
    .upsert(
      {
        farm_id,
        bridge_name,
        last_heartbeat_at: new Date().toISOString(),
        status: "online",
        electron_version: electron_version ?? null,
        ip_address: ip,
        uptime_seconds: uptime_seconds ?? null,
      },
      { onConflict: "farm_id,bridge_name" },
    );

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ status: "ok", server_time: new Date().toISOString() }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
