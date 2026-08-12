// Edge Function: well-hours-watchdog  (agendada por pg_cron a cada 10 min)
// ─────────────────────────────────────────────────────────────────────────────
// Compliance preventivo de HORAS da outorga. Para cada fazenda com alertas
// ligados, compara as horas operadas HOJE de cada poço com o limite diário da
// outorga (water_permits.regime_hours_per_day). Quando faltar ≤ 1h para o limite,
// envia WhatsApp ao técnico da fazenda:
//   "⚠️ POÇO XX — Falta 1h para atingir o limite de 18h/dia da outorga. Considere desligar."
//
// Envio: Meta Cloud API (template `alerta_equipamento`, 4 params), reusando as
// credenciais de whatsapp_config. NÃO passa pelo whatsapp-automation-notify porque
// o gate de política daquela função descarta alertas que não sejam agent_offline/
// bridge_down — então este watchdog envia direto (mesmo template/número).
//
// Recipientes: whatsapp_alert_settings.technical_team_phone por fazenda (gate:
// alerts_enabled). Dedup: 1 alerta por (fazenda, poço) por DIA (BRT), via
// watchdog_alerts_state (alert_type = "hours_limit:<equipment_id>").
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const TZ = "America/Sao_Paulo";
const REMAINING_ALERT_HOURS = 1; // avisa quando faltar ≤ 1h

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Primeiro número do texto ("Poço 3" → 3; "POÇO 03 R2" → 3). NÃO concatena dígitos.
const firstNum = (s: string | null | undefined): number => {
  const m = String(s ?? "").match(/\d+/);
  return m ? parseInt(m[0], 10) : NaN;
};
const dayInTz = (d: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // yyyy-mm-dd
const fmtHm = (h: number): string => {
  const total = Math.max(0, Math.round(h * 60));
  const hh = Math.floor(total / 60), mm = total % 60;
  return hh === 0 ? `${mm}min` : `${hh}h ${String(mm).padStart(2, "0")}min`;
};
// Normalização BR simples (só dígitos; garante DDI 55). O notify tem uma
// normalizePhoneKey mais completa (9º dígito) — alinhar se necessário.
const normPhone = (p: string | null | undefined): string => {
  let d = String(p ?? "").replace(/\D/g, "");
  if (!d) return "";
  if ((d.length === 10 || d.length === 11) && !d.startsWith("55")) d = "55" + d;
  return d;
};

async function sendTemplate(token: string, phoneNumberId: string, to: string, params: string[]): Promise<boolean> {
  const toDigits = normPhone(to);
  if (!toDigits) return false;
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toDigits,
        type: "template",
        template: {
          name: "alerta_equipamento",
          language: { code: "pt_BR" },
          components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: String(p) })) }],
        },
      }),
    });
    const j = await r.json().catch(() => ({} as any));
    if (!r.ok || (j as any)?.error) {
      console.error("[well-hours] meta send fail", toDigits, JSON.stringify((j as any)?.error ?? j));
      return false;
    }
    return true;
  } catch (e) {
    console.error("[well-hours] send error", (e as Error).message);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const now = new Date();
  const today = dayInTz(now);
  const todayStartIso = new Date(`${today}T00:00:00-03:00`).toISOString(); // início do dia BRT
  const nowIso = now.toISOString();

  // Credenciais Meta por fazenda (whatsapp_config) + fallback global.
  const { data: cfgRows } = await supabase.from("whatsapp_config").select("farm_id, api_token, phone_number_id");
  const cfgByFarm = new Map<string, { token: string; pnid: string }>();
  let cfgGlobal: { token: string; pnid: string } | null = null;
  for (const c of (cfgRows ?? []) as any[]) {
    if (!c.api_token || !c.phone_number_id) continue;
    const entry = { token: c.api_token as string, pnid: c.phone_number_id as string };
    if (c.farm_id) cfgByFarm.set(c.farm_id, entry);
    if (!cfgGlobal) cfgGlobal = entry;
  }
  if (!cfgGlobal && cfgByFarm.size === 0) return json({ ok: true, checked: 0, sent: 0, note: "no whatsapp_config" });

  // Fazendas com alertas ligados + telefone do técnico.
  const { data: settings } = await supabase.from("whatsapp_alert_settings").select("farm_id, alerts_enabled, technical_team_phone");
  const recipientByFarm = new Map<string, string>();
  for (const s of (settings ?? []) as any[]) {
    if (s.farm_id && s.alerts_enabled && s.technical_team_phone) recipientByFarm.set(s.farm_id, s.technical_team_phone);
  }
  if (recipientByFarm.size === 0) return json({ ok: true, checked: 0, sent: 0, note: "no recipients" });

  // Estado de dedup (alertas de horas já enviados).
  const { data: states } = await supabase.from("watchdog_alerts_state")
    .select("farm_id, alert_type, last_sent_at").like("alert_type", "hours_limit:%");
  const lastByKey = new Map<string, string>();
  for (const st of (states ?? []) as any[]) lastByKey.set(`${st.farm_id}|${st.alert_type}`, st.last_sent_at);

  let checked = 0, sent = 0;

  for (const [farmId, phone] of recipientByFarm) {
    const cfg = cfgByFarm.get(farmId) ?? cfgGlobal;
    if (!cfg) continue;

    // Outorgas + poços → limite de horas por equipamento (vínculo explícito ou nº).
    const { data: permits } = await supabase.from("water_permits").select("id, regime_hours_per_day").eq("farm_id", farmId);
    if (!permits?.length) continue;
    const { data: wells } = await supabase.from("water_permit_wells")
      .select("permit_id, equipment_id, well_name").in("permit_id", (permits as any[]).map((p) => p.id));
    const regimeByPermit = new Map<string, number>((permits as any[]).map((p) => [p.id, Number(p.regime_hours_per_day ?? 18) || 18]));
    const limitByEq = new Map<string, number>();
    const limitByNum = new Map<number, number>();
    for (const w of (wells ?? []) as any[]) {
      const hrs = regimeByPermit.get(w.permit_id) ?? 18;
      if (w.equipment_id && !limitByEq.has(w.equipment_id)) limitByEq.set(w.equipment_id, hrs);
      const n = firstNum(w.well_name);
      if (Number.isFinite(n) && !limitByNum.has(n)) limitByNum.set(n, hrs);
    }

    const { data: farm } = await supabase.from("farms").select("name").eq("id", farmId).maybeSingle();
    const farmName = (farm as any)?.name ?? "Fazenda";

    // Horas operadas HOJE por poço.
    const { data: horas } = await supabase.rpc("get_horimetro_daily", { _farm_id: farmId, _from: todayStartIso, _to: nowIso });
    const hoursByEq = new Map<string, number>();
    const nameByEq = new Map<string, string>();
    for (const r of (horas ?? []) as Array<{ equipment_id: string; equipment_name: string; hours: number }>) {
      hoursByEq.set(r.equipment_id, (hoursByEq.get(r.equipment_id) ?? 0) + Number(r.hours || 0));
      nameByEq.set(r.equipment_id, r.equipment_name);
    }

    for (const [eqId, h] of hoursByEq) {
      let limit = limitByEq.get(eqId);
      if (limit == null) { const n = firstNum(nameByEq.get(eqId)); if (Number.isFinite(n)) limit = limitByNum.get(n); }
      if (limit == null || limit <= 0) continue; // sem outorga vinculada → não avalia
      checked++;
      const remaining = limit - h;
      if (remaining > REMAINING_ALERT_HOURS) continue; // ainda longe do limite

      // Dedup: 1 alerta por poço por DIA.
      const alertType = `hours_limit:${eqId}`;
      const last = lastByKey.get(`${farmId}|${alertType}`);
      if (last && dayInTz(new Date(last)) === today) continue;

      const poco = nameByEq.get(eqId) ?? "Poço";
      const detalhe = remaining <= 0
        ? `${poco} atingiu o limite de ${limit}h/dia da outorga. Desligue para evitar infração.`
        : `Falta ${fmtHm(remaining)} para ${poco} atingir o limite de ${limit}h/dia da outorga. Considere desligar.`;
      // Template alerta_equipamento (4 slots): {{1}} fazenda, {{2}} equipamento, {{3}} tipo, {{4}} detalhes.
      const params = [farmName, poco, "Limite de horas da outorga", detalhe];

      const okSend = await sendTemplate(cfg.token, cfg.pnid, phone, params);
      if (okSend) {
        sent++;
        await supabase.from("watchdog_alerts_state").upsert({
          farm_id: farmId,
          alert_type: alertType,
          is_active: true,
          last_sent_at: new Date().toISOString(),
          metadata: { equipment_id: eqId, poco, hours: Math.round(h * 100) / 100, limit, remaining_h: Math.round(remaining * 100) / 100 },
          updated_at: new Date().toISOString(),
        }, { onConflict: "farm_id,alert_type" });
      }
    }
  }

  return json({ ok: true, checked, sent });
});
