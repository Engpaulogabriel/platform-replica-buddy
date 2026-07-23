// agent-offline-watchdog — cron a cada 1 min.
// Detecta agentes cujo último heartbeat (site_health.last_heartbeat) tem mais
// de 3 min. Dispara alerta "agent_offline" e envia recovery quando voltar.
// Anti-spam + recovery pareado ficam no whatsapp-automation-notify.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OFFLINE_THRESHOLD_MS = 3 * 60_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const nowMs = Date.now();

  // 1) Todos os agentes com heartbeat conhecido.
  const { data: rows, error } = await supabase
    .from("site_health")
    .select("farm_id, last_heartbeat, farm:farm_id(name, is_demo)")
    .not("farm_id", "is", null);

  if (error) {
    console.error("[watchdog] site_health query failed:", error.message);
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const offlineAlerts: Array<{ farm_id: string; farm_name: string; ageSec: number }> = [];
  const recoveryFarms: Array<{ farm_id: string; farm_name: string }> = [];

  // Precisa mapear estado atual: quais farms têm alert agent_offline ativo?
  const { data: activeStates } = await supabase
    .from("watchdog_alerts_state")
    .select("farm_id, is_active")
    .eq("alert_type", "agent_offline")
    .eq("is_active", true);
  const activeFarmIds = new Set((activeStates ?? []).map((s: any) => s.farm_id));

  for (const r of (rows ?? []) as any[]) {
    if (r?.farm?.is_demo) continue; // pular demo
    if (!r.last_heartbeat) continue;
    const ageMs = nowMs - new Date(r.last_heartbeat).getTime();
    const isOffline = ageMs > OFFLINE_THRESHOLD_MS;
    const farmName = r?.farm?.name ?? "Fazenda";
    if (isOffline) {
      offlineAlerts.push({ farm_id: r.farm_id, farm_name: farmName, ageSec: Math.round(ageMs / 1000) });
    } else if (activeFarmIds.has(r.farm_id)) {
      // Estava marcado como offline e voltou.
      recoveryFarms.push({ farm_id: r.farm_id, farm_name: farmName });
    }
  }

  const results: any[] = [];

  for (const a of offlineAlerts) {
    const mins = Math.round(a.ageSec / 60);
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke("whatsapp-automation-notify", {
        body: {
          type: "alert",
          immediate: true,
          source: "agent_offline_watchdog",
          alert_type: "agent_offline",
          farm_id: a.farm_id,
          farm_name: a.farm_name,
          equipment_name: "Sistema",
          message: `⚠️ Agente OFFLINE há ${mins}min — ${a.farm_name} — verificar computador/internet/energia`,
          metadata: { age_sec: a.ageSec },
        },
      });
      results.push({ farm_id: a.farm_id, action: "offline", ok: !invokeErr, data, error: invokeErr?.message });
    } catch (e) {
      console.error("[watchdog] send offline alert failed:", (e as Error).message);
      results.push({ farm_id: a.farm_id, action: "offline", ok: false, error: (e as Error).message });
    }
  }

  for (const r of recoveryFarms) {
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke("whatsapp-automation-notify", {
        body: {
          type: "alert",
          immediate: true,
          source: "agent_offline_watchdog",
          alert_type: "agent_recovered",
          farm_id: r.farm_id,
          farm_name: r.farm_name,
          equipment_name: "Sistema",
          message: `✅ Agente reconectado — ${r.farm_name} — sistema operacional`,
        },
      });
      results.push({ farm_id: r.farm_id, action: "recovery", ok: !invokeErr, data, error: invokeErr?.message });
    } catch (e) {
      console.error("[watchdog] send recovery alert failed:", (e as Error).message);
      results.push({ farm_id: r.farm_id, action: "recovery", ok: false, error: (e as Error).message });
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      checked: rows?.length ?? 0,
      offline_alerts: offlineAlerts.length,
      recovery_alerts: recoveryFarms.length,
      results,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
