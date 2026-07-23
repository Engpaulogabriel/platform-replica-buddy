// offline-daily-report
// Roda 1x/dia às 18:00 BRT (21:00 UTC). Lista equipamentos com
// communication_status='offline' agrupados por fazenda e envia:
//  1) Relatório ao super_admin (557799608294) — pergunta a data da visita
//  2) Solicitação de visita ao time técnico (technical_team_phone)
//
// Suprime equipamentos que já possuem visita técnica agendada
// (maintenance_visits.status='pending' e scheduled_date >= hoje).
// Se nenhum equipamento offline restar após o filtro, encerra sem enviar nada.
//
// Também grava conversation_state 'awaiting_visit_date' para o super_admin,
// permitindo que o whatsapp-webhook capture a data respondida.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const GRAPH_VERSION = "v21.0";
const SUPER_ADMIN_PHONE = "557799608294";

function humanizeOfflineDuration(lastComm: string | null): string {
  if (!lastComm) return "tempo indeterminado";
  const ms = Date.now() - new Date(lastComm).getTime();
  if (ms < 0) return "agora";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 dia" : `${days} dias`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 1) Carrega equipamentos offline.
  const fifteenMinAgo = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: equipsRaw, error: eqErr } = await sb
    .from("equipments")
    .select("id, farm_id, name, communication_status, last_communication")
    .eq("active", true)
    .not("last_communication", "is", null)
    .or(`communication_status.eq.offline,last_communication.lt.${fifteenMinAgo}`);

  if (eqErr) {
    console.error("[offline-daily-report] equipments query failed", eqErr);
    return new Response(JSON.stringify({ error: eqErr.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let equips = (equipsRaw ?? []) as Array<{
    id: string; farm_id: string; name: string;
    communication_status: string; last_communication: string | null;
  }>;

  // 1b) Filtra equipamentos com visita técnica já agendada (pending, data >= hoje).
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const todayIso = today.toISOString().slice(0, 10);
  const { data: visitRows } = await sb
    .from("maintenance_visits")
    .select("equipment_ids, scheduled_date, status")
    .eq("status", "pending")
    .gte("scheduled_date", todayIso);
  const suppressed = new Set<string>();
  for (const v of (visitRows ?? []) as Array<{ equipment_ids: string[] }>) {
    for (const eid of v.equipment_ids ?? []) suppressed.add(eid);
  }
  if (suppressed.size > 0) {
    equips = equips.filter((e) => !suppressed.has(e.id));
  }

  if (equips.length === 0) {
    return new Response(JSON.stringify({
      status: "no_offline_equipment", suppressed_count: suppressed.size,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // 2) Resolve nomes de fazendas.
  const farmIds = Array.from(new Set(equips.map((e) => e.farm_id)));
  const { data: farmRows } = await sb.from("farms").select("id, name").in("id", farmIds);
  const farmNameById = new Map<string, string>();
  for (const f of (farmRows ?? []) as Array<{ id: string; name: string }>) {
    farmNameById.set(f.id, f.name);
  }

  // 3) Agrupa por fazenda (mantém farm_id para tracking de visita).
  type Item = { id: string; name: string; duration: string };
  type Group = { farm_id: string; farm_name: string; items: Item[] };
  const groupsMap = new Map<string, Group>();
  for (const e of equips) {
    const farmName = farmNameById.get(e.farm_id) ?? "Fazenda";
    let g = groupsMap.get(e.farm_id);
    if (!g) {
      g = { farm_id: e.farm_id, farm_name: farmName, items: [] };
      groupsMap.set(e.farm_id, g);
    }
    g.items.push({ id: e.id, name: e.name, duration: humanizeOfflineDuration(e.last_communication) });
  }
  const groups = Array.from(groupsMap.values()).sort((a, b) => a.farm_name.localeCompare(b.farm_name));
  for (const g of groups) g.items.sort((a, b) => a.name.localeCompare(b.name));

  // 4) Monta mensagens.
  const farmBlocks = groups.map((g) => {
    const lines = g.items.map((it) => `• ${it.name} — offline há ${it.duration}`).join("\n");
    return `${g.farm_name}:\n${lines}`;
  }).join("\n\n");

  const gestorMsg =
    `⚠️ Relatório diário — Equipamentos Offline\n\n${farmBlocks}\n\n` +
    `📋 Notificação enviada ao time técnico. Qual a data da visita?`;

  const techMsg =
    `🔧 Solicitação de visita técnica\n\n` +
    `Equipamentos offline que precisam de verificação:\n\n${farmBlocks}\n\n` +
    `Por favor agendar visita para resolver.`;

  // 5) Carrega config (token bot) + technical_team_phone.
  const { data: cfg } = await sb
    .from("whatsapp_config").select("api_token, bot_number").limit(1).maybeSingle();
  if (!cfg?.api_token || !cfg?.bot_number) {
    return new Response(JSON.stringify({ error: "no_whatsapp_config" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { data: alertSettings } = await sb
    .from("whatsapp_alert_settings").select("technical_team_phone").limit(1).maybeSingle();
  const techPhone = (alertSettings?.technical_team_phone as string | null) || SUPER_ADMIN_PHONE;

  async function sendText(to: string, body: string): Promise<string | null> {
    try {
      const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${cfg!.bot_number}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg!.api_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || (j as any)?.error) {
        console.error("[offline-daily-report] send failed", to, JSON.stringify((j as any)?.error || j));
      }
      return (j as any)?.messages?.[0]?.id ?? null;
    } catch (e) {
      console.error("[offline-daily-report] send err", to, e);
      return null;
    }
  }

  const sent: Record<string, string | null> = {};
  sent.gestor = await sendText(SUPER_ADMIN_PHONE, gestorMsg);
  sent.tech = await sendText(techPhone, techMsg);

  // 6) Grava conversation_state aguardando data da visita (TTL longo).
  try {
    await sb.from("whatsapp_conversation_state").upsert({
      operator_phone: SUPER_ADMIN_PHONE,
      awaiting: "awaiting_visit_date",
      context: {
        groups: groups.map((g) => ({
          farm_id: g.farm_id,
          farm_name: g.farm_name,
          equipment_ids: g.items.map((i) => i.id),
          equipment_names: g.items.map((i) => i.name),
        })),
        created_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: "operator_phone" });
  } catch (e) {
    console.error("[offline-daily-report] save conv state failed", e);
  }

  // 7) Log.
  try {
    await sb.from("whatsapp_message_log").insert([
      {
        direction: "outgoing", phone: SUPER_ADMIN_PHONE,
        message_type: "alert", message_body: gestorMsg, message_id: sent.gestor,
        metadata: { alert_type: "offline_daily_report_gestor", count: equips.length },
      },
      {
        direction: "outgoing", phone: techPhone,
        message_type: "alert", message_body: techMsg, message_id: sent.tech,
        metadata: { alert_type: "offline_daily_report_tech", count: equips.length },
      },
    ]);
  } catch (e) {
    console.error("[offline-daily-report] log failed", e);
  }

  return new Response(JSON.stringify({
    status: "sent", offline_count: equips.length,
    suppressed_count: suppressed.size,
    farms: groups.length, gestor_id: sent.gestor, tech_id: sent.tech,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
