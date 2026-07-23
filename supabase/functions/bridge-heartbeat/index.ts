import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: any = {};
  try { body = await req.json(); } catch { /* noop */ }

  const { farm_id, bridge_name = "main", electron_version, ip_address, uptime_seconds } = body || {};

  if (!farm_id) {
    return new Response(JSON.stringify({ error: "farm_id required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const xff = req.headers.get("x-forwarded-for");
  const ip = ip_address || (xff ? xff.split(",")[0].trim() : null);

  // Upsert heartbeat row
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
