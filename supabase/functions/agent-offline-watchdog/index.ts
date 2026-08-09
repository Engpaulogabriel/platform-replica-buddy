// agent-offline-watchdog — cron (a cada 2 min).
// ───────────────────────────────────────────────────────────────────────────
// APENAS alertas CRÍTICOS que exigem INTERVENÇÃO HUMANA. Por decisão do dono:
//   • SEM mensagens de recuperação (voltou/restaurou) — se voltou, silêncio.
//   • SEM "equipamentos sem resposta" (com_missing) — rádio perde e volta sozinho.
//   • SEM "TX travada" — o agente se recupera sozinho.
//
// Envia SÓ nestes dois casos, UMA vez por ocorrência:
//   #1 AGENTE OFFLINE: site_health.last_heartbeat > 5 min (PC/Starlink caiu).
//   #2 BRIDGE MORTA SUSTENTADA: agente ONLINE mas a serial morreu
//      (last_error='bridge_dead' ou com_connected=false) e NÃO recuperou por
//      >= 5 min. Se recuperar em < 5 min → silêncio total.
//
// Recuperação: apaga o estado em silêncio (sem mensagem). Assim uma nova
// ocorrência futura volta a alertar (1x). Estado em watchdog_alerts_state.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AGENT_OFFLINE_MS = 5 * 60_000;      // #1: 5 min sem heartbeat
const BRIDGE_DEAD_GRACE_MS = 5 * 60_000;  // #2: bridge morta por >= 5 min antes de avisar

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const nowMs = Date.now();
  const nowIso = new Date().toISOString();

  const invokeAlert = async (body: Record<string, unknown>) => {
    try {
      const { data, error } = await supabase.functions.invoke("whatsapp-automation-notify", { body });
      return { ok: !error, error: error?.message, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };
  const clearState = async (farmId: string, alertType: string) => {
    try {
      await supabase.from("watchdog_alerts_state").delete().eq("farm_id", farmId).eq("alert_type", alertType);
    } catch (_) { /* best-effort */ }
  };

  // Estados que ESTE watchdog gerencia (agent_offline + bridge_down, ativos ou em graça).
  const { data: states } = await supabase
    .from("watchdog_alerts_state")
    .select("farm_id, alert_type, is_active, metadata")
    .in("alert_type", ["agent_offline", "bridge_down"]);
  const stAgent = new Map<string, any>();
  const stBridge = new Map<string, any>();
  for (const s of (states ?? []) as any[]) {
    if (s.alert_type === "agent_offline") stAgent.set(s.farm_id, s);
    else if (s.alert_type === "bridge_down") stBridge.set(s.farm_id, s);
  }

  const { data: sh, error: shErr } = await supabase
    .from("site_health")
    .select("farm_id, last_heartbeat, com_connected, last_error, farm:farm_id(name, is_demo)")
    .not("farm_id", "is", null);
  if (shErr) console.error("[watchdog] site_health query failed:", shErr.message);

  const results: any[] = [];

  for (const r of (sh ?? []) as any[]) {
    if (r?.farm?.is_demo || !r.last_heartbeat) continue;
    const farmName = r?.farm?.name ?? "Fazenda";
    const hbAge = nowMs - new Date(r.last_heartbeat).getTime();
    const agentOffline = hbAge > AGENT_OFFLINE_MS;

    // ─────────────────────────────────────────────────────────────────────
    // #1 AGENTE OFFLINE (PC/Starlink caiu) — 1 alerta por ocorrência.
    // ─────────────────────────────────────────────────────────────────────
    if (agentOffline) {
      if (!stAgent.get(r.farm_id)?.is_active) {
        const res = await invokeAlert({
          type: "alert", immediate: true, source: "agent_offline_watchdog",
          alert_type: "agent_offline", farm_id: r.farm_id, farm_name: farmName, equipment_name: "Sistema",
          message: `🔴 AGENTE OFFLINE — ${farmName}`,
          metadata: { age_sec: Math.round(hbAge / 1000), last_heartbeat: r.last_heartbeat },
        });
        results.push({ farm_id: r.farm_id, kind: "agent_offline", ...res });
      }
      continue; // offline: não faz sentido avaliar a bridge
    }
    // Voltou a dar heartbeat → limpa o estado de offline em SILÊNCIO (sem "voltou").
    if (stAgent.has(r.farm_id)) await clearState(r.farm_id, "agent_offline");

    // ─────────────────────────────────────────────────────────────────────
    // #2 BRIDGE MORTA SUSTENTADA (agente online, serial morta >= 5 min).
    // ─────────────────────────────────────────────────────────────────────
    const bridgeDead = r.last_error === "bridge_dead" || r.com_connected === false;
    const bs = stBridge.get(r.farm_id);
    if (bridgeDead) {
      if (bs?.is_active) {
        // já alertado — não repete
      } else {
        const firstAt = bs?.metadata?.first_dead_at ? new Date(bs.metadata.first_dead_at).getTime() : null;
        if (firstAt === null) {
          // 1ª vez que vejo morta → inicia o relógio da graça (5 min). NÃO alerta.
          await supabase.from("watchdog_alerts_state").upsert({
            farm_id: r.farm_id, alert_type: "bridge_down", is_active: false,
            last_sent_at: nowIso, metadata: { first_dead_at: nowIso }, updated_at: nowIso,
          }, { onConflict: "farm_id,alert_type" });
        } else if (nowMs - firstAt >= BRIDGE_DEAD_GRACE_MS) {
          // Morta há >= 5 min e NÃO recuperou → ALERTA (o notify marca is_active=true).
          const downMin = Math.round((nowMs - firstAt) / 60_000);
          const res = await invokeAlert({
            type: "alert", immediate: true, source: "agent_offline_watchdog",
            alert_type: "bridge_down", farm_id: r.farm_id, farm_name: farmName, equipment_name: "Bridge serial",
            message: `🟠 BRIDGE MORTA — ${farmName} (serial não recupera há ${downMin} min)`,
            metadata: { last_error: r.last_error, down_min: downMin, first_dead_at: bs?.metadata?.first_dead_at },
          });
          results.push({ farm_id: r.farm_id, kind: "bridge_down", down_min: downMin, ...res });
        }
        // else: dentro da janela de graça (< 5 min) → silêncio (pode recuperar sozinha)
      }
    } else if (bs) {
      // Serial voltou (ou nunca morreu de fato) → limpa em SILÊNCIO. Se estava só
      // na graça, nunca alertou; se já tinha alertado, some sem "restaurada".
      await clearState(r.farm_id, "bridge_down");
    }
  }

  return new Response(
    JSON.stringify({ ok: true, checked: sh?.length ?? 0, results }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
