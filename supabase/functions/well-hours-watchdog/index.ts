// Edge Function: well-hours-watchdog  (agendada por pg_cron a cada 5 min)
// ─────────────────────────────────────────────────────────────────────────────
// Compliance preventivo de HORAS da outorga. Para cada fazenda com alertas
// ligados, compara as horas operadas HOJE de cada poço com o limite diário da
// outorga (water_permits.regime_hours_per_day) e envia avisos ESCALONADOS por
// WhatsApp ao técnico conforme o tempo restante:
//   1h → 45min → 30min → 15min → 8min → 5min → 3min → LIMITE ATINGIDO.
// Cada FAIXA dispara 1x por poço por dia (quando cai pra próxima faixa, avisa de novo).
//
// Envio: Meta Cloud API (template `alerta_equipamento`, 4 params), reusando as
// credenciais de whatsapp_config. NÃO passa pelo whatsapp-automation-notify porque
// o gate de política daquela função descarta alertas que não sejam agent_offline/
// bridge_down — então este watchdog envia direto (mesmo template/número).
//
// Recipientes: TODOS os números da fazenda — operadores ativos de whatsapp_operators
// (respeitando receive_alerts / preferência) + technical_team_phone de
// whatsapp_alert_settings, normalizados e deduplicados. Gate: alerts_enabled.
// Compliance é crítico → todos recebem. Telefone alinhado à normalizePhoneKey do
// whatsapp-automation-notify (insere o 9º dígito BR). Dedup dos avisos: por FAIXA,
// 1x por (fazenda, poço, faixa) por dia (BRT), via watchdog_alerts_state.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const TZ = "America/Sao_Paulo";

