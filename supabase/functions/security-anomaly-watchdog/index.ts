import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { guardCron } from "../_shared/cronAuth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // ── GUARDA DE CRON ────────────────────────────────────────────────────────
  // Antes de QUALQUER consulta, alerta, escrita ou ação operacional.
  { const blocked = guardCron(req, corsHeaders); if (blocked) return blocked; }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase.rpc("detect_security_anomalies");
    if (error) throw error;

    console.log("[security-anomaly-watchdog]", JSON.stringify(data));

    return new Response(JSON.stringify({ ok: true, result: data }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[security-anomaly-watchdog]", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
