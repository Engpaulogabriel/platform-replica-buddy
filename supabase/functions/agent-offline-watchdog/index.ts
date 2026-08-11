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
const DAILY_REMINDER_MS = 24 * 60 * 60_000; // reenvio: no máximo 1x/dia enquanto persistir

// ── EMAIL crítico (Resend) — configs por env (secret na edge function) ──────
const EMAIL_TO = Deno.env.get("ALERT_EMAIL_TO") || "contato@renovelectronics.com.br";
const RESEND_FROM = Deno.env.get("RESEND_FROM") || "RENOV Alertas <onboarding@resend.dev>";
const PLATFORM_URL = Deno.env.get("PLATFORM_URL") || "https://app.renovelectronics.com.br";

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Bahia" }); }
  catch { return String(iso); }
}

// Só é enviado para os 2 alertas CRÍTICOS (agente offline / bridge morta). Best-effort:
// se RESEND_API_KEY não estiver configurada ou a API falhar, não quebra o alerta WhatsApp.
async function sendCriticalEmail(subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) { console.warn("[email] RESEND_API_KEY não configurada — pulando email"); return { ok: false, error: "no_key" }; }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to: [EMAIL_TO], subject, html }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("[email] Resend falhou", r.status, t.slice(0, 200));
      return { ok: false, error: `http_${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.error("[email] erro:", (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

function criticalEmailHtml(o: { title: string; farmName: string; erro: string; lastHeartbeat: string; acao: string; barColor: string }): string {
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111827;background:#f3f4f6;margin:0;padding:16px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="background:${o.barColor};color:#fff;padding:16px 20px"><h2 style="margin:0;font-size:18px">${o.title}</h2></div>
    <div style="padding:20px">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#6b7280;width:140px">Fazenda</td><td style="padding:6px 0;font-weight:bold">${o.farmName}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Erro</td><td style="padding:6px 0;font-weight:bold">${o.erro}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Último heartbeat</td><td style="padding:6px 0">${o.lastHeartbeat}</td></tr>
      </table>
      <p style="margin:16px 0 8px;padding:12px;background:#fef2f2;border-left:4px solid #b91c1c;border-radius:4px;font-size:14px">
        <strong>Ação necessária:</strong> ${o.acao}</p>
      <a href="${PLATFORM_URL}" style="display:inline-block;margin-top:8px;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold;font-size:14px">Abrir plataforma</a>
    </div>
  </div></body></html>`;
}

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
    .select("farm_id, alert_type, is_active, last_sent_at, metadata")
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
      // Dedup AUTO-CONTIDO: envia 1x por ocorrência; enquanto seguir offline, só
      // reenvia como lembrete diário (>=24h). Voltar online apaga o estado
      // (clearState) → uma nova queda futura volta a alertar na hora.
      const stA = stAgent.get(r.farm_id);
      const lastSentMs = stA?.last_sent_at ? new Date(stA.last_sent_at).getTime() : 0;
      const isReminder = !!stA?.is_active && lastSentMs > 0 && (nowMs - lastSentMs) >= DAILY_REMINDER_MS;
      const shouldSend = !stA?.is_active || isReminder;
      if (shouldSend) {
        const res = await invokeAlert({
          type: "alert", immediate: true, source: "agent_offline_watchdog",
          alert_type: "agent_offline", farm_id: r.farm_id, farm_name: farmName, equipment_name: "Sistema",
          message: `🔴 AGENTE OFFLINE — ${farmName}`,
          metadata: { age_sec: Math.round(hbAge / 1000), last_heartbeat: r.last_heartbeat, reminder: isReminder },
        });
        // LATCH próprio (não depende do notify): marca ativo + carimbo de envio.
        try {
          await supabase.from("watchdog_alerts_state").upsert({
            farm_id: r.farm_id, alert_type: "agent_offline", is_active: true,
            last_sent_at: nowIso,
            metadata: { last_heartbeat: r.last_heartbeat, first_offline_at: stA?.metadata?.first_offline_at ?? nowIso },
            updated_at: nowIso,
          }, { onConflict: "farm_id,alert_type" });
        } catch (_) { /* best-effort */ }
        // EMAIL crítico (item 2) — mesma ocorrência, best-effort.
        const email = await sendCriticalEmail(
          `🔴 ALERTA RENOV — Fazenda ${farmName} OFFLINE`,
          criticalEmailHtml({
            title: `🔴 AGENTE OFFLINE — ${farmName}`, farmName,
            erro: `Sem heartbeat há ${Math.round(hbAge / 60_000)} min (PC ou Starlink caiu)`,
            lastHeartbeat: fmtTs(r.last_heartbeat),
            acao: "Verificar energia e internet (Starlink) na fazenda e se o PC do agente está ligado.",
            barColor: "#b91c1c",
          }),
        );
        results.push({ farm_id: r.farm_id, kind: "agent_offline", ...res, email: email.ok });
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
      const bLastSentMs = bs?.is_active && bs?.last_sent_at ? new Date(bs.last_sent_at).getTime() : 0;
      const bIsReminder = !!bs?.is_active && bLastSentMs > 0 && (nowMs - bLastSentMs) >= DAILY_REMINDER_MS;
      if (bs?.is_active && !bIsReminder) {
        // já alertado nas últimas 24h — não repete
      } else if (bIsReminder) {
        // segue morta há >= 24h → lembrete diário (1x/dia), re-latch.
        const firstAt = bs?.metadata?.first_dead_at ? new Date(bs.metadata.first_dead_at).getTime() : nowMs;
        const downMin = Math.round((nowMs - firstAt) / 60_000);
        const res = await invokeAlert({
          type: "alert", immediate: true, source: "agent_offline_watchdog",
          alert_type: "bridge_down", farm_id: r.farm_id, farm_name: farmName, equipment_name: "Bridge serial",
          message: `🟠 BRIDGE MORTA — ${farmName} (serial não recupera há ${downMin} min)`,
          metadata: { last_error: r.last_error, down_min: downMin, first_dead_at: bs?.metadata?.first_dead_at, reminder: true },
        });
        try {
          await supabase.from("watchdog_alerts_state").upsert({
            farm_id: r.farm_id, alert_type: "bridge_down", is_active: true, last_sent_at: nowIso,
            metadata: { first_dead_at: bs?.metadata?.first_dead_at ?? nowIso }, updated_at: nowIso,
          }, { onConflict: "farm_id,alert_type" });
        } catch (_) { /* best-effort */ }
        results.push({ farm_id: r.farm_id, kind: "bridge_down", down_min: downMin, reminder: true, ...res });
      } else {
        const firstAt = bs?.metadata?.first_dead_at ? new Date(bs.metadata.first_dead_at).getTime() : null;
        if (firstAt === null) {
          // 1ª vez que vejo morta → inicia o relógio da graça (5 min). NÃO alerta.
          await supabase.from("watchdog_alerts_state").upsert({
            farm_id: r.farm_id, alert_type: "bridge_down", is_active: false,
            last_sent_at: nowIso, metadata: { first_dead_at: nowIso }, updated_at: nowIso,
          }, { onConflict: "farm_id,alert_type" });
        } else if (nowMs - firstAt >= BRIDGE_DEAD_GRACE_MS) {
          // Morta há >= 5 min e NÃO recuperou → ALERTA (1x). Self-latch is_active=true.
          const downMin = Math.round((nowMs - firstAt) / 60_000);
          const res = await invokeAlert({
            type: "alert", immediate: true, source: "agent_offline_watchdog",
            alert_type: "bridge_down", farm_id: r.farm_id, farm_name: farmName, equipment_name: "Bridge serial",
            message: `🟠 BRIDGE MORTA — ${farmName} (serial não recupera há ${downMin} min)`,
            metadata: { last_error: r.last_error, down_min: downMin, first_dead_at: bs?.metadata?.first_dead_at },
          });
          try {
            await supabase.from("watchdog_alerts_state").upsert({
              farm_id: r.farm_id, alert_type: "bridge_down", is_active: true, last_sent_at: nowIso,
              metadata: { first_dead_at: bs?.metadata?.first_dead_at ?? nowIso }, updated_at: nowIso,
            }, { onConflict: "farm_id,alert_type" });
          } catch (_) { /* best-effort */ }
          // EMAIL crítico (item 2) — best-effort.
          const email = await sendCriticalEmail(
            `🟠 ALERTA RENOV — Fazenda ${farmName} SEM CONTROLE (bridge morta)`,
            criticalEmailHtml({
              title: `🟠 BRIDGE MORTA — ${farmName}`, farmName,
              erro: `serial_bridge morta há ${downMin} min (${r.last_error || "bridge_dead"}) — agente online, sem controle de bombas`,
              lastHeartbeat: fmtTs(r.last_heartbeat),
              acao: "Verificar cabo serial / porta COM / serial_bridge no PC da fazenda. O agente está online mas não controla as bombas.",
              barColor: "#c2410c",
            }),
          );
          results.push({ farm_id: r.farm_id, kind: "bridge_down", down_min: downMin, ...res, email: email.ok });
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
