// Public endpoint to record IP + GPS verification for registration link.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

function getClientIp(req: Request): string | null {
  const h = req.headers;
  const cands = [
    h.get("cf-connecting-ip"),
    h.get("x-real-ip"),
    (h.get("x-forwarded-for") || "").split(",")[0]?.trim() || null,
  ];
  return cands.find((c) => !!c) ?? null;
}

async function geoLookup(ip: string): Promise<{ city: string | null; region: string | null }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = await r.json();
    if (j?.status === "success") {
      return { city: j.city ?? null, region: j.regionName ?? null };
    }
  } catch (_) { /* ignore */ }
  return { city: null, region: null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const ip = getClientIp(req);
    const ua = req.headers.get("user-agent") ?? null;

    if (req.method === "GET") {
      const token = url.searchParams.get("token") || url.pathname.split("/").pop();
      if (!token) {
        return new Response(JSON.stringify({ error: "missing token" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const { data, error } = await supabase
        .from("registration_verifications")
        .select("id, target_phone, verified_at, created_at")
        .eq("token", token)
        .maybeSingle();
      if (error || !data) {
        return new Response(JSON.stringify({ valid: false }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ valid: true, already: !!data.verified_at }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405, headers: corsHeaders });
    }

    const body = await req.json().catch(() => ({}));
    const token = String(body.token || "").trim();
    if (!token) {
      return new Response(JSON.stringify({ error: "missing token" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: row, error: selErr } = await supabase
      .from("registration_verifications")
      .select("id")
      .eq("token", token)
      .maybeSingle();
    if (selErr || !row) {
      return new Response(JSON.stringify({ error: "invalid token" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const lat = body.latitude != null ? Number(body.latitude) : null;
    const lng = body.longitude != null ? Number(body.longitude) : null;
    const acc = body.accuracy != null ? Number(body.accuracy) : null;
    const denied = body.location_denied === true || (lat == null && lng == null);

    let city: string | null = null;
    let region: string | null = null;
    if (ip) {
      const g = await geoLookup(ip);
      city = g.city;
      region = g.region;
    }

    await supabase.from("registration_verifications").update({
      ip_address: ip,
      user_agent: ua,
      latitude: !denied && Number.isFinite(lat as number) ? lat : null,
      longitude: !denied && Number.isFinite(lng as number) ? lng : null,
      location_accuracy: !denied && Number.isFinite(acc as number) ? acc : null,
      location_denied: denied,
      city_from_ip: city,
      state_from_ip: region,
      // ONLY mark as verified when GPS coords were actually provided
      verified_at: denied ? null : new Date().toISOString(),
    }).eq("id", row.id);

    if (denied) {
      return new Response(JSON.stringify({ success: false, denied: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("verify-registration err", e);
    return new Response(JSON.stringify({ error: "internal" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