// Faixas de aviso (minutos restantes para o limite). Cada faixa dispara 1x por
// poço por dia. Cron a cada 5 min cobre as faixas curtas (8/5/3 min).
const TIERS = [60, 45, 30, 15, 8, 5, 3];
// Faixa atual = menor limiar >= restante; "limit" quando restante <= 0; null se >60min.
function currentTier(remMin: number): string | null {
  if (remMin <= 0) return "limit";
  const t = TIERS.filter((T) => T >= remMin).sort((a, b) => a - b)[0];
  return t != null ? String(t) : null;
}
const tierLabel = (tier: string): string => (tier === "60" ? "1h" : `${tier}min`);

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Primeiro número do texto ("Poço 3" → 3; "POÇO 03 R2" → 3). NÃO concatena dígitos.
const firstNum = (s: string | null | undefined): number => {
  const m = String(s ?? "").match(/\d+/);
  return m ? parseInt(m[0], 10) : NaN;
};
const dayInTz = (d: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // yyyy-mm-dd
// Normalização BR alinhada ao whatsapp-automation-notify: prepende DDI 55 e
// insere o 9º dígito do celular quando o número vem com 12 dígitos (55 + DDD + 8
// locais). Idempotente para números já normalizados (13 dígitos).
function normalizePhoneKey(phone: string | null | undefined): string {
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (!digits.startsWith("55") && (digits.length === 10 || digits.length === 11)) digits = `55${digits}`;
  if (digits.startsWith("55")) {
    const rest = digits.slice(2); // DDD(2) + local
    if (rest.length === 10) digits = `55${rest.slice(0, 2)}9${rest.slice(2)}`;
  }
  return digits;
}

async function sendTemplate(token: string, phoneNumberId: string, to: string, params: string[]): Promise<boolean> {
  const toDigits = normalizePhoneKey(to);
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

  // Fazendas com alertas ligados (gate) + technical_team_phone.
  const { data: settings } = await supabase.from("whatsapp_alert_settings").select("farm_id, alerts_enabled, technical_team_phone");
  const enabledFarms = new Set<string>();
  const techByFarm = new Map<string, string[]>();
  for (const s of (settings ?? []) as any[]) {
    if (!s.farm_id || !s.alerts_enabled) continue;
    enabledFarms.add(s.farm_id);
    if (s.technical_team_phone) techByFarm.set(s.farm_id, [...(techByFarm.get(s.farm_id) ?? []), s.technical_team_phone]);
  }
  if (enabledFarms.size === 0) return json({ ok: true, checked: 0, sent: 0, note: "no farms with alerts_enabled" });

  // TODOS os operadores ativos por fazenda (whatsapp_operators) — respeita
  // receive_alerts e preferência (mute). Compliance é crítico: todos recebem.
  const { data: operators } = await supabase.from("whatsapp_operators")
    .select("phone, notification_preference, receive_alerts, farm_id, default_farm_id, is_active")
    .eq("is_active", true);
  const opByFarm = new Map<string, string[]>();
  for (const o of (operators ?? []) as any[]) {
    if (!o.phone) continue;
    const pref = String(o.notification_preference ?? "default").toLowerCase();
    if (pref === "mute" || pref === "mudo" || o.receive_alerts === false) continue;
    const farmsFor = new Set<string>([o.farm_id, o.default_farm_id].filter(Boolean) as string[]);
    for (const f of farmsFor) {
      if (!enabledFarms.has(f)) continue;
      opByFarm.set(f, [...(opByFarm.get(f) ?? []), o.phone]);
    }
  }

  // Recipientes finais por fazenda: operadores + técnico, normalizados e ÚNICOS.
  const recipientsByFarm = new Map<string, string[]>();
  for (const f of enabledFarms) {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const p of [...(opByFarm.get(f) ?? []), ...(techByFarm.get(f) ?? [])]) {
      const key = normalizePhoneKey(p);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      list.push(key);
    }
    if (list.length) recipientsByFarm.set(f, list);
  }
  if (recipientsByFarm.size === 0) return json({ ok: true, checked: 0, sent: 0, note: "no recipients" });

  // Estado de dedup (alertas de horas já enviados).
  const { data: states } = await supabase.from("watchdog_alerts_state")
    .select("farm_id, alert_type, last_sent_at").like("alert_type", "hours_limit:%");
  const lastByKey = new Map<string, string>();
  for (const st of (states ?? []) as any[]) lastByKey.set(`${st.farm_id}|${st.alert_type}`, st.last_sent_at);

  let checked = 0, sent = 0;

  for (const [farmId, phones] of recipientsByFarm) {
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
      const remainingMin = (limit - h) * 60;
      const tier = currentTier(remainingMin);
      if (tier == null) continue; // ainda > 1h do limite → sem aviso

      // Dedup POR FAIXA: cada faixa (1h/45/30/15/8/5/3/limit) dispara 1x por poço por dia.
      const alertType = `hours_limit:${eqId}:${tier}`;
      const last = lastByKey.get(`${farmId}|${alertType}`);
      if (last && dayInTz(new Date(last)) === today) continue;

      const poco = nameByEq.get(eqId) ?? "Poço";
      const isLimit = tier === "limit";
      const tipo = isLimit ? "🚨 LIMITE ATINGIDO" : "Limite de horas (aviso preventivo)";
      const detalhe = isLimit
        ? `${poco} — LIMITE DE ${limit}h/dia ATINGIDO. Desligue IMEDIATAMENTE para evitar infração INEMA.`
        : `Faltam ${tierLabel(tier)} para ${poco} atingir o limite de ${limit}h/dia da outorga. Considere desligar.`;
      // Template alerta_equipamento (4 slots): {{1}} fazenda, {{2}} equipamento, {{3}} tipo, {{4}} detalhes.
      const params = [farmName, poco, tipo, detalhe];

      // Envia a TODOS os recipientes da fazenda. A faixa é marcada como enviada
      // se AO MENOS um envio deu certo (evita reenvio no próximo cron).
      let anyOk = false;
      for (const to of phones) {
        if (await sendTemplate(cfg.token, cfg.pnid, to, params)) anyOk = true;
      }
      if (anyOk) {
        sent++;
        await supabase.from("watchdog_alerts_state").upsert({
          farm_id: farmId,
          alert_type: alertType,
          is_active: true,
          last_sent_at: new Date().toISOString(),
          metadata: { equipment_id: eqId, poco, tier, hours: Math.round(h * 100) / 100, limit, remaining_min: Math.round(remainingMin), recipients: phones.length },
          updated_at: new Date().toISOString(),
        }, { onConflict: "farm_id,alert_type" });
      }
    }
  }

  return json({ ok: true, checked, sent });
});
