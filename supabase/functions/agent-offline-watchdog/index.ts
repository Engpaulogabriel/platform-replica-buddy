// agent-offline-watchdog — cron (recomendado a cada 2 min).
// #1 AGENTE OFFLINE: site_health.last_heartbeat > 5 min → alerta "agent_offline"
//    (1x) + recovery "agent_recovered" com downtime quando voltar.
// #2 EQUIPAMENTOS SEM COMUNICAÇÃO: 3+ bombas/poços da MESMA fazenda com
//    last_communication parado > 3 min → alerta "com_missing" (1x) + recovery
//    "com_recovered" quando normalizar.
// Anti-spam (1x) + recovery pareado ficam no whatsapp-automation-notify via a
// tabela watchdog_alerts_state (alert_type = agent_offline | com_missing).
// Destinatários e formato (template alerta_equipamento, 4 slots) no notify.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AGENT_OFFLINE_MS = 5 * 60_000;   // #1: 5 min sem heartbeat
const COM_MISSING_MS = 3 * 60_000;     // #2: 3 min sem last_communication
const COM_MISSING_MIN_COUNT = 3;       // #2: pelo menos 3 equipamentos

function fmtDowntime(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}min` : `${h}h`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const nowMs = Date.now();

  const invokeAlert = async (body: Record<string, unknown>) => {
    try {
      const { data, error } = await supabase.functions.invoke("whatsapp-automation-notify", { body });
      return { ok: !error, error: error?.message, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };

  // ── Estado atual dos alertas de watchdog (para pareamento + downtime) ──
  const { data: states } = await supabase
    .from("watchdog_alerts_state")
    .select("farm_id, alert_type, is_active, last_sent_at")
    .in("alert_type", ["agent_offline", "com_missing"])
    .eq("is_active", true);
  const activeAgent = new Map<string, string>(); // farm_id -> last_sent_at
  const activeCom = new Map<string, string>();
  for (const s of (states ?? []) as any[]) {
    if (s.alert_type === "agent_offline") activeAgent.set(s.farm_id, s.last_sent_at);
    else if (s.alert_type === "com_missing") activeCom.set(s.farm_id, s.last_sent_at);
  }

  const results: any[] = [];

  // ─────────────────────────────────────────────────────────────────────────
  // #1 AGENTE OFFLINE
  // ─────────────────────────────────────────────────────────────────────────
  const { data: sh, error: shErr } = await supabase
    .from("site_health")
    .select("farm_id, last_heartbeat, farm:farm_id(name, is_demo)")
    .not("farm_id", "is", null);
  if (shErr) {
    console.error("[watchdog] site_health query failed:", shErr.message);
  }
  for (const r of (sh ?? []) as any[]) {
    if (r?.farm?.is_demo || !r.last_heartbeat) continue;
    const farmName = r?.farm?.name ?? "Fazenda";
    const ageMs = nowMs - new Date(r.last_heartbeat).getTime();
    if (ageMs > AGENT_OFFLINE_MS) {
      const res = await invokeAlert({
        type: "alert", immediate: true, source: "agent_offline_watchdog",
        alert_type: "agent_offline", farm_id: r.farm_id, farm_name: farmName, equipment_name: "Sistema",
        message: `🔴 AGENTE OFFLINE — ${farmName}`,
        metadata: { age_sec: Math.round(ageMs / 1000), last_heartbeat: r.last_heartbeat },
      });
      results.push({ farm_id: r.farm_id, kind: "agent_offline", ...res });
    } else if (activeAgent.has(r.farm_id)) {
      const startedAt = activeAgent.get(r.farm_id);
      const downtime = startedAt ? fmtDowntime(nowMs - new Date(startedAt).getTime()) : "";
      const res = await invokeAlert({
        type: "alert", immediate: true, source: "agent_offline_watchdog",
        alert_type: "agent_recovered", farm_id: r.farm_id, farm_name: farmName, equipment_name: "Sistema",
        message: `🟢 AGENTE ONLINE — ${farmName}`,
        metadata: { downtime },
      });
      results.push({ farm_id: r.farm_id, kind: "agent_recovered", ...res });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // #2 EQUIPAMENTOS SEM COMUNICAÇÃO (agregado por fazenda)
  // ─────────────────────────────────────────────────────────────────────────
  const { data: eqs, error: eqErr } = await supabase
    .from("equipments")
    .select("farm_id, name, last_communication, type, active, maintenance_mode, farm:farm_id(name, is_demo)")
    .in("type", ["poco", "bombeamento"])
    .eq("active", true);
  if (eqErr) console.error("[watchdog] equipments query failed:", eqErr.message);

  const staleByFarm = new Map<string, { farmName: string; names: string[] }>();
  for (const e of (eqs ?? []) as any[]) {
    if (e?.farm?.is_demo || e?.maintenance_mode) continue;
    if (!e.last_communication) continue; // sem histórico → não conta (evita falso positivo no boot)
    const ageMs = nowMs - new Date(e.last_communication).getTime();
    if (ageMs <= COM_MISSING_MS) continue;
    const g = staleByFarm.get(e.farm_id) ?? { farmName: e?.farm?.name ?? "Fazenda", names: [] };
    g.names.push(String(e.name ?? "?"));
    staleByFarm.set(e.farm_id, g);
  }

  // Fazendas com falha atual (>= N equipamentos) e as que normalizaram.
  const comFarmsNow = new Set<string>();
  for (const [farmId, g] of staleByFarm) {
    if (g.names.length >= COM_MISSING_MIN_COUNT) {
      comFarmsNow.add(farmId);
      const res = await invokeAlert({
        type: "alert", immediate: true, source: "agent_offline_watchdog",
        alert_type: "com_missing", farm_id: farmId, farm_name: g.farmName, equipment_name: "Rádio",
        message: `⚠️ ${g.names.length} equipamentos sem resposta — ${g.farmName}`,
        metadata: { count: g.names.length, equipment_list: g.names.slice(0, 12).join(", ") },
      });
      results.push({ farm_id: farmId, kind: "com_missing", count: g.names.length, ...res });
    }
  }
  // Recovery: farms que estavam com_missing ativo e agora < N stale.
  for (const [farmId, startedAt] of activeCom) {
    if (comFarmsNow.has(farmId)) continue;
    const farmName = staleByFarm.get(farmId)?.farmName
      ?? (sh ?? []).find((r: any) => r.farm_id === farmId)?.farm?.name
      ?? "Fazenda";
    const recovered = COM_MISSING_MIN_COUNT - (staleByFarm.get(farmId)?.names.length ?? 0);
    const res = await invokeAlert({
      type: "alert", immediate: true, source: "agent_offline_watchdog",
      alert_type: "com_recovered", farm_id: farmId, farm_name: farmName, equipment_name: "Rádio",
      message: `✅ COMUNICAÇÃO RESTAURADA — ${farmName}`,
      metadata: { count: Math.max(0, recovered), downtime: startedAt ? fmtDowntime(nowMs - new Date(startedAt).getTime()) : "" },
    });
    results.push({ farm_id: farmId, kind: "com_recovered", ...res });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      agent_checked: sh?.length ?? 0,
      equipments_checked: eqs?.length ?? 0,
      com_farms_offline: comFarmsNow.size,
      results,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
