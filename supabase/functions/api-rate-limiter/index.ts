import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

const WINDOW_SECONDS = 60;
const MAX_HITS = 240;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const endpoint = typeof body.endpoint === "string" ? body.endpoint.slice(0, 200) : "unknown";
    const userId = typeof body.user_id === "string" ? body.user_id : null;
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const ua = req.headers.get("user-agent") ?? null;

    if (!userId) {
      return json({ allowed: true, reason: "anonymous" });
    }

    const since = new Date(Date.now() - WINDOW_SECONDS * 1000).toISOString();
    const { count } = await supabase
      .from("user_activity_log")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", since);

    const hits = count ?? 0;

    if (hits > MAX_HITS) {
      await supabase.from("rate_limit_violations").insert({
        user_id: userId,
        endpoint,
        violation_type: "rate_limit",
        hits,
        window_seconds: WINDOW_SECONDS,
        ip_address: ip,
        user_agent: ua,
        details: { max: MAX_HITS },
      });
      return json({ allowed: false, reason: "rate_limit", hits, limit: MAX_HITS }, 429);
    }

    return json({ allowed: true, hits, limit: MAX_HITS });
  } catch (e) {
    console.error("[api-rate-limiter]", e);
    return json({ allowed: true, error: String(e) });
  }
});
