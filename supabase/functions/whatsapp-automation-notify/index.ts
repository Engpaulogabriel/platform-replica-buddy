// Envia notificações WhatsApp das execuções do motor de automação.
// Rodado a cada minuto via pg_cron. Lê automation_execution_log com notified_at IS NULL,
// agrupa por (farm_id, action, scheduled_time) e envia uma mensagem consolidada
// aos operadores ativos. Não interfere com whatsapp_pending_actions.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TZ = "America/Sao_Paulo";
const DAY_SHORT_PT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

// ── Dedup de notificações equipment_control ────────────────────────────────
// Evita disparos duplicados (12x observados em produção) para o mesmo
// equipamento + estado dentro de uma janela curta. Chave: eqId_state_minute.
// Limpeza automática de entradas > 2 min.
const recentEquipmentControlNotifs = new Map<string, number>();
function shouldSkipEquipmentControl(equipmentId: string, action: string): boolean {
  const now = Date.now();
  // GC de entradas antigas (> 120s)
  for (const [k, ts] of recentEquipmentControlNotifs) {
    if (now - ts > 120_000) recentEquipmentControlNotifs.delete(k);
  }
  const minuteBucket = Math.floor(now / 60_000);
  const key = `${equipmentId}_${action}_${minuteBucket}`;
  const prevMinute = `${equipmentId}_${action}_${minuteBucket - 1}`;
  // Se já enviado neste minuto ou no minuto anterior (< 60s), pula
  const last = recentEquipmentControlNotifs.get(key) ?? recentEquipmentControlNotifs.get(prevMinute);
  if (last && (now - last) < 60_000) return true;
  recentEquipmentControlNotifs.set(key, now);
  return false;
}

function fmtDateLine(d: Date): string {
  const wd = DAY_SHORT_PT[Number(new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ }).format(d) === "" ? d.getDay() : d.getDay())];
  const dStr = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ }).format(d);
  // Re-derive weekday in TZ
  const weekdayIdxStr = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ }).format(d);
  const map: Record<string, string> = { Sun: "Dom", Mon: "Seg", Tue: "Ter", Wed: "Qua", Thu: "Qui", Fri: "Sex", Sat: "Sáb" };
  return `${map[weekdayIdxStr] ?? wd}, ${dStr}`;
}

const DAY_CODES = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
function fmtDaysRange(days: string[] | null | undefined): string {
  if (!days || days.length === 0) return "—";
  const set = new Set(days.map((d) => d.toLowerCase()));
  const weekdays = ["seg", "ter", "qua", "qui", "sex"];
  const weekend = ["sab", "dom"];
  if (weekdays.every((d) => set.has(d)) && weekend.every((d) => set.has(d))) return "Todos os dias";
  if (weekdays.every((d) => set.has(d)) && !weekend.some((d) => set.has(d))) return "Seg-Sex";
  if (set.has("sab") && set.has("dom") && weekdays.every((d) => !set.has(d))) return "Sáb-Dom";
  const labels: Record<string, string> = { dom: "Dom", seg: "Seg", ter: "Ter", qua: "Qua", qui: "Qui", sex: "Sex", sab: "Sáb" };
  return DAY_CODES.filter((d) => set.has(d)).map((d) => labels[d]).join("-");
}

function hhmm(t: string | null | undefined): string {
  if (!t) return "—";
  return String(t).slice(0, 5);
}

function fmtShortTimestamp(d: Date): string {
  return d.toLocaleString("pt-BR", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }) + "h";
}

function normalizePhoneKey(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("55") ? digits : `55${digits}`;
}

// Phone format the Meta API expects: digits only (we use the E.164 digits without "+").
function phoneToApi(phone: string | null | undefined): string {
  return normalizePhoneKey(phone);
}

// Template params can't contain newlines, tabs, or >4 consecutive spaces.
function sanitizeTplParam(s: string): string {
  return String(s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

function metaErrorCode(err: unknown): number | null {
  const e = err as any;
  const code = e?.code ?? e?.error?.code;
  const n = Number(code);
  if (!Number.isFinite(n) && err != null && JSON.stringify(err).includes("131047")) return 131047;
  return Number.isFinite(n) ? n : null;
}

function farmDisplayName(name: string): string {
  const clean = String(name || "—").trim();
  if (!clean || clean === "—") return "—";
  return clean.replace(/^fazenda\s+/i, "Fazenda ");
}

function farmLine(name: string): string {
  const clean = farmDisplayName(name);
  return /^fazenda\b/i.test(clean) ? clean : `Fazenda ${clean}`;
}

function templateParamsFor(name: string, params: string[]): string[] {
  return params.map(sanitizeTplParam);
}


function addOperatorOnce(
  opsByFarm: Map<string, any[]>,
  phoneKeysByFarm: Map<string, Set<string>>,
  farmId: string,
  operator: any,
) {
  const key = normalizePhoneKey(operator?.phone);
  if (!key) return;
  const keys = phoneKeysByFarm.get(farmId) ?? new Set<string>();
  if (keys.has(key)) return;
  keys.add(key);
  phoneKeysByFarm.set(farmId, keys);
  const list = opsByFarm.get(farmId) ?? [];
  list.push(operator);
  opsByFarm.set(farmId, list);
}

function sourceLabel(value: string | null | undefined): string {
  const v = String(value ?? "").trim();
  const key = v.toLowerCase();
  const legacyWebPanelLabel = ["painel", "web"].join(" ");
  const legacyWebDashboard = ["web", "dashboard"].join("_");
  if (!v || key === legacyWebDashboard || key === "dashboard" || key === "frontend" || key === legacyWebPanelLabel) return "";
  if (key === "whatsapp") return "WhatsApp";
  if (key === "local") return "Painel Local";
  if (key === "automacao" || key === "automatico") return "Automação";
  return v;
}

// "Via" label for the actor channel. Mapeia o changed_via (last_actuation_origin)
// para o rótulo humano exibido nas notificações de ligar/desligar.
function viaChannelLabel(value: string | null | undefined): string {
  const k = String(value ?? "").toLowerCase().trim();
  if (k === "whatsapp") return "WhatsApp";
  if (k === "local") return "Local";
  if (k === "automacao" || k === "automatico" || k === "automatica" || k === "automation" || k === "schedule") return "Automação";
  // "remote", "web", "unknown", "" → Plataforma Web
  return "Plataforma Web";
}

// Nunca deixe "Remoto Não Identificado" (fallback antigo do banco) vazar para o operador.
function safeActorName(name: string | null | undefined, fallback = "Plataforma"): string {
  const s = String(name ?? "").trim();
  if (!s) return fallback;
  if (/remoto\s*n[aã]o\s*identificad/i.test(s)) return fallback;
  return s;
}

function parseModeOn(value: unknown): boolean {
  const v = String(value ?? "on").toLowerCase();
  return ["on", "auto", "automatic", "automatico", "automático", "true", "enabled", "ativado", "ativa", "active"].includes(v);
}

function parseEquipmentRunning(outputs: string | null | undefined, saida: number | null | undefined, fallback?: boolean | null): boolean | null {
  const payload = String(outputs ?? "").trim();
  if (/^[01]$/.test(payload)) return payload === "1";
  if (/^[01]{1,6}$/.test(payload)) {
    const idx = Math.max(1, Math.min(6, Number(saida ?? 1))) - 1;
    if (idx >= 0 && idx < payload.length) return payload.charAt(idx) === "1";
  }
  return typeof fallback === "boolean" ? fallback : null;
}

function pumpStatusLine(running: boolean | null | undefined): string | null {
  if (running === true) return "Status: 🟢 Ligado";
  if (running === false) return "Status: 🔴 Desligado";
  return null;
}

function buildModeChangeMessage(input: {
  equipmentName: string | null;
  farmName: string;
  enabled: boolean;
  who: string;
  ts: string;
  running?: boolean | null;
}) {
  const actionLower = input.enabled ? "ativado" : "desativado";
  if (input.equipmentName) {
    const status = pumpStatusLine(input.running);
    return `🔄 ${input.equipmentName} — Modo automático ${actionLower}\n` +
      (status ? `${status}\n` : "") +
      `${farmLine(input.farmName)}\n` +
      `Alterado por: ${input.who}\n` +
      `${input.ts}`;
  }

  return `🔄 ${farmLine(input.farmName)} — Modo automático ${actionLower.toUpperCase()}\n` +
    `Alterado por: ${input.who}\n` +
    `${input.ts}`;
}

async function wasRecentlySent(supabase: any, toPhoneDigits: string, message: string, windowMs = 30000): Promise<boolean> {
  try {
    const sinceISO = new Date(Date.now() - windowMs).toISOString();
    const { data } = await supabase
      .from("whatsapp_message_log")
      .select("id")
      .eq("direction", "outgoing")
      .gte("created_at", sinceISO)
      .limit(50);
    if (!data?.length) return false;
    const { data: rows } = await supabase
      .from("whatsapp_message_log")
      .select("id, phone, message_body, created_at")
      .eq("direction", "outgoing")
      .gte("created_at", sinceISO)
      .order("created_at", { ascending: false })
      .limit(50);
    if (!rows?.length) return false;
    const msgKey = String(message).slice(0, 200);
    for (const r of rows as any[]) {
      if (normalizePhoneKey(r.phone) !== toPhoneDigits) continue;
      const body = String(r.message_body ?? "");
      if (body.startsWith("[template:") || body.slice(0, 200) === msgKey) return true;
    }
    return false;
  } catch (e) {
    console.warn("[dedup] check failed", (e as Error).message);
    return false;
  }
}

async function sendSingleWhatsAppMessage(args: {
  supabase: any;
  config: any;
  phoneNumberId: string;
  operator: any;
  farmId: string;
  message: string;
  tplParams: string[];
  messageType: string;
  metadata: Record<string, unknown>;
  diag?: { reason?: string; mode?: string; meta_error?: any };
  skipDedup?: boolean;
  tplNameOverride?: string;
}): Promise<boolean> {
  const { supabase, config, phoneNumberId, operator: op, farmId, message, tplParams, messageType, metadata, diag, skipDedup, tplNameOverride } = args;
  const setDiag = (reason: string, extra: Record<string, unknown> = {}) => { if (diag) { diag.reason = reason; Object.assign(diag, extra); } };
  const toDigits = phoneToApi(op.phone);
  if (!toDigits) {
    console.warn("[NOTIFY] skipping: invalid phone", op.phone);
    setDiag("invalid_phone");
    return false;
  }
  const botDigits = normalizePhoneKey(config?.bot_number);
  if (botDigits && toDigits === botDigits) {
    console.log("[NOTIFY] skipping self-send to bot number", toDigits);
    setDiag("skipped_self_send");
    return false;
  }
  if (!skipDedup && await wasRecentlySent(supabase, toDigits, message)) {
    console.log("[NOTIFY] skipping duplicate (sent <30s ago)", toDigits);
    setDiag("skipped_duplicate_30s");
    return false;
  }
  console.log("[NOTIFY] Sending WhatsApp message to:", toDigits, "Type:", messageType, "Farm:", farmId);

  let tplName = tplNameOverride || "automacao_executada";
  const lastMs = op.last_message_at ? new Date(op.last_message_at).getTime() : 0;
  const within24h = lastMs > 0 && (Date.now() - lastMs) < 24 * 60 * 60 * 1000;
  let metaId: string | null = null;
  let usedMode: "text" | "template" = "text";

  const sanitizedParams = templateParamsFor(tplName, tplParams);


  try {
    if (within24h) {
      const r = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.api_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: toDigits, type: "text", text: { body: message } }),
      });
      const j = await r.json().catch(() => ({}));
      console.log("Send result:", JSON.stringify({ ok: r.ok, mode: "text", phone: toDigits, result: j }));
      if (!r.ok || (j as any)?.error) {
        console.error("[whatsapp-send] text fail", toDigits, JSON.stringify((j as any)?.error || j));
        const textError = (j as any)?.error || j;
        if (metaErrorCode(textError) !== 131047) {
          setDiag("meta_text_error", { mode: "text", meta_error: textError });
          return false;
        }

        usedMode = "template";
        tplName = "alerta_equipamento";
        const fallbackParams = [sanitizeTplParam(message).slice(0, 1000)];
        const rf = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.api_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp", to: toDigits, type: "template",
            template: { name: tplName, language: { code: "pt_BR" }, components: [{
              type: "body", parameters: fallbackParams.map((p) => ({ type: "text", text: p })),
            }] },
          }),
        });
        const jf = await rf.json().catch(() => ({}));
        console.log("Send fallback result:", JSON.stringify({ ok: rf.ok, mode: "template", template: tplName, phone: toDigits, result: jf }));
        if (!rf.ok || (jf as any)?.error) {
          console.error(`[whatsapp-send] fallback template ${tplName} fail`, toDigits, JSON.stringify((jf as any)?.error || jf));
          setDiag("meta_template_error", { mode: "template", meta_error: (jf as any)?.error || jf });
          return false;
        }
        metaId = (jf as any)?.messages?.[0]?.id ?? null;
        setDiag("sent_fallback_template", { mode: "template" });
      } else {
        metaId = (j as any)?.messages?.[0]?.id ?? null;
        setDiag("sent", { mode: "text" });
      }
    } else {
      usedMode = "template";
      const r = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.api_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp", to: toDigits, type: "template",
            template: { name: tplName, language: { code: "pt_BR" }, components: [{
              type: "body", parameters: sanitizedParams.map((p) => ({ type: "text", text: p })),
            }] },
        }),
      });
      const j = await r.json().catch(() => ({}));
      console.log("Send result:", JSON.stringify({ ok: r.ok, mode: "template", phone: toDigits, result: j }));
      if (!r.ok || (j as any)?.error) {
        console.error(`[whatsapp-send] template ${tplName} fail`, toDigits, JSON.stringify((j as any)?.error || j));

        const fallbackTpl = "alerta_equipamento";
        const fallbackParams = [sanitizeTplParam(message).slice(0, 1000)];
        const rf = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.api_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp", to: toDigits, type: "template",
            template: { name: fallbackTpl, language: { code: "pt_BR" }, components: [{
              type: "body", parameters: fallbackParams.map((p) => ({ type: "text", text: p })),
            }] },
          }),
        });
        const jf = await rf.json().catch(() => ({}));
        console.log("Send fallback result:", JSON.stringify({ ok: rf.ok, mode: "template", template: fallbackTpl, phone: toDigits, result: jf }));
        if (!rf.ok || (jf as any)?.error) {
          console.error(`[whatsapp-send] fallback template ${fallbackTpl} fail`, toDigits, JSON.stringify((jf as any)?.error || jf));
          setDiag("meta_template_error", { mode: "template", meta_error: (jf as any)?.error || jf });
          return false;
        }
        tplName = fallbackTpl;
        metaId = (jf as any)?.messages?.[0]?.id ?? null;
        setDiag("sent_fallback_template", { mode: "template" });
      } else {
        metaId = (j as any)?.messages?.[0]?.id ?? null;
        setDiag("sent", { mode: "template" });
      }
    }
  } catch (e) {
    console.error("[whatsapp-send] failed", toDigits, e);
    setDiag("exception", { meta_error: String((e as Error).message ?? e) });
    return false;
  }



  try {
    await supabase.from("whatsapp_message_log").insert({
      direction: "outgoing",
      phone: op.phone,
      operator_name: op.name ?? null,
      farm_id: farmId,
      message_type: usedMode === "template" ? "template" : messageType,
      message_body: usedMode === "template" ? `[template:${tplName}]` : message,
      message_id: metaId,
      metadata: { ...metadata, template: usedMode === "template" ? tplName : undefined, params: usedMode === "template" ? tplParams : undefined },
      group_id: null,
    });
  } catch (e) {
    console.error("[whatsapp-send] log failed", e);
  }

  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {

  console.log("=== AUTOMATION NOTIFY START ===");

  let directBody: any = null;
  if (req.method !== "GET") {
    directBody = await req.json().catch(() => null);
    if (directBody) console.log("[whatsapp-automation-notify] direct body", JSON.stringify(directBody));
  }
  console.log("[NOTIFY] Function invoked. Body:", JSON.stringify(directBody ?? {}));
  console.log("[NOTIFY] immediate:", directBody?.immediate, "type:", directBody?.type);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const config = await loadWhatsAppConfig(supabase, directBody?.farm_id ? String(directBody.farm_id) : null);
  console.log("[NOTIFY] WhatsApp config loaded:", JSON.stringify({ source: config?.source ?? "none", has_api_token: !!config?.api_token, has_phone_number_id: !!config?.phone_number_id, has_bot_number: !!config?.bot_number }));

  if (!config?.api_token || !config?.phone_number_id) {
    console.error("[whatsapp-automation-notify] missing whatsapp_config");
    return new Response(JSON.stringify({ error: "no_token" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }

  const phoneNumberId = config.phone_number_id;

  if (directBody?.immediate === true) {
    const result = await processImmediateNotification(supabase, config, phoneNumberId, directBody);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: result.ok ? 200 : 400,
    });
  }

  // Detecta programações cuja janela de 15 min foi ultrapassada e não foram executadas hoje.
  // Insere linhas com status='expired' para serem notificadas pelo fluxo padrão.
  try {
    await detectExpired(supabase);
  } catch (e) {
    console.error("[whatsapp-automation-notify] detectExpired failed", e);
  }

  // Janela de 5 min para evitar duplicar e pegar quaisquer rows novos.
  const sinceISO = new Date(Date.now() - 5 * 60 * 1000).toISOString();


  const { data: rows, error } = await supabase
    .from("automation_execution_log")
    .select("id, farm_id, equipment_id, schedule_id, action, scheduled_time, executed_at, status, failure_reason, origin, details")
    .is("notified_at", null)
    .gte("executed_at", sinceISO)
    .in("status", ["success", "expired", "failed"])
    .order("executed_at", { ascending: true });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!rows?.length) {
    let pendingSent = 0;
    try {
      pendingSent = await drainPendingNotifications(supabase, config, phoneNumberId, directBody?.immediate === true);
    } catch (e) {
      console.error("[whatsapp-automation-notify] drainPending failed", e);
    }

    return new Response(JSON.stringify({ status: pendingSent > 0 ? "pending_sent" : "nothing_to_send", pending_sent: pendingSent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Verificação: rows com status=success < 2 min são adiadas (aguardam confirmação do equipamento).
  const VERIFY_DELAY_MS = 2 * 60 * 1000;
  const nowMs = Date.now();
  const readyRows: any[] = [];
  const deferredCount = (rows as any[]).filter((r) => {
    const age = nowMs - new Date(r.executed_at).getTime();
    if (r.status === "success" && age < VERIFY_DELAY_MS) return true;
    readyRows.push(r);
    return false;
  }).length;

  if (!readyRows.length) {
    let pendingSent = 0;
    try {
      pendingSent = await drainPendingNotifications(supabase, config, phoneNumberId, directBody?.immediate === true);
    } catch (e) {
      console.error("[whatsapp-automation-notify] drainPending failed", e);
    }

    return new Response(JSON.stringify({ status: "all_deferred", deferred: deferredCount, pending_sent: pendingSent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Anti-spam oscillation: por equipment_id, manter só o estado MAIS RECENTE
  const latestPerEquip = new Map<string, any>();
  for (const r of readyRows) {
    const k = r.equipment_id ?? r.id;
    const prev = latestPerEquip.get(k);
    if (!prev || new Date(r.executed_at).getTime() > new Date(prev.executed_at).getTime()) {
      latestPerEquip.set(k, r);
    }
  }
  const allConsidered = readyRows.map((r) => r.id);
  let kept = [...latestPerEquip.values()];

  // Filtro anti-alerta-falso: descarta linhas de fazendas demo. Fazendas demo
  // não têm telemetria real, então todo agendamento cai em "failed" e gera
  // spam de "Programação NÃO obedecida".
  const preFarmIds = [...new Set(kept.map((r) => r.farm_id).filter(Boolean))];
  if (preFarmIds.length) {
    const { data: demoFarms } = await supabase
      .from("farms")
      .select("id, is_demo")
      .in("id", preFarmIds);
    const demoSet = new Set((demoFarms ?? []).filter((f: any) => f.is_demo).map((f: any) => f.id));
    if (demoSet.size) {
      kept = kept.filter((r) => !demoSet.has(r.farm_id));
    }
  }

  const equipIds = [...new Set(kept.map((r) => r.equipment_id).filter(Boolean))];
  const schedIds = [...new Set(kept.map((r) => r.schedule_id).filter(Boolean))];
  const farmIds = [...new Set(kept.map((r) => r.farm_id).filter(Boolean))];

  const [{ data: equips }, { data: schedules }] = await Promise.all([
    equipIds.length
      ? supabase.from("equipments")
          .select("id, name, saida, last_outputs_state, communication_status, last_actuation_origin, desired_running")
          .in("id", equipIds)
      : Promise.resolve({ data: [] as any[] }),
    schedIds.length
      ? supabase.from("automation_schedules").select("id, time_on, time_off, days, mode").in("id", schedIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const eqById = new Map<string, any>();
  (equips ?? []).forEach((e: any) => eqById.set(e.id, e));
  const schById = new Map<string, any>();
  (schedules ?? []).forEach((s: any) => schById.set(s.id, s));

  // VERIFICAÇÃO: para cada row 'success', conferir se o equipamento atingiu o estado esperado.
  // Se NÃO → reclassifica como 'failed' com failure_reason.
  for (const r of kept) {
    if (r.status !== "success") continue;
    const eq = eqById.get(r.equipment_id);
    if (!eq) continue;
    const expectedOn = r.action === "liga";

    let reason: string | null = null;
    if ((eq.communication_status ?? "") === "offline") reason = "offline";
    else {
      // Parse estado real a partir de last_outputs_state pela saída do equipamento
      const outputs = String(eq.last_outputs_state ?? "");
      const idx = (eq.saida ?? 1) - 1;
      const actualOn = outputs.charAt(idx) === "1";
      if (actualOn !== expectedOn) {
        if ((eq.last_actuation_origin ?? "") === "local") reason = "local_mode";
        else reason = "no_response";
      }
    }

    if (reason) {
      r.status = "failed";
      r.failure_reason = reason;
      await supabase
        .from("automation_execution_log")
        .update({ status: "failed", failure_reason: reason })
        .eq("id", r.id);
    }
  }

  // Operadores ativos por fazenda
  const { data: operators } = await supabase
    .from("whatsapp_operators")
    .select("phone, name, role, notification_preference, receive_alerts, farm_id, default_farm_id, is_active, last_message_at, user_id")
    .eq("is_active", true);

  const opsByFarm = new Map<string, any[]>();
  const phoneKeysByFarm = new Map<string, Set<string>>();
  for (const o of (operators ?? []) as any[]) {
    const pref = (o.notification_preference || "default").toLowerCase();
    const isSuper = o.role === "super_admin";
    const operatorFarmId = o.default_farm_id ?? o.farm_id;
    const eligibleFarms = isSuper ? farmIds : farmIds.filter((farmId) => operatorFarmId === farmId || o.farm_id === farmId || o.default_farm_id === farmId);
    if (!eligibleFarms.length) continue;
    if (!isSuper) {
      if (pref === "mute" || pref === "mudo") continue;
      if (o.receive_alerts === false) continue;
    }
    if (!o.phone) continue;
    for (const farmId of eligibleFarms) {
      addOperatorOnce(opsByFarm, phoneKeysByFarm, farmId, o);
    }
  }

  // Anti-spam de falhas: 30 min por equipamento
  const failedRows = kept.filter((r) => r.status === "failed");
  const blockedFailEquips = new Set<string>();
  if (failedRows.length) {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const eqIds = [...new Set(failedRows.map((r) => r.equipment_id).filter(Boolean))];
    const { data: recent } = await supabase
      .from("whatsapp_alerts_log")
      .select("equipment_id")
      .eq("alert_type", "automation_failed")
      .in("equipment_id", eqIds)
      .gte("created_at", thirtyMinAgo);
    (recent ?? []).forEach((x: any) => blockedFailEquips.add(x.equipment_id));
  }

  // Agrupar por (farm_id, status, action, scheduled_time, reason, automation_name|null)
  type Group = { farm_id: string; status: string; action: string; sched_hhmm: string; reason: string | null; automation_name: string | null; rows: any[] };
  const groups = new Map<string, Group>();
  for (const r of kept) {
    if (r.status === "failed" && blockedFailEquips.has(r.equipment_id)) continue;
    const sched = hhmm(r.scheduled_time);
    const reason = r.failure_reason ?? null;
    const autoName = (r.origin === "automacao" && r.details?.automation_name) ? String(r.details.automation_name) : null;
    const key = `${r.farm_id}|${r.status}|${r.action}|${sched}|${reason ?? ""}|${autoName ?? ""}`;
    const g: Group = groups.get(key) ?? { farm_id: r.farm_id, status: r.status, action: r.action, sched_hhmm: sched, reason, automation_name: autoName, rows: [] as any[] };
    g.rows.push(r);
    groups.set(key, g);
  }


  let sentCount = 0;

  for (const g of groups.values()) {
    const targets = opsByFarm.get(g.farm_id) ?? [];
    if (!targets.length) continue;

    const dateLine = fmtDateLine(new Date(g.rows[0].executed_at));
    const actionVerb = g.action === "liga" ? "LIGADO" : "DESLIGADO";
    const icon = g.action === "liga" ? "✅" : "⛔";
    const messageType = g.status === "failed" ? "automation_failure" : "automation_notification";

    let message = "";

    // === AUTOMAÇÃO INDEPENDENTE (origin=automacao) ===
    if (g.automation_name) {
      if (g.status === "failed") {
        const lines = g.rows.map((r) => {
          const eqName = eqById.get(r.equipment_id)?.name ?? r.details?.equipment_name ?? "Equipamento";
          const reasonShort = g.reason === "offline" ? "offline" : g.reason === "local_mode" ? "modo local" : "sem resposta";
          return `❌ ${eqName} — Falha (${reasonShort})`;
        }).join("\n");
        message =
          `⚠️ *Automação com falha:*\n\n` +
          `📝 ${g.automation_name}\n` +
          `⏰ ${g.sched_hhmm} — ${dateLine}\n\n` +
          `${lines}\n\n` +
          `Verifique manualmente.`;
      } else if (g.status === "expired") {
        message =
          `⚠️ *Automação expirada:*\n\n` +
          `📝 ${g.automation_name}\n` +
          `⏰ ${g.sched_hhmm} — ${dateLine}\n\n` +
          `❌ Janela de 5 min ultrapassada.`;
      } else {
        const lines = g.rows.map((r) => {
          const eqName = eqById.get(r.equipment_id)?.name ?? r.details?.equipment_name ?? "Equipamento";
          return `${icon} ${eqName} — ${actionVerb}`;
        }).join("\n");
        message =
          `⚡ *Automação executada:*\n\n` +
          `📝 ${g.automation_name}\n` +
          `⏰ ${g.sched_hhmm} — ${dateLine}\n\n` +
          `${lines}`;
      }
    } else if (g.status === "expired") {

      const rawFarmName = (await supabase.from("farms").select("name").eq("id", g.farm_id).maybeSingle()).data?.name ?? "";
      const farmClean = String(rawFarmName).trim();
      const farmLineStr = farmClean
        ? (/^fazenda\b/i.test(farmClean) ? farmClean.replace(/^fazenda\s+/i, "Fazenda ") : `Fazenda ${farmClean}`)
        : "";
      const items = g.rows.map((r) => {
        const eq = eqById.get(r.equipment_id)?.name ?? "Equipamento";
        const verb = r.action === "liga" ? "Liga" : "Desliga";
        const line = `• ${eq} — ${verb} ${hhmm(r.scheduled_time)}`;
        return farmLineStr ? `${line}\n${farmLineStr}` : line;
      }).join("\n");
      message =
        `⚠️ *Programação não executada:*\n\n` +
        `${items}\n\n` +
        `❌ Sistema indisponível no horário programado.\n` +
        `Janela de 5 min expirada.\n` +
        `Verifique o equipamento manualmente.\n\n` +
        `📅 ${dateLine}`;
    } else if (g.status === "failed") {
      const eqNames = g.rows.map((r) => eqById.get(r.equipment_id)?.name ?? "Equipamento").join(", ");
      const expectedVerb = g.action === "liga" ? "LIGADO" : "DESLIGADO";
      let causeBlock = "";
      if (g.reason === "local_mode") {
        causeBlock =
          `🔒 Equipamento está em modo LOCAL\n\n` +
          `O comando automático não pode ser executado enquanto a chave estiver em LOCAL no painel.\n` +
          `Mude para REMOTO no painel para que as programações funcionem.`;
      } else if (g.reason === "offline") {
        causeBlock =
          `📡 Equipamento OFFLINE — sem comunicação\n\n` +
          `Verifique a alimentação e o rádio do equipamento.`;
      } else {
        causeBlock =
          `⏰ Comando enviado às ${g.sched_hhmm}, mas equipamento não respondeu.\n\n` +
          `Possíveis causas:\n` +
          `• Equipamento em modo LOCAL (chave no painel)\n` +
          `• Falha de comunicação (rádio/LoRa)\n` +
          `• Equipamento offline\n\n` +
          `⚠️ Verifique o equipamento manualmente.`;
      }
      message =
        `🚨 *Programação NÃO obedecida:*\n\n` +
        `❌ ${eqNames} — Deveria ter ${expectedVerb} às ${g.sched_hhmm}\n\n` +
        `${causeBlock}\n\n` +
        `📅 ${dateLine}`;
    } else {
      const firstSched = schById.get(g.rows[0].schedule_id);
      let progLine = "";
      if (firstSched) {
        const on = hhmm(firstSched.time_on);
        const off = hhmm(firstSched.time_off);
        const days = fmtDaysRange(firstSched.days);
        if (firstSched.mode === "on-only") progLine = `Programação ativa: Liga ${on} (${days})`;
        else if (firstSched.mode === "off-only") progLine = `Programação ativa: Desliga ${off} (${days})`;
        else progLine = `Programação ativa: Liga ${on} / Desliga ${off} (${days})`;
      }

      if (g.rows.length === 1) {
        const r = g.rows[0];
        const eqName = eqById.get(r.equipment_id)?.name ?? "Equipamento";
        message =
          `🤖 *Modo Automático executou:*\n\n` +
          `${icon} ${eqName} — ${actionVerb}\n\n` +
          `⏰ Horário programado: ${g.sched_hhmm}\n` +
          `📅 ${dateLine}` +
          (progLine ? `\n\n${progLine}` : "");
      } else {
        const lines = g.rows
          .map((r) => `${icon} ${eqById.get(r.equipment_id)?.name ?? "Equipamento"} — ${actionVerb} (${hhmm(r.scheduled_time)})`)
          .join("\n");
        const progSimple = progLine ? progLine.replace("Programação ativa:", "Programação:") : "";
        message =
          `🤖 *Modo Automático executou:*\n\n` +
          `${lines}\n\n` +
          `📅 ${dateLine}` +
          (progSimple ? `\n\n${progSimple}` : "");
      }
    }

    // Template params (used outside 24h): equipment, action, farm, timestamp
    const tplName = "automacao_executada";
    const eqNamesForTpl = g.rows.map((r) => eqById.get(r.equipment_id)?.name ?? r.details?.equipment_name ?? "Equipamento").join(", ");
    const actionWord = g.action === "liga" ? "ligado" : "desligado";
    const tsLine = new Date(g.rows[0].executed_at).toLocaleString("pt-BR", {
      timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    const farmNameForTpl = (await supabase.from("farms").select("name").eq("id", g.farm_id).maybeSingle()).data?.name ?? "—";
    const tplParams = [
      eqNamesForTpl.length > 60 ? eqNamesForTpl.slice(0, 57) + "..." : eqNamesForTpl,
      actionWord,
      farmNameForTpl,
      tsLine,
    ];

    for (const op of targets) {
      const lastMs = op.last_message_at ? new Date(op.last_message_at).getTime() : 0;
      const within24h = lastMs > 0 && (Date.now() - lastMs) < 24 * 60 * 60 * 1000;
      let metaId: string | null = null;
      let usedMode: "text" | "template" = "text";
      try {
        if (within24h) {
          const r = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.api_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ messaging_product: "whatsapp", to: op.phone, type: "text", text: { body: message } }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || (j as any)?.error) console.error("[automation-notify] text fail", op.phone, JSON.stringify((j as any)?.error || j));
          metaId = (j as any)?.messages?.[0]?.id ?? null;
        } else {
          usedMode = "template";
          const r = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.api_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              messaging_product: "whatsapp", to: op.phone, type: "template",
              template: { name: tplName, language: { code: "pt_BR" }, components: [{
                type: "body", parameters: tplParams.map((p) => ({ type: "text", text: p })),
              }] },
            }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || (j as any)?.error) console.error(`[automation-notify] template ${tplName} fail`, op.phone, JSON.stringify((j as any)?.error || j));
          else console.log(`[automation-notify] template ${tplName} sent to ${op.phone}`);
          metaId = (j as any)?.messages?.[0]?.id ?? null;
        }
        sentCount++;
      } catch (e) {
        console.error("[whatsapp-automation-notify] send failed", op.phone, e);
      }
      try {
        await supabase.from("whatsapp_message_log").insert({
          direction: "outgoing",
          phone: op.phone,
          operator_name: op.name ?? null,
          farm_id: g.farm_id,
          message_type: usedMode === "template" ? "template" : messageType,
          message_body: usedMode === "template" ? `[template:${tplName}]` : message,
          message_id: metaId,
          metadata: { action: g.action, scheduled_time: g.sched_hhmm, status: g.status, reason: g.reason, equipment_count: g.rows.length, template: usedMode === "template" ? tplName : undefined, params: usedMode === "template" ? tplParams : undefined },
          group_id: null,
        });
      } catch (e) {
        console.error("[whatsapp-automation-notify] log failed", e);
      }
    }

    // Anti-spam: registra log de alerta de falha (1 por equipamento)
    if (g.status === "failed") {
      for (const r of g.rows) {
        try {
          await supabase.from("whatsapp_alerts_log").insert({
            alert_type: "automation_failed",
            equipment_id: r.equipment_id || "00000000-0000-0000-0000-000000000000",
            equipment_name: eqById.get(r.equipment_id)?.name ?? null,
            message_sent: message,
          });
        } catch (e) {
          console.error("[whatsapp-automation-notify] alerts_log failed", e);
        }
      }
    }
  }

  // Marca todas as linhas processadas como notificadas
  if (allConsidered.length) {
    await supabase
      .from("automation_execution_log")
      .update({ notified_at: new Date().toISOString() })
      .in("id", allConsidered);
  }

  // Process pending_notifications queue for non-immediate automation execution/state events.
  let pendingSent = 0;
  try {
    pendingSent = await drainPendingNotifications(supabase, config, phoneNumberId, directBody?.immediate === true);
  } catch (e) {
    console.error("[whatsapp-automation-notify] drainPending failed", e);
  }

  return new Response(JSON.stringify({ status: "ok", groups: groups.size, sent: sentCount, deferred: deferredCount, pending_sent: pendingSent }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
  } catch (e) {
    console.error("[whatsapp-automation-notify] UNHANDLED ERROR", e);
    return new Response(JSON.stringify({ ok: false, error: "unhandled_exception", detail: e instanceof Error ? e.message : String(e) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});

async function loadWhatsAppConfig(supabase: any, farmId?: string | null) {
  const select = "api_token, phone_number_id, bot_number, farm_id, updated_at";

  if (farmId) {
    const { data, error } = await supabase
      .from("whatsapp_config")
      .select(select)
      .eq("farm_id", farmId)
      .not("api_token", "is", null)
      .not("phone_number_id", "is", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) console.error("[NOTIFY] farm whatsapp_config lookup failed", error.message || JSON.stringify(error));
    if (data?.api_token && data?.phone_number_id) return { ...data, source: "whatsapp_config:farm" };
  }

  const { data, error } = await supabase
    .from("whatsapp_config")
    .select(select)
    .not("api_token", "is", null)
    .not("phone_number_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) console.error("[NOTIFY] global whatsapp_config lookup failed", error.message || JSON.stringify(error));
  if (data?.api_token && data?.phone_number_id) return { ...data, source: "whatsapp_config:global" };

  const envToken = Deno.env.get("WHATSAPP_TOKEN") ?? Deno.env.get("META_WHATSAPP_TOKEN") ?? null;
  const envPhoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? Deno.env.get("META_WHATSAPP_PHONE_NUMBER_ID") ?? null;
  if (envToken && envPhoneId) {
    return { api_token: envToken, phone_number_id: envPhoneId, bot_number: null, farm_id: null, source: "env" };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sends dashboard mode changes immediately. This path never reads or writes
// pending_notifications, so it does not wait for cron and cannot duplicate via queue.
async function processImmediateModeChange(supabase: any, config: any, phoneNumberId: string, body: any) {
  const type = String(body?.type ?? "mode_change");
  if (type !== "mode_change") return { ok: false, error: "unsupported_immediate_type" };
  console.log("[NOTIFY] Processing immediate mode_change:", JSON.stringify(body));

  const equipmentId = body?.equipment_id ? String(body.equipment_id) : null;
  const requestedFarmId = body?.farm_id ? String(body.farm_id) : null;
  const newMode = body?.new_mode ?? body?.new_value ?? body?.action ?? "on";
  const rawChangedBy = String(body?.changed_by ?? "").trim();
  const rawSourceLabel = sourceLabel(body?.source);
  const source = sourceLabel(rawChangedBy) || rawSourceLabel;

  let farmId = requestedFarmId;
  let equipmentName: string | null = body?.equipment_name ? String(body.equipment_name) : null;
  let farmName: string | null = body?.farm_name ? String(body.farm_name) : null;
  let equipment: any = null;
  if (equipmentId) {
    console.log("[NOTIFY] Looking up equipment:", equipmentId);
    const { data, error } = await supabase
      .from("equipments")
      .select("id, farm_id, name, saida, last_outputs_state, desired_running")
      .eq("id", equipmentId)
      .maybeSingle();
    if (error) console.error("[whatsapp-automation-notify] direct equipment lookup failed", error.message);
    equipment = data;
    console.log("[NOTIFY] Equipment lookup result:", JSON.stringify({ found: !!data, equipment_id: equipmentId, farm_id: data?.farm_id, name: data?.name }));
    farmId = farmId ?? data?.farm_id ?? null;
    equipmentName = equipmentName ?? data?.name ?? null;
  }

  if (!farmId) {
    console.error("[whatsapp-automation-notify] direct notification ignored: missing farm_id", JSON.stringify(body));
    return { ok: false, error: "missing_farm_id" };
  }

  if (!farmName) {
    console.log("[NOTIFY] Looking up farm:", farmId);
    const { data: farm, error } = await supabase.from("farms").select("id, name").eq("id", farmId).maybeSingle();
    if (error) console.error("[whatsapp-automation-notify] direct farm lookup failed", error.message);
    farmName = farm?.name ?? "Fazenda";
    console.log("[NOTIFY] Farm lookup result:", JSON.stringify({ found: !!farm, farm_id: farmId, name: farmName }));
  }

  let isOn = parseModeOn(newMode);
  const changeType = equipmentId ? "schedule_mode" : "engine_mode";

  // Always reflect the CURRENT state from DB to avoid stale "intermediate" toggles
  // overwriting the final state in the operator's chat.
  if (!equipmentId) {
    try {
      const { data: engine } = await supabase
        .from("automation_engine")
        .select("enabled")
        .eq("farm_id", farmId)
        .maybeSingle();
      if (engine && typeof engine.enabled === "boolean") {
        if (engine.enabled !== isOn) {
          console.log("[NOTIFY] mode_change: overriding new_mode with current engine state", { requested: isOn, actual: engine.enabled });
        }
        isOn = engine.enabled;
      }
    } catch (e) {
      console.warn("[NOTIFY] mode_change: engine state lookup failed", (e as Error).message);
    }
  }
  const newValue = isOn ? "on" : "off";

  // FEATURE: Only notify on engine mode change if at least one schedule is active.
  // Include the list of scheduled pumps in the message.
  let pumpListBlock = "";
  if (!equipmentId) {
    const { data: activeScheds, error: schedErr } = await supabase
      .from("automation_schedules")
      .select("equipment_id, time_on, time_off, mode, equipment:equipment_id(name)")
      .eq("farm_id", farmId)
      .eq("active", true);
    if (schedErr) console.error("[NOTIFY] active schedules lookup failed", schedErr.message);
    const list = activeScheds ?? [];
    if (list.length === 0) {
      console.log("[NOTIFY] mode_change skipped: no active schedules for farm", farmId);
      return { ok: true, mode: "immediate", sent: 0, failed: 0, operators: 0, skipped: "no_active_schedules" };
    }
    if (isOn) {
      // Agrupa horários por equipamento e ordena por número do poço/bomba.
      const byEquipment = new Map<string, { name: string; number: number; timeOn: string | null; timeOff: string | null }>();
      for (const s of list) {
        const id = s.equipment_id;
        const name = s.equipment?.name ?? "Equipamento";
        const existing = byEquipment.get(id);
        if (!existing) {
          const numMatch = String(name).match(/(\d+)/);
          byEquipment.set(id, {
            name,
            number: numMatch ? Number(numMatch[1]) : Infinity,
            timeOn: s.mode === "off-only" ? null : s.time_on,
            timeOff: s.mode === "on-only" ? null : s.time_off,
          });
        } else {
          if (s.mode !== "off-only" && s.time_on) existing.timeOn = existing.timeOn ?? s.time_on;
          if (s.mode !== "on-only" && s.time_off) existing.timeOff = existing.timeOff ?? s.time_off;
        }
      }
      const sorted = Array.from(byEquipment.values()).sort((a, b) => {
        if (a.number !== b.number) return a.number - b.number;
        return String(a.name).localeCompare(String(b.name));
      });
      pumpListBlock = "\n\nProgramação:\n" + sorted.map((e) => {
        const on = hhmm(e.timeOn);
        const off = hhmm(e.timeOff);
        if (on !== "—" && off !== "—") return `* ${e.name} — Liga ${on} | Desliga ${off}`;
        if (on !== "—") return `* ${e.name} — Liga ${on}`;
        if (off !== "—") return `* ${e.name} — Desliga ${off}`;
        return `* ${e.name}`;
      }).join("\n");
    } else {
      // Dedupe por equipment_id — cada bomba aparece só 1x mesmo se tinha múltiplos schedules.
      const uniqueByEq = new Map<string, { name: string; number: number }>();
      for (const s of list as any[]) {
        const id = s.equipment_id;
        if (uniqueByEq.has(id)) continue;
        const name = s.equipment?.name ?? "Equipamento";
        const numMatch = String(name).match(/(\d+)/);
        uniqueByEq.set(id, { name, number: numMatch ? Number(numMatch[1]) : Infinity });
      }
      const sortedOff = Array.from(uniqueByEq.values()).sort((a, b) => {
        if (a.number !== b.number) return a.number - b.number;
        return String(a.name).localeCompare(String(b.name));
      });
      pumpListBlock = "\n\nBombas que saíram do automático:\n" + sortedOff.map((e) => `* ${e.name}`).join("\n");
    }
  }

  const allTargets = await loadFarmOperators(supabase, farmId);
  const excludeDigits = String(body?.exclude_phone ?? "").replace(/\D/g, "");
  const targets = excludeDigits
    ? allTargets.filter((o: any) => String(o?.phone ?? "").replace(/\D/g, "") !== excludeDigits)
    : allTargets;
  console.log("[NOTIFY] Operators to notify:", targets.length, "exclude:", excludeDigits || "(none)", targets.map((o: any) => ({ phone: o.phone, role: o.role, receive_alerts: o.receive_alerts, preference: o.notification_preference })));

  const ts = fmtShortTimestamp(new Date());
  const who = source || "Usuário Web";
  const equipmentRunning = equipmentId
    ? parseEquipmentRunning(equipment?.last_outputs_state, equipment?.saida, equipment?.desired_running)
    : null;
  const baseMessage = buildModeChangeMessage({ equipmentName, farmName: farmName ?? "Fazenda", enabled: isOn, who, ts, running: equipmentRunning });
  const message = baseMessage + pumpListBlock;
  const actionShort = `modo automático ${isOn ? "ativado" : "desativado"}`;
  const tplParams: string[] = [sanitizeTplParam(message).slice(0, 1000)];

  // REGRA ABSOLUTA: toggle de modo automático é uma AÇÃO DELIBERADA do usuário.
  // NUNCA aplicar dedup — cada ativar/desativar precisa notificar, mesmo que 10x
  // em 1 minuto. Dedup só existe para alertas passivos (offline/online), nunca
  // para ações manuais confirmadas pelo sistema.
  const diags: Array<{ reason?: string; mode?: string; meta_error?: any }> = targets.map(() => ({}));
  const results = await Promise.all(targets.map((op, i) => {
    return sendSingleWhatsAppMessage({
      supabase,
      config,
      phoneNumberId,
      operator: op,
      farmId,
      message,
      tplParams,
      tplNameOverride: "modo_automatico_atualizado",
      messageType: "mode_change_notification",
      metadata: {
        change_type: changeType,
        new: newValue,
        via: body?.source ?? "frontend",
        source: "immediate_dashboard",
        equipment_id: equipmentId,
        equipment_name: equipmentName,
        farm_name: farmName,
      },
      diag: diags[i],
      skipDedup: true,
    });
  }));


  const sent = results.filter(Boolean).length;
  const failed = targets.length - sent;
  const details = targets.map((op: any, i: number) => ({
    phone: op.phone,
    phone_digits: phoneToApi(op.phone),
    name: op.name ?? null,
    role: op.role ?? null,
    receive_alerts: op.receive_alerts ?? null,
    within24h: op.last_message_at ? (Date.now() - new Date(op.last_message_at).getTime()) < 24*60*60*1000 : false,
    ok: results[i],
    result: results[i] ? (diags[i].reason ?? "sent") : (diags[i].reason ?? "unknown_failure"),
    mode: diags[i].mode ?? null,
    meta_error: diags[i].meta_error ?? null,
  }));
  console.log("[NOTIFY] Immediate mode_change finished:", JSON.stringify({ farmId, equipmentId, changeType, sent, failed, operators: targets.length, details }));
  return { ok: true, mode: "immediate", sent, failed, operators: targets.length, details };
}


// ─────────────────────────────────────────────────────────────────────────────
// processImmediateNotification — generic dispatcher for ALL dashboard-triggered
// instant WhatsApp notifications. No queue, no cron, no debounce.
// Supported `type` values:
//   - mode_change                  (auto mode toggled)
//   - equipment_control            (equipment turned on/off from web)
//   - operator_approved
//   - operator_rejected
//   - invite_code_created          (send code TO target_phone)
//   - operator_permissions_changed
//   - alert                        (generic alert)
// ─────────────────────────────────────────────────────────────────────────────
async function processImmediateNotification(supabase: any, config: any, phoneNumberId: string, body: any) {
  const type = String(body?.type ?? "mode_change");

  if (type === "mode_change") {
    return processImmediateModeChange(supabase, config, phoneNumberId, body);
  }

  if (type === "equipment_control" || type === "equipment_command") {
    const eqId = String(body?.equipment_id ?? "");
    const action = String(body?.action ?? "").toLowerCase();
    if (eqId && action && shouldSkipEquipmentControl(eqId, action)) {
      console.log(`[whatsapp-automation-notify] dedup skip equipment_control eq=${eqId} action=${action}`);
      return { skipped: true, reason: "duplicate_within_60s" };
    }
    return enqueueEquipmentControlBatch(supabase, config, phoneNumberId, body);
  }

  if (type === "batch_tick") {
    return processBatchTick(supabase, config, phoneNumberId);
  }


  if (type === "operator_approved" || type === "operator_rejected") {
    return processImmediateOperatorDecision(supabase, config, phoneNumberId, body, type === "operator_approved");
  }

  if (type === "invite_code_created") {
    return processImmediateInviteCode(supabase, config, phoneNumberId, body);
  }

  if (type === "operator_permissions_changed") {
    return processImmediatePermissionsChanged(supabase, config, phoneNumberId, body);
  }

  if (type === "alert") {
    return processImmediateAlert(supabase, config, phoneNumberId, body);
  }

  if (type === "maintenance_change") {
    return processImmediateMaintenanceChange(supabase, config, phoneNumberId, body);
  }

  if (type === "schedule_change") {
    return processImmediateScheduleChange(supabase, config, phoneNumberId, body);
  }

  return { ok: false, error: `unsupported_immediate_type:${type}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// processImmediateScheduleChange — sends WhatsApp notification for schedule
// CRUD (create/update/delete) actions. NEVER deduped. On any send failure the
// row is enqueued into pending_notifications with retry_at = now()+30s (1 retry
// via the standard cron drain).
//
// Body: { type: "schedule_change", farm_id, farm_name?, actor_name, via,
//         message (pre-formatted, required) }
// ─────────────────────────────────────────────────────────────────────────────
async function processImmediateScheduleChange(supabase: any, config: any, phoneNumberId: string, body: any) {
  const farmId = body?.farm_id ? String(body.farm_id) : null;
  const message = String(body?.message ?? "").trim();
  if (!farmId || !message) return { ok: false, error: "missing_farm_id_or_message" };
  const farmName = await resolveFarmName(supabase, farmId, body?.farm_name);
  const via = String(body?.via ?? "web");
  const actorName = String(body?.actor_name ?? "Usuário");
  const isRetry = body?.__retry === true;

  const targets = await loadFarmOperators(supabase, farmId);
  console.log("[NOTIFY] schedule_change targets:", targets.length, { farmId, via, actorName, retry: isRetry });

  const tplParams: string[] = [sanitizeTplParam(message).slice(0, 1000)];

  const results = await Promise.all(targets.map((op) => sendSingleWhatsAppMessage({
    supabase,
    config,
    phoneNumberId,
    operator: op,
    farmId,
    message,
    tplParams,
    tplNameOverride: "alerta_equipamento",
    messageType: "schedule_change_notification",
    metadata: {
      change_type: "schedule_change",
      farm_name: farmName,
      actor_name: actorName,
      via,
    },
    skipDedup: true, // ABSOLUTE RULE: never dedup schedule changes
  })));

  const sent = results.filter(Boolean).length;
  const failed = targets.length - sent;

  // Retry once (30s) if nothing was sent AND we have targets AND this isn't already a retry.
  if (targets.length > 0 && sent === 0 && !isRetry) {
    const retryAt = new Date(Date.now() + 30_000).toISOString();
    try {
      await supabase.from("pending_notifications").insert({
        farm_id: farmId,
        change_type: "schedule_change",
        new_value: "changed",
        changed_by: `${actorName}|via:${via}`,
        changed_via: via,
        payload: { message, farm_name: farmName, actor_name: actorName, via },
        retry_at: retryAt,
        retry_count: 1,
        last_error: "immediate_send_failed",
      });
      console.warn("[NOTIFY] schedule_change enqueued for 30s retry", { farmId, retry_at: retryAt });
    } catch (e) {
      console.error("[NOTIFY] schedule_change failed to enqueue retry", (e as Error).message);
    }
  }

  return { ok: true, mode: "immediate", sent, failed, operators: targets.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// processImmediateMaintenanceChange — notifies all farm operators + super_admins
// (except the actor) when an equipment enters or leaves maintenance.
// Body: { type: "maintenance_change", action: "block"|"release",
//         equipment_id, equipment_name, farm_id, farm_name?,
//         changed_by, exclude_phone, via }
// ─────────────────────────────────────────────────────────────────────────────
async function processImmediateMaintenanceChange(supabase: any, config: any, phoneNumberId: string, body: any) {
  const action = String(body?.action ?? "").toLowerCase();
  const isBlock = action === "block" || action === "blocked" || action === "lock";
  const equipmentId = body?.equipment_id ? String(body.equipment_id) : null;
  const equipmentName = String(body?.equipment_name ?? "Equipamento");
  const farmId = body?.farm_id ? String(body.farm_id) : null;
  if (!farmId) return { ok: false, error: "missing_farm_id" };
  const farmName = await resolveFarmName(supabase, farmId, body?.farm_name);
  const who = String(body?.changed_by ?? "Operador");
  const ts = fmtShortTimestamp(new Date());

  const icon = isBlock ? "🔒" : "🔓";
  const verb = isBlock ? "bloqueado para MANUTENÇÃO" : "liberado da manutenção";
  const message = `${icon} ${equipmentName} ${verb}\n${farmLine(farmName)}\nPor: ${who}\n${ts}`;
  const tplParams: string[] = [sanitizeTplParam(message).slice(0, 1000)];

  const allTargets = await loadFarmOperators(supabase, farmId);
  const excludeDigits = String(body?.exclude_phone ?? "").replace(/\D/g, "");
  const targets = excludeDigits
    ? allTargets.filter((o: any) => String(o?.phone ?? "").replace(/\D/g, "") !== excludeDigits)
    : allTargets;
  console.log("[NOTIFY] maintenance_change targets:", targets.length, "exclude:", excludeDigits || "(none)", { equipmentId, equipmentName, farmId, action });
  console.log("[broadcast] Destinatários:", targets.map((o: any) => phoneToApi(o.phone)));
  console.log("[broadcast] Template/texto:", message);

  // Anti-dup 5 min
  const sinceISO = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const changeType = isBlock ? "maintenance_block" : "maintenance_release";
  const dedupSet = new Set<string>();
  try {
    const { data: recent } = await supabase
      .from("whatsapp_message_log")
      .select("phone, metadata, created_at")
      .eq("direction", "outgoing")
      .eq("farm_id", farmId)
      .gte("created_at", sinceISO)
      .limit(200);
    for (const r of (recent ?? []) as any[]) {
      const md = r.metadata ?? {};
      if (md.change_type !== changeType) continue;
      if ((md.equipment_id ?? null) !== (equipmentId ?? null)) continue;
      const k = normalizePhoneKey(r.phone);
      if (k) dedupSet.add(k);
    }
  } catch (e) {
    console.warn("[NOTIFY] maintenance dedup lookup failed", (e as Error).message);
  }

  const diags: Array<{ reason?: string; mode?: string; meta_error?: any }> = targets.map(() => ({}));
  const results = await Promise.all(targets.map((op, i) => {
    const k = normalizePhoneKey(op.phone);
    if (k && dedupSet.has(k)) {
      diags[i].reason = "skipped_duplicate_5min";
      return Promise.resolve(false);
    }
    return sendSingleWhatsAppMessage({
      supabase,
      config,
      phoneNumberId,
      operator: op,
      farmId,
      message,
      tplParams,
      tplNameOverride: "alerta_equipamento",
      messageType: "maintenance_change_notification",
      metadata: {
        change_type: changeType,
        equipment_id: equipmentId,
        equipment_name: equipmentName,
        farm_name: farmName,
        via: body?.via ?? "whatsapp",
        changed_by: who,
      },
      diag: diags[i],
      skipDedup: false,
    });
  }));

  const sent = results.filter(Boolean).length;
  targets.forEach((op: any, i: number) => {
    console.log("[broadcast] Enviando para:", phoneToApi(op.phone), "resultado:", results[i] ? (diags[i].reason ?? "sent") : (diags[i].reason ?? "failed"));
  });
  console.log("[NOTIFY] maintenance_change finished:", { farmId, equipmentId, action, sent, total: targets.length });
  return { ok: true, mode: "immediate", sent, failed: targets.length - sent, operators: targets.length };
}

async function loadFarmOperators(supabase: any, farmId: string) {
  const { data: operators, error } = await supabase
    .from("whatsapp_operators")
    .select("phone, name, role, notification_preference, receive_alerts, farm_id, default_farm_id, is_active, last_message_at, user_id")
    .eq("is_active", true);
  if (error) {
    console.error("[immediate] operators query failed", error.message || JSON.stringify(error));
    return [];
  }
  console.log("[immediate] operators raw count:", operators?.length ?? 0, "farm:", farmId);
  const seen = new Set<string>();
  const targets: any[] = [];
  for (const o of (operators ?? []) as any[]) {
    const pref = (o.notification_preference || "default").toLowerCase();
    const isSuper = o.role === "super_admin";
    const belongsToFarm = o.farm_id === farmId || o.default_farm_id === farmId;
    if (!isSuper && !belongsToFarm) continue;
    if (pref === "mute" || pref === "mudo") continue;
    // Super admin sempre recebe. Para os demais, só bloqueia se receive_alerts
    // estiver explicitamente false; NULL/herança não pode matar notificação.
    if (!isSuper && o.receive_alerts === false) continue;
    const key = normalizePhoneKey(o.phone);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    targets.push(o);
  }
  console.log("[immediate] operators selected:", targets.length, targets.map((o: any) => ({ phone: o.phone, role: o.role, farm_id: o.farm_id, default_farm_id: o.default_farm_id })));
  return targets;
}

async function resolveFarmName(supabase: any, farmId: string, fallback?: string | null): Promise<string> {
  if (fallback) return fallback;
  const { data } = await supabase.from("farms").select("name").eq("id", farmId).maybeSingle();
  return data?.name ?? "Fazenda";
}

async function sendToAll(args: {
  supabase: any;
  config: any;
  phoneNumberId: string;
  operators: any[];
  farmId: string;
  message: string;
  tplParams: string[];
  messageType: string;
  metadata: Record<string, unknown>;
}) {
  const results = await Promise.all(args.operators.map((op) => sendSingleWhatsAppMessage({
    supabase: args.supabase,
    config: args.config,
    phoneNumberId: args.phoneNumberId,
    operator: op,
    farmId: args.farmId,
    message: args.message,
    tplParams: args.tplParams,
    messageType: args.messageType,
    metadata: args.metadata,
  })));
  return results.filter(Boolean).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICAÇÃO AGRUPADA (batch) — Ligar/Desligar
//
// Fluxo:
//  1. Comando individual → enqueueEquipmentControlBatch cria/atualiza um lote
//     aberto por (farm_id, operator_key, action). Janela de 10s reinicia a cada
//     novo comando.
//  2. Cron chama processBatchTick a cada ~5s:
//     • Fecha lotes cujo last_added_at está >= BATCH_WINDOW_MS atrás.
//     • Para lotes fechados: verifica confirmação de hardware
//       (parseEquipmentRunning). Se todos confirmados OU cada item passou de
//       CONFIRM_TIMEOUT_MS desde o pedido → dispara mensagem única.
//  3. Mensagem única traz lista com ✅ / ⚠️ por item.
//
// Comando isolado: se só 1 item no lote e a janela expirar sem novos → sai
// mensagem "individual" (formato antigo, 1 linha).
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_WINDOW_MS = 10_000;    // 10s de janela de agrupamento
const CONFIRM_TIMEOUT_MS = 90_000; // 90s máximo esperando confirmação por item

function operatorKeyFor(name: string | null | undefined, via: string): string {
  const clean = String(name ?? "").trim().toLowerCase();
  if (clean) return clean;
  const v = via.toLowerCase();
  if (v === "automação" || v === "automacao") return "__automation__";
  if (v === "local") return "__local__";
  return "__system__";
}

async function enqueueEquipmentControlBatch(supabase: any, _config: any, _phoneNumberId: string, body: any) {
  const equipmentId = body?.equipment_id ? String(body.equipment_id) : null;
  const action = String(body?.action ?? "").toLowerCase();
  const isOn = action === "ligado" || action === "on" || action === "ligar";
  const source = sourceLabel(body?.source);
  if (!equipmentId) return { ok: false, error: "missing_equipment_id" };

  const { data: eq } = await supabase
    .from("equipments")
    .select("id, name, farm_id, saida, last_outputs_state, updated_at")
    .eq("id", equipmentId)
    .maybeSingle();
  if (!eq) return { ok: false, error: "equipment_not_found" };

  const farmId = eq.farm_id as string;
  const farmName = await resolveFarmName(supabase, farmId, body?.farm_name);
  const equipmentName = eq.name ?? "Equipamento";
  const sourceClean = source.includes("|") ? source.split("|")[0].trim() : source;
  const via = viaChannelLabel(body?.via ?? body?.source);
  const operatorName = sourceClean || (via === "Automação" ? "Automação" : via === "Local" ? "Sistema" : "Operador");
  const operatorKey = operatorKeyFor(sourceClean, via);
  const actionKey = isOn ? "on" : "off";
  const excludeDigits = String(body?.exclude_phone ?? "").replace(/\D/g, "");

  const nowIso = new Date().toISOString();
  const item = {
    equipment_id: equipmentId,
    equipment_name: equipmentName,
    saida: eq.saida ?? null,
    expected_on: isOn,
    requested_at: nowIso,
    confirmed_at: null as string | null,
    timed_out: false,
  };

  // Localiza lote aberto compatível (janela ainda válida).
  const windowStart = new Date(Date.now() - BATCH_WINDOW_MS).toISOString();
  const { data: openBatches } = await supabase
    .from("whatsapp_notification_batches")
    .select("id, items, last_added_at, farm_name")
    .eq("farm_id", farmId)
    .eq("operator_key", operatorKey)
    .eq("action", actionKey)
    .eq("status", "open")
    .gte("last_added_at", windowStart)
    .order("last_added_at", { ascending: false })
    .limit(1);

  const open = openBatches?.[0];
  if (open) {
    const items = Array.isArray(open.items) ? [...open.items] : [];
    if (!items.find((x: any) => x.equipment_id === equipmentId)) items.push(item);
    await supabase
      .from("whatsapp_notification_batches")
      .update({ items, last_added_at: nowIso, updated_at: nowIso })
      .eq("id", open.id);
    console.log("[batch] appended to open batch", { id: open.id, equipmentId, action: actionKey, size: items.length });
    return { ok: true, mode: "batched", batch_id: open.id, appended: true };
  }

  const { data: created, error: createErr } = await supabase
    .from("whatsapp_notification_batches")
    .insert({
      farm_id: farmId,
      operator_key: operatorKey,
      operator_name: operatorName,
      via,
      action: actionKey,
      items: [item],
      exclude_phone: excludeDigits || null,
      status: "open",
      opened_at: nowIso,
      last_added_at: nowIso,
    })
    .select("id")
    .maybeSingle();
  if (createErr) {
    console.error("[batch] insert failed", createErr.message);
    return { ok: false, error: "batch_insert_failed", detail: createErr.message };
  }
  // Guarda farmName no metadata do primeiro item para evitar re-consulta depois
  console.log("[batch] created new batch", { id: created?.id, equipmentId, action: actionKey, farmName });
  return { ok: true, mode: "batched", batch_id: created?.id ?? null, appended: false };
}

// Verifica se cada item do lote já foi confirmado pelo hardware ou passou do
// timeout. Retorna { ready, items } onde items traz confirmed_at / timed_out
// atualizados.
async function evaluateBatchItems(supabase: any, items: any[]): Promise<{ ready: boolean; items: any[] }> {
  const now = Date.now();
  const pendingIds = items.filter((it: any) => !it.confirmed_at && !it.timed_out).map((it: any) => it.equipment_id);
  let freshMap = new Map<string, any>();
  if (pendingIds.length) {
    const { data: fresh } = await supabase
      .from("equipments")
      .select("id, saida, last_outputs_state, updated_at, desired_running")
      .in("id", pendingIds);
    for (const r of (fresh ?? []) as any[]) freshMap.set(r.id, r);
  }
  const next = items.map((it: any) => {
    if (it.confirmed_at || it.timed_out) return it;
    const fresh = freshMap.get(it.equipment_id);
    if (fresh) {
      const runningNow = parseEquipmentRunning(fresh.last_outputs_state, fresh.saida ?? it.saida, fresh.desired_running);
      if (runningNow === !!it.expected_on) {
        return { ...it, confirmed_at: new Date().toISOString() };
      }
    }
    const requestedMs = new Date(it.requested_at).getTime();
    if (now - requestedMs >= CONFIRM_TIMEOUT_MS) {
      return { ...it, timed_out: true };
    }
    return it;
  });
  const ready = next.every((it: any) => it.confirmed_at || it.timed_out);
  return { ready, items: next };
}

function buildBatchMessage(batch: any, farmName: string): { message: string; single: boolean } {
  const items: any[] = Array.isArray(batch.items) ? [...batch.items] : [];
  items.sort((a, b) => String(a.equipment_name ?? "").localeCompare(String(b.equipment_name ?? ""), "pt-BR", { numeric: true }));
  const isOn = batch.action === "on";
  const actionWord = isOn ? "LIGADOS" : "DESLIGADOS";
  const actionWordSingular = isOn ? "LIGADO" : "DESLIGADO";
  const icon = isOn ? "✅" : "⛔";
  const opened = new Date(batch.opened_at);
  const closed = new Date();
  const startStr = opened.toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + "h";
  const endStr = closed.toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }) + "h";
  const timeLine = startStr === endStr.replace(/^[0-9]{2}\/[0-9]{2}, /, "") ? `Horário: ${startStr}` : `Horário: ${startStr} — ${endStr}`;

  // Comando isolado (1 item) — mantém o formato individual antigo.
  if (items.length === 1) {
    const it = items[0];
    const warn = it.timed_out ? "\n⚠️ (não confirmou em 90s)" : "";
    const msg =
      `🔔 ${it.equipment_name} — ${actionWordSingular}${warn}\n` +
      `${farmLine(farmName)}\n` +
      `Operador: ${batch.operator_name}\n` +
      `Via: ${batch.via}\n` +
      `${timeLine}`;
    return { message: msg, single: true };
  }

  const lines = items.map((it: any) => {
    const mark = it.timed_out ? "⚠️ (não confirmou em 90s)" : "✅";
    return `• ${it.equipment_name} ${mark}`;
  });
  const msg =
    `${icon} ${items.length} equipamentos ${actionWord}\n` +
    `${farmLine(farmName)}\n\n` +
    `${lines.join("\n")}\n\n` +
    `Por: ${batch.operator_name}\n` +
    `Via: ${batch.via}\n` +
    `${timeLine}`;
  return { message: msg, single: false };
}

async function processBatchTick(supabase: any, config: any, phoneNumberId: string) {
  const nowIso = new Date().toISOString();
  const windowCutoff = new Date(Date.now() - BATCH_WINDOW_MS).toISOString();

  // 1) Fechar lotes cuja janela expirou.
  const { data: toClose } = await supabase
    .from("whatsapp_notification_batches")
    .select("id")
    .eq("status", "open")
    .lt("last_added_at", windowCutoff)
    .limit(50);
  if (toClose?.length) {
    const ids = toClose.map((r: any) => r.id);
    await supabase
      .from("whatsapp_notification_batches")
      .update({ status: "closed", closed_at: nowIso, updated_at: nowIso })
      .in("id", ids);
    console.log("[batch-tick] closed", ids.length, "batches");
  }

  // 2) Processar lotes fechados aguardando confirmação.
  const { data: closedBatches } = await supabase
    .from("whatsapp_notification_batches")
    .select("*")
    .eq("status", "closed")
    .order("closed_at", { ascending: true })
    .limit(20);

  let dispatched = 0;
  for (const batch of (closedBatches ?? []) as any[]) {
    const { ready, items } = await evaluateBatchItems(supabase, batch.items ?? []);
    if (!ready) {
      // Persiste progresso parcial (confirmed_at por item) mas mantém closed.
      await supabase
        .from("whatsapp_notification_batches")
        .update({ items, updated_at: nowIso })
        .eq("id", batch.id);
      continue;
    }
    // Todos confirmados ou expiraram → dispara.
    const farmName = await resolveFarmName(supabase, batch.farm_id);
    const { message } = buildBatchMessage({ ...batch, items }, farmName);
    const tplParams = [sanitizeTplParam(message).slice(0, 1000)];

    const allTargets = await loadFarmOperators(supabase, batch.farm_id);
    const excludeDigits = String(batch.exclude_phone ?? "").replace(/\D/g, "");
    const targets = excludeDigits
      ? allTargets.filter((o: any) => String(o?.phone ?? "").replace(/\D/g, "") !== excludeDigits)
      : allTargets;

    const sent = await Promise.all(targets.map((op: any) => sendSingleWhatsAppMessage({
      supabase, config, phoneNumberId, operator: op,
      farmId: batch.farm_id,
      message,
      tplParams,
      tplNameOverride: "alerta_equipamento",
      messageType: "equipment_control_batch_notification",
      metadata: {
        change_type: "equipment_state_batch",
        action: batch.action,
        via: batch.via,
        operator_name: batch.operator_name,
        farm_id: batch.farm_id,
        items: items.map((it: any) => ({ id: it.equipment_id, name: it.equipment_name, confirmed: !!it.confirmed_at, timed_out: !!it.timed_out })),
      },
      skipDedup: true,
    })));
    const sentCount = sent.filter(Boolean).length;

    await supabase
      .from("whatsapp_notification_batches")
      .update({ status: "sent", sent_at: nowIso, items, updated_at: nowIso })
      .eq("id", batch.id);

    // Marca pending_notifications relacionados como processados p/ evitar reenvio.
    try {
      const eqIds = items.map((it: any) => it.equipment_id).filter(Boolean);
      if (eqIds.length) {
        const sinceISO = new Date(new Date(batch.opened_at).getTime() - 30_000).toISOString();
        await supabase.from("pending_notifications")
          .update({ processed: true, processed_at: nowIso })
          .in("equipment_id", eqIds)
          .eq("change_type", "equipment_state")
          .eq("processed", false)
          .gte("created_at", sinceISO);
      }
    } catch { /* ignore */ }

    dispatched += 1;
    console.log("[batch-tick] dispatched", { id: batch.id, items: items.length, sent: sentCount, targets: targets.length });
  }

  return { ok: true, closed: toClose?.length ?? 0, dispatched };
}


async function sendDirectMessage(args: {
  supabase: any;
  config: any;
  phoneNumberId: string;
  phone: string;
  name?: string | null;
  farmId: string | null;
  message: string;
  tplParams: string[];
  messageType: string;
  metadata: Record<string, unknown>;
}) {
  const ok = await sendSingleWhatsAppMessage({
    supabase: args.supabase, config: args.config, phoneNumberId: args.phoneNumberId,
    operator: { phone: args.phone, name: args.name ?? null, last_message_at: null },
    farmId: args.farmId ?? "00000000-0000-0000-0000-000000000000",
    message: args.message, tplParams: args.tplParams,
    messageType: args.messageType, metadata: args.metadata,
  });
  return ok ? 1 : 0;
}

async function processImmediateOperatorDecision(supabase: any, config: any, phoneNumberId: string, body: any, approved: boolean) {
  const phone = body?.target_phone ? String(body.target_phone) : null;
  const name = body?.target_name ? String(body.target_name) : null;
  const farmId = body?.farm_id ? String(body.farm_id) : null;
  const reason = body?.reason ? String(body.reason) : null;
  if (!phone) return { ok: false, error: "missing_target_phone" };

  const farmName = farmId ? await resolveFarmName(supabase, farmId) : "—";
  const ts = fmtShortTimestamp(new Date());
  const message = approved
    ? `✅ Acesso aprovado!\nFazenda: ${farmName}\nQuando quiser, é só me mandar uma mensagem com o que precisa — ligar, desligar ou consultar status dos equipamentos.`
    : `❌ Solicitação de acesso recusada.\nFazenda: ${farmName}${reason ? `\nMotivo: ${reason}` : ""}\nSe achar que houve engano, fale com o responsável da fazenda.`;
  const tplParams = [
    (name ?? "Operador").slice(0, 60),
    approved ? "acesso aprovado" : "acesso recusado",
    farmName,
    ts,
  ];
  const sent = await sendDirectMessage({
    supabase, config, phoneNumberId, phone, name, farmId,
    message, tplParams,
    messageType: approved ? "operator_approved_notification" : "operator_rejected_notification",
    metadata: { via: body?.source ?? "frontend", source: "immediate_dashboard", target_phone: phone, approved },
  });
  return { ok: true, mode: "immediate", type: approved ? "operator_approved" : "operator_rejected", sent };
}

async function processImmediateInviteCode(supabase: any, config: any, phoneNumberId: string, body: any) {
  const phone = body?.target_phone ? String(body.target_phone) : null;
  const code = body?.code ? String(body.code) : null;
  const farmId = body?.farm_id ? String(body.farm_id) : null;
  const expiresAt = body?.expires_at ? new Date(String(body.expires_at)) : null;
  if (!phone || !code) return { ok: false, error: "missing_phone_or_code" };

  const farmName = farmId ? await resolveFarmName(supabase, farmId) : "—";
  const expiresStr = expiresAt ? fmtShortTimestamp(expiresAt) : "30 min";
  const message = `🔑 Seu código de cadastro:\n\n*${code}*\n\nFazenda: ${farmName}\nVálido até: ${expiresStr}\n\nEnvie este código aqui no WhatsApp para concluir seu cadastro.`;
  const tplParams = [
    "Operador".slice(0, 60),
    `código ${code}`,
    farmName,
    expiresStr,
  ];
  const sent = await sendDirectMessage({
    supabase, config, phoneNumberId, phone, name: null, farmId,
    message, tplParams,
    messageType: "invite_code_delivery",
    metadata: { via: body?.source ?? "frontend", source: "immediate_dashboard", code, expires_at: expiresAt?.toISOString() ?? null },
  });
  return { ok: true, mode: "immediate", type: "invite_code_created", sent };
}

async function processImmediatePermissionsChanged(supabase: any, config: any, phoneNumberId: string, body: any) {
  const phone = body?.target_phone ? String(body.target_phone) : null;
  const name = body?.target_name ? String(body.target_name) : null;
  const farmId = body?.farm_id ? String(body.farm_id) : null;
  const summary = body?.summary ? String(body.summary) : "Suas permissões foram atualizadas.";
  if (!phone) return { ok: false, error: "missing_target_phone" };

  const farmName = farmId ? await resolveFarmName(supabase, farmId) : "—";
  const ts = fmtShortTimestamp(new Date());
  const message = `🔧 ${summary}\nFazenda: ${farmName}\n${ts}`;
  const tplParams = [
    (name ?? "Operador").slice(0, 60),
    "permissões atualizadas",
    farmName,
    ts,
  ];
  const sent = await sendDirectMessage({
    supabase, config, phoneNumberId, phone, name, farmId,
    message, tplParams,
    messageType: "operator_permissions_changed",
    metadata: { via: body?.source ?? "frontend", source: "immediate_dashboard", target_phone: phone },
  });
  return { ok: true, mode: "immediate", type: "operator_permissions_changed", sent };
}

async function processImmediateAlert(supabase: any, config: any, phoneNumberId: string, body: any) {
  const farmId = body?.farm_id ? String(body.farm_id) : null;
  const equipmentId = body?.equipment_id ? String(body.equipment_id) : null;
  const alertType = body?.alert_type ? String(body.alert_type) : "alert";
  const messageInput = body?.message ? String(body.message) : "Alerta do sistema";
  let resolvedFarmId = farmId;
  let equipmentName: string | null = body?.equipment_name ?? null;
  if (!resolvedFarmId && equipmentId) {
    const { data } = await supabase.from("equipments").select("name, farm_id").eq("id", equipmentId).maybeSingle();
    resolvedFarmId = data?.farm_id ?? null;
    equipmentName = equipmentName ?? data?.name ?? null;
  }
  if (!resolvedFarmId) return { ok: false, error: "missing_farm_id" };

  const farmName = await resolveFarmName(supabase, resolvedFarmId, body?.farm_name);
  const ts = fmtShortTimestamp(new Date());

  // watchdog anti-spam + recovery pareado (electron_watchdog e agent-offline-watchdog).
  // alert_type esperado: bridge_down|pumps_offline|com_missing|agent_offline
  //                   OU bridge_recovered|pumps_recovered|com_recovered|agent_recovered
  const isWatchdog = body?.source === "electron_watchdog" || body?.source === "agent_offline_watchdog";
  const isRecovery = /_recovered$/.test(alertType) || /^✅/.test(messageInput);
  const baseType = isRecovery ? alertType.replace(/_recovered$/, "_down").replace(/^pumps_down$/, "pumps_offline").replace(/^com_down$/, "com_missing").replace(/^agent_down$/, "agent_offline") : alertType;

  if (isWatchdog) {
    const { data: state } = await supabase
      .from("watchdog_alerts_state")
      .select("id, is_active, last_sent_at")
      .eq("farm_id", resolvedFarmId)
      .eq("alert_type", baseType)
      .maybeSingle();

    if (isRecovery) {
      // Só envia recovery se o alerta original ainda estava ativo.
      if (!state || !state.is_active) {
        console.log(`[NOTIFY] watchdog recovery skipped (no active ${baseType} for farm ${resolvedFarmId})`);
        return { ok: true, mode: "immediate", type: "alert", sent: 0, skipped: "no_active_alert" };
      }
      await supabase.from("watchdog_alerts_state").update({
        is_active: false,
        last_sent_at: new Date().toISOString(),
        last_message: messageInput,
        updated_at: new Date().toISOString(),
      }).eq("id", state.id);
    } else {
      // Alerta normal: dedup por 10 minutos se ainda ativo.
      const nowMs = Date.now();
      if (state?.is_active && state.last_sent_at) {
        const ageMs = nowMs - new Date(state.last_sent_at).getTime();
        if (ageMs < 10 * 60 * 1000) {
          console.log(`[NOTIFY] watchdog alert ${baseType} suppressed (last sent ${Math.round(ageMs/1000)}s ago)`);
          return { ok: true, mode: "immediate", type: "alert", sent: 0, skipped: "antispam_10min" };
        }
      }
      const payload = {
        farm_id: resolvedFarmId,
        alert_type: baseType,
        is_active: true,
        last_sent_at: new Date().toISOString(),
        last_message: messageInput,
        metadata: body?.metadata ?? null,
        updated_at: new Date().toISOString(),
      };
      await supabase.from("watchdog_alerts_state").upsert(payload, { onConflict: "farm_id,alert_type" });
    }
  }

  const header = isRecovery ? (equipmentName ? `✅ ${equipmentName}` : `✅ ${farmName}`) : (equipmentName ? `⚠️ ${equipmentName}` : `⚠️ ${farmName}`);
  const message = `${header}\n${messageInput}\nFazenda: ${farmName}\n${ts}`;
  const tplParams = [
    (equipmentName ?? farmName).slice(0, 60),
    alertType,
    farmName,
    ts,
  ];
  let targets = await loadFarmOperators(supabase, resolvedFarmId);
  // electron_watchdog / agent_offline_watchdog: enviar APENAS para admins/super_admins da fazenda
  if (isWatchdog) {
    const before = targets.length;
    targets = targets.filter((o: any) => o?.role === "super_admin" || o?.role === "admin");
    console.log(`[NOTIFY] watchdog admin-only filter: ${before} → ${targets.length}`);
  }
  const sent = await sendToAll({
    supabase, config, phoneNumberId, operators: targets, farmId: resolvedFarmId,
    message, tplParams, messageType: `alert_${alertType}`,
    metadata: { via: body?.source ?? "frontend", source: "immediate_dashboard", alert_type: alertType, base_type: baseType, is_recovery: isRecovery, equipment_id: equipmentId, equipment_name: equipmentName },
  });
  return { ok: true, mode: "immediate", type: "alert", sent, operators: targets.length, alert_type: alertType, is_recovery: isRecovery };
}

// Drains pending_notifications queue for delayed/non-immediate events.
// Automation mode changes bypass this path completely and any leftover
// engine_mode/schedule_mode rows are marked processed without sending.
async function drainPendingNotifications(supabase: any, config: any, phoneNumberId: string, immediate = false): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data: pending, error: pendingError } = await supabase
    .from("pending_notifications")
    .select("*")
    .eq("processed", false)
    .or(`retry_at.is.null,retry_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(200);

  console.log("Pending notifications found:", pending?.length || 0);
  if (pendingError) {
    console.error("Error fetching pending:", pendingError.message || JSON.stringify(pendingError));
    return 0;
  }
  if (!pending?.length) return 0;

  // schedule_change: NEVER dedup, NEVER debounce. Send each row directly and
  // mark it processed. This is a retry lane from processImmediateScheduleChange.
  const scheduleRows = (pending as any[]).filter((r) => r.change_type === "schedule_change");
  let scheduleSent = 0;
  for (const row of scheduleRows) {
    const payload = row.payload ?? {};
    const res = await processImmediateScheduleChange(supabase, config, phoneNumberId, {
      farm_id: row.farm_id,
      farm_name: payload.farm_name,
      actor_name: payload.actor_name,
      via: payload.via ?? row.changed_via ?? "web",
      message: payload.message,
      __retry: true, // prevent enqueueing yet another retry
    });
    scheduleSent += Number((res as any)?.sent ?? 0);
    await supabase.from("pending_notifications")
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq("id", row.id);
  }
  const remainingPending = (pending as any[]).filter((r) => r.change_type !== "schedule_change");
  if (!remainingPending.length) return scheduleSent;




  const nowMs = Date.now();
  // Debounce: collapse to LAST event per (equipment_id|engine|change_type)
  // and ignore events whose created_at is older than 10 min (stale).
  const latest = new Map<string, any>();
  const skipIds: string[] = [];
  for (const row of remainingPending as any[]) {
    const ageMs = nowMs - new Date(row.created_at).getTime();
    if (!immediate && ageMs > 10 * 60 * 1000) { skipIds.push(row.id); continue; }
    // Modo automático não usa mais fila/cron. Qualquer linha remanescente é
    // marcada como processada para evitar atraso e duplicidade.
    if (row.change_type === "engine_mode" || row.change_type === "schedule_mode") {
      skipIds.push(row.id); continue;
    }
    // Anti-dup vs automation engine pipeline
    if (row.change_type === "equipment_state" && row.changed_via === "automacao") {
      skipIds.push(row.id); continue;
    }
    // WhatsApp commands ARE notified via this drain — only AFTER hardware
    // confirms the real state change (last_outputs_state). The commander is
    // excluded per-row using changed_by ("name|phone").

    const key = `${row.equipment_id ?? row.farm_id}|${row.change_type}`;
    const prev = latest.get(key);
    if (!prev || new Date(row.created_at).getTime() > new Date(prev.created_at).getTime()) {
      if (prev) skipIds.push(prev.id);
      latest.set(key, row);
    } else {
      skipIds.push(row.id);
    }
  }

  if (skipIds.length) {
    await supabase.from("pending_notifications")
      .update({ processed: true, processed_at: new Date().toISOString() })
      .in("id", skipIds);
  }

  const queue = [...latest.values()];
  if (!queue.length) return 0;

  // ─────────────────────────────────────────────────────────────────────────────
  // BATCHING SERVER-SIDE: quando várias linhas equipment_state chegam próximas
  // no tempo com mesmo operador/ação/fazenda, agrupamos em UMA mensagem.
  // Linhas solitárias frescas (< DEFER_YOUNG_ROW_MS) ficam pendentes p/ próximo
  // drain (10s depois) para permitir acumular irmãs.
  // ─────────────────────────────────────────────────────────────────────────────
  const DEFER_YOUNG_ROW_MS = 45_000;
  const BATCH_MIN_SIZE = 2;
  type BatchGroup = {
    key: string;
    rows: any[];
    farmId: string;
    operatorName: string;
    newValue: string;
    via: string;
    excludeUserId: string;
    excludeDigits: string;
  };
  const batchGroups = new Map<string, BatchGroup>();
  for (const r of queue) {
    if (r.change_type !== "equipment_state") continue;
    const rawBy = String(r.changed_by ?? "");
    const nameOnly = rawBy.includes("|") ? (rawBy.split("|")[0] || "").trim() : rawBy.trim();
    const tail = rawBy.includes("|") ? (rawBy.split("|")[1] || "").trim() : "";
    const key = `${r.farm_id}|${nameOnly}|${r.new_value}`;
    let g = batchGroups.get(key);
    if (!g) {
      g = {
        key,
        rows: [],
        farmId: r.farm_id,
        operatorName: nameOnly || "Usuário Web",
        newValue: r.new_value,
        via: r.changed_via,
        excludeUserId: tail.startsWith("user:") ? tail.slice(5).trim() : "",
        excludeDigits: !tail.startsWith("user:") ? tail.replace(/\D/g, "") : "",
      };
      batchGroups.set(key, g);
    }
    g.rows.push(r);
  }
  const batchedRowIds = new Set<string>();
  const deferredRowIds = new Set<string>();
  for (const g of batchGroups.values()) {
    if (g.rows.length >= BATCH_MIN_SIZE) {
      for (const r of g.rows) batchedRowIds.add(r.id);
    } else {
      const r = g.rows[0];
      const age = nowMs - new Date(r.created_at).getTime();
      if (!immediate && age < DEFER_YOUNG_ROW_MS) {
        deferredRowIds.add(r.id);
      }
    }
  }
  const filteredQueue = queue.filter((r) => !batchedRowIds.has(r.id) && !deferredRowIds.has(r.id));
  if (deferredRowIds.size) {
    console.log("[pending-notify] deferring solitary equipment_state rows for next drain:", deferredRowIds.size);
  }



  // Gather equipments and farms in one shot
  const eqIds = [...new Set(queue.map((r) => r.equipment_id).filter(Boolean))];
  const farmIds = [...new Set(queue.map((r) => r.farm_id).filter(Boolean))];
  const [{ data: eqs }, { data: farms }, { data: ops, error: opsError }] = await Promise.all([
    eqIds.length
      ? supabase.from("equipments").select("id, name, farm_id, saida, last_outputs_state, desired_running").in("id", eqIds)
      : Promise.resolve({ data: [] }),
    farmIds.length
      ? supabase.from("farms").select("id, name").in("id", farmIds)
      : Promise.resolve({ data: [] }),
    farmIds.length
      ? supabase.from("whatsapp_operators")
          .select("phone, name, role, notification_preference, receive_alerts, farm_id, default_farm_id, is_active, last_message_at, user_id")
          .eq("is_active", true)
      : Promise.resolve({ data: [] }),
  ]);

  if (opsError) console.error("[pending-notify] operators query failed", opsError.message || JSON.stringify(opsError));
  console.log("[pending-notify] farmIds:", JSON.stringify(farmIds), "operators:", ops?.length || 0);

  const eqById = new Map<string, any>(); (eqs ?? []).forEach((e: any) => eqById.set(e.id, e));
  const farmById = new Map<string, any>(); (farms ?? []).forEach((f: any) => farmById.set(f.id, f));
  const opsByFarm = new Map<string, any[]>();
  const phoneKeysByFarm = new Map<string, Set<string>>();
  for (const o of (ops ?? []) as any[]) {
    const pref = (o.notification_preference || "default").toLowerCase();
    const isSuper = o.role === "super_admin";
    const operatorFarmId = o.default_farm_id ?? o.farm_id;
    const eligibleFarms = isSuper ? farmIds : farmIds.filter((farmId) => operatorFarmId === farmId || o.farm_id === farmId || o.default_farm_id === farmId);
    if (!eligibleFarms.length) continue;
    if (!isSuper) {
      if (pref === "mute" || pref === "mudo") continue;
      if (o.receive_alerts === false) continue;
    }
    if (!o.phone) continue;
    for (const farmId of eligibleFarms) {
      addOperatorOnce(opsByFarm, phoneKeysByFarm, farmId, o);
    }
  }

  let sent = 0;
  const processedIds: string[] = [];

  // ── Dispatch batched equipment_state groups ─────────────────────────────
  for (const g of batchGroups.values()) {
    if (g.rows.length < BATCH_MIN_SIZE) continue;
    const isOn = g.newValue === "on";
    const icon = isOn ? "✅" : "⛔";
    const actionWord = isOn ? "LIGADAS" : "DESLIGADAS";
    const farmName = farmDisplayName(farmById.get(g.farmId)?.name ?? "—");
    const eqNames = g.rows
      .map((r) => eqById.get(r.equipment_id)?.name ?? "Equipamento")
      .sort((a: string, b: string) => a.localeCompare(b, "pt-BR", { numeric: true }));
    const sortedTimes = g.rows
      .map((r) => new Date(r.created_at))
      .sort((a, b) => a.getTime() - b.getTime());
    const startTs = sortedTimes[0];
    const endTs = sortedTimes[sortedTimes.length - 1];
    const startStr = startTs.toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + "h";
    const endHM = endTs.toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }) + "h";
    const startHM = startTs.toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }) + "h";
    const timeLine = startHM === endHM ? `Horário: ${startStr}` : `Horário: ${startStr} — ${endHM}`;
    const viaLabel = viaChannelLabel(g.via);
    const actorName = viaLabel === "Local"
      ? "Sistema"
      : safeActorName(g.operatorName, viaLabel === "Automação" ? "Automação" : "Plataforma Web");

    const message =
      `${icon} ${g.rows.length} BOMBAS ${actionWord}\n` +
      `${farmLine(farmName)}\n\n` +
      `${eqNames.join(", ")}\n\n` +
      `Por: ${actorName}\n` +
      `Via: ${viaLabel}\n` +
      `${timeLine}`;

    // Resolve exclusão do autor
    let excludeDigits = g.excludeDigits;
    const allTargets = opsByFarm.get(g.farmId) ?? [];
    if (g.excludeUserId) {
      const m = allTargets.find((o: any) => String(o?.user_id ?? "") === g.excludeUserId);
      if ((m as any)?.phone) excludeDigits = String((m as any).phone).replace(/\D/g, "");
    }
    // Web/plataforma: envia também para o autor (confirmação da ação).
    const skipActorExclusion = viaLabel === "Plataforma Web" || g.via === "web" || g.via === "remote";
    const targets = (excludeDigits && !skipActorExclusion)
      ? allTargets.filter((o: any) => String(o?.phone ?? "").replace(/\D/g, "") !== excludeDigits)
      : allTargets;
    if (!targets.length) {
      for (const r of g.rows) processedIds.push(r.id);
      continue;
    }

    const tplParams = [sanitizeTplParam(message).slice(0, 1000)];
    const results = await Promise.all(targets.map((op: any) => sendSingleWhatsAppMessage({
      supabase,
      config,
      phoneNumberId,
      operator: op,
      farmId: g.farmId,
      message,
      tplParams,
      tplNameOverride: "alerta_equipamento",
      messageType: "equipment_state_batch",
      metadata: {
        change_type: "equipment_state_batch",
        action: isOn ? "on" : "off",
        via: viaLabel,
        operator_name: actorName,
        farm_id: g.farmId,
        items: g.rows.map((r) => ({ id: r.equipment_id, name: eqById.get(r.equipment_id)?.name })),
        source: "pending_notifications_batched",
      },
      skipDedup: true,
    })));
    sent += results.filter(Boolean).length;
    for (const r of g.rows) processedIds.push(r.id);
    console.log("[pending-notify] batched group sent", { farm: g.farmId, action: g.newValue, size: g.rows.length, delivered: results.filter(Boolean).length });
  }

  for (const row of filteredQueue) {

    console.log("Processing notification:", JSON.stringify(row));
    const allTargets = opsByFarm.get(row.farm_id) ?? [];
    // changed_by pode vir como:
    //  - "Nome|55779..."         → WhatsApp (telefone do operador)
    //  - "Nome|user:<uuid>"      → usuário web (auth.user.id do autor)
    //  - "Nome"                  → texto puro
    const rawChangedBy: string = String(row.changed_by ?? "");
    let displayName = rawChangedBy;
    let excludeDigits = "";
    let excludeUserId = "";
    let isWebDashboard = false;
    if (rawChangedBy.includes("|")) {
      const [n, p] = rawChangedBy.split("|");
      displayName = (n || "").trim() || rawChangedBy;
      const tail = (p || "").trim();
      if (tail.startsWith("user:")) {
        excludeUserId = tail.slice(5).trim();
        isWebDashboard = true;
      } else {
        excludeDigits = tail.replace(/\D/g, "");
      }
    }
    // Se veio user:<uuid>, descobre o telefone do operador WhatsApp linkado a esse user
    if (excludeUserId) {
      const match = allTargets.find((o: any) => String(o?.user_id ?? "") === excludeUserId);
      if (match?.phone) excludeDigits = String(match.phone).replace(/\D/g, "");
    }
    // Web/plataforma: envia TAMBÉM para quem fez a ação (confirmação).
    // WhatsApp/outros: mantém exclusão do autor (ele já recebeu o ACK inline).
    const skipActorExclusion = isWebDashboard || row.changed_via === "web";
    const targets = (excludeDigits && !skipActorExclusion
      ? allTargets.filter((o: any) => String(o?.phone ?? "").replace(/\D/g, "") !== excludeDigits)
      : allTargets);
    if (!targets.length) { processedIds.push(row.id); continue; }
    const farmName = farmDisplayName(farmById.get(row.farm_id)?.name ?? "—");
    const eqName = row.equipment_id ? (eqById.get(row.equipment_id)?.name ?? "Equipamento") : null;
    const ts = fmtShortTimestamp(new Date(row.created_at));

    const cleanDisplayName = sourceLabel(displayName) || (isWebDashboard ? "Usuário Web" : "");
    const who = isWebDashboard
      ? cleanDisplayName
      : (cleanDisplayName || sourceLabel(row.changed_via) || "Usuário Web");
    let action = "";
    let actionShort = "";

    if (row.change_type === "local_change") {
      const turnedOn = row.new_value === "on" || row.payload?.new_running === true;
      // Anti-spam STATE-AWARE: 30min window, and LIGOU vs DESLIGOU are different events.
      const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: recentAlerts } = await supabase
        .from("whatsapp_alerts_log")
        .select("id, message_sent")
        .eq("alert_type", "local_change")
        .eq("equipment_id", row.equipment_id)
        .gte("created_at", since)
        .limit(5);
      const stateKw = turnedOn ? "LIGOU" : "DESLIGOU";
      const dup = (recentAlerts ?? []).some((r: any) =>
        String(r.message_sent || "").toUpperCase().includes(stateKw)
      );
      if (dup) { processedIds.push(row.id); continue; }

      action = turnedOn ? "LIGOU" : "DESLIGOU";
      actionShort = turnedOn ? "acionamento local" : "desligamento local/inesperado";
    } else if (row.change_type === "equipment_state") {
      const turnedOn = row.new_value === "on";
      action = turnedOn ? "LIGADO" : "DESLIGADO";
      actionShort = turnedOn ? "ligado" : "desligado";
    } else if (row.change_type === "engine_mode") {
      const on = row.new_value === "on";
      action = on ? "Modo automático ATIVADO" : "Modo automático DESATIVADO";
      actionShort = on ? "modo automático ativado" : "modo automático desativado";
    } else if (row.change_type === "schedule_mode") {
      const on = row.new_value === "on";
      action = on ? "Modo automático ativado" : "Modo automático desativado";
      actionShort = on ? "modo automático ativado" : "modo automático desativado";
    } else {
      processedIds.push(row.id);
      continue;
    }

    const modeEnabled = row.new_value === "on";
    const message = row.change_type === "local_change"
      ? (row.new_value === "on" || row.payload?.new_running === true
          ? `🔔 ${eqName ?? farmName} LIGOU\n` +
            `${farmLine(farmName)}\n\n` +
            `Por: Sistema\n` +
            `Via: Local\n` +
            `Horário: ${ts}`
          : `⚠️ ${eqName ?? farmName} DESLIGOU\n` +
            `${farmLine(farmName)}\n\n` +
            `Por: Sistema\n` +
            `Via: Local\n` +
            `Horário: ${ts}`)
      : row.change_type === "engine_mode" || row.change_type === "schedule_mode"
        ? buildModeChangeMessage({
            equipmentName: eqName,
            farmName,
            enabled: modeEnabled,
            who,
            ts,
            running: parseEquipmentRunning(
              eqById.get(row.equipment_id)?.last_outputs_state,
              eqById.get(row.equipment_id)?.saida,
              eqById.get(row.equipment_id)?.desired_running,
            ),
          })
        : (() => {
            const turnedOn = row.new_value === "on";
            const icon = turnedOn ? "✅" : "⛔";
            const via = viaChannelLabel(row.changed_via);
            // Local: nunca tem autor confiável → sempre "Sistema".
            const actorName = via === "Local"
              ? "Sistema"
              : safeActorName(who, via === "Automação" ? "Automação" : "Plataforma Web");
            return `${icon} ${(eqName ?? farmName)} — ${action}\n` +
              `${farmLine(farmName)}\n\n` +
              `Por: ${actorName}\n` +
              `Via: ${via}\n` +
              `Horário: ${ts}`;
          })();


    const isModeChange = row.change_type === "engine_mode" || row.change_type === "schedule_mode";
    const isLocalChange = row.change_type === "local_change";
    const tplName = isLocalChange ? "alerta_equipamento" : isModeChange ? "modo_automatico_atualizado" : "automacao_executada";
    const tplParams = isModeChange
      ? [sanitizeTplParam(message).slice(0, 1000)]
      : isLocalChange
        ? [sanitizeTplParam(message).slice(0, 1000)]
        : [
            (eqName ?? farmName).slice(0, 60),
            actionShort,
            farmName,
            ts,
          ];


    let rowSent = 0;
    for (const op of targets) {
      console.log("Sending to operator:", op.phone);
      let metaId: string | null = null;
      let usedMode: "text" | "template" = "text";
      let sentOk = false;
      try {
        const toDigits = phoneToApi(op.phone);
        const rt = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.api_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to: toDigits, type: "text", text: { body: message } }),
        });
        const jt = await rt.json().catch(() => ({}));
        console.log("Send result:", JSON.stringify({ ok: rt.ok, mode: "text", phone: toDigits, result: jt }));
        if (rt.ok && !(jt as any)?.error) {
          metaId = (jt as any)?.messages?.[0]?.id ?? null;
          sentOk = true;
        } else if (metaErrorCode((jt as any)?.error || jt) === 131047) {
          console.log("[pending-notify] text outside 24h; falling back to alerta_equipamento/template", toDigits);
          usedMode = "template";
          const r = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.api_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              messaging_product: "whatsapp", to: toDigits, type: "template",
              template: { name: tplName, language: { code: "pt_BR" }, components: [{
                type: "body", parameters: templateParamsFor(tplName, tplParams).map((p) => ({ type: "text", text: String(p) })),
              }] },
            }),
          });
          const j = await r.json().catch(() => ({}));
          console.log("Send result:", JSON.stringify({ ok: r.ok, mode: "template", template: tplName, phone: toDigits, result: j }));
          if (!r.ok || (j as any)?.error) {
            console.error("[pending-notify] template fail", toDigits, JSON.stringify((j as any)?.error || j));
          } else {
            metaId = (j as any)?.messages?.[0]?.id ?? null;
            sentOk = true;
          }
        } else {
          console.error("[pending-notify] text fail", toDigits, JSON.stringify((jt as any)?.error || jt));
        }
      } catch (e) {
        console.error("[pending-notify] send failed", op.phone, e);
      }
      if (!sentOk) continue;
      sent++;
      rowSent++;
      try {
        await supabase.from("whatsapp_message_log").insert({
          direction: "outgoing",
          phone: op.phone,
          operator_name: op.name ?? null,
          farm_id: row.farm_id,
          message_type: usedMode === "template" ? "template" : (isLocalChange ? "alert_local_change" : "state_change_notification"),
          message_body: usedMode === "template" ? `[template:${tplName}]` : message,
          message_id: metaId,
          metadata: { change_type: row.change_type, old: row.old_value, new: row.new_value, via: row.changed_via, source: "pending_notifications", alert_type: isLocalChange ? "local_change" : undefined },
          group_id: null,
        });
      } catch (e) { console.error("[pending-notify] log failed", e); }
    }

    if (rowSent > 0) {
      processedIds.push(row.id);
    } else {
      console.error("[pending-notify] no message delivered; keeping row pending for retry", { id: row.id, change_type: row.change_type, equipment_id: row.equipment_id });
    }

    if (rowSent > 0 && row.change_type === "local_change" && row.equipment_id) {
      try {
        await supabase.from("whatsapp_alerts_log").insert({
          alert_type: "local_change",
          equipment_id: row.equipment_id,
          equipment_name: eqName ?? null,
          previous_state: row.old_value ?? null,
          new_state: row.new_value ?? null,
          message_sent: message,
        });
      } catch (e) { console.error("[pending-notify] local_change alerts_log failed", e); }
    }
  }

  if (processedIds.length) {
    await supabase.from("pending_notifications")
      .update({ processed: true, processed_at: new Date().toISOString() })
      .in("id", processedIds);
  }
  return sent;
}



async function detectExpired(supabase: any) {
  // Hoje em America/Sao_Paulo
  const now = new Date();
  const tzNow = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  const todayCode = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"][tzNow.getDay()];
  const hhmmNow = tzNow.getHours() * 60 + tzNow.getMinutes();
  const todayStart = new Date(tzNow); todayStart.setHours(0, 0, 0, 0);

  // Só considera schedules de fazendas com o motor de automação ATIVADO.
  // Se automation_engine.enabled = false, o sistema não tentou executar nada,
  // portanto não faz sentido reportar "programação não executada".
  const { data: enabledEngines } = await supabase
    .from("automation_engine")
    .select("farm_id, updated_at")
    .eq("enabled", true);

  const enabledFarmIds = new Set<string>((enabledEngines ?? []).map((e: any) => e.farm_id));
  // Guarda o instante em que o motor foi ligado (last toggle). Se o motor foi
  // ligado DEPOIS do horário programado, aquele slot ainda estava desativado —
  // não faz sentido reportar "não executada".
  const engineEnabledSince = new Map<string, Date>(
    (enabledEngines ?? []).map((e: any) => [e.farm_id, new Date(e.updated_at)]),
  );
  if (!enabledFarmIds.size) return;

  const { data: schedules } = await supabase
    .from("automation_schedules")
    .select("id, farm_id, equipment_id, mode, days, time_on, time_off, active, last_on_executed_at, last_off_executed_at")
    .eq("active", true)
    .in("farm_id", Array.from(enabledFarmIds));

  if (!schedules?.length) return;

  const expiredRows: any[] = [];
  for (const s of schedules) {
    if (!s.days?.includes?.(todayCode)) continue;

    const checkSide = async (kind: "on" | "off") => {
      const t = kind === "on" ? s.time_on : s.time_off;
      if (!t) return;
      if (s.mode === "on-only" && kind === "off") return;
      if (s.mode === "off-only" && kind === "on") return;
      const [hh, mm] = String(t).split(":").map(Number);
      const minutesOfDay = (hh || 0) * 60 + (mm || 0);
      const diff = hhmmNow - minutesOfDay;
      // Expirou: passou 5-30 min do horário programado e não executou hoje.
      // Janela reduzida de 15 → 5 min para que o alerta chegue AINDA dentro
      // do horário de ponta (produtor precisa agir antes das 21h).
      if (diff < 5 || diff > 30) return;

      // Só reporta "não executada" se o motor de automação já estava ligado NO
      // MOMENTO da programação. Se o produtor ativou o modo automático DEPOIS
      // do horário programado, aquele slot estava intencionalmente desativado.
      const scheduledAt = new Date(tzNow);
      scheduledAt.setHours(hh || 0, mm || 0, 0, 0);
      const enabledSince = engineEnabledSince.get(s.farm_id);
      if (enabledSince && enabledSince > scheduledAt) return;

      const lastExec = kind === "on" ? s.last_on_executed_at : s.last_off_executed_at;
      if (lastExec) {
        const lastTz = new Date(new Date(lastExec).toLocaleString("en-US", { timeZone: TZ }));
        if (lastTz >= todayStart) return; // já executou hoje
      }
      // Evita duplicar: verifica se já há uma row 'expired' hoje para esta schedule+ação
      const action = kind === "on" ? "liga" : "desliga";
      const { data: existing } = await supabase
        .from("automation_execution_log")
        .select("id")
        .eq("schedule_id", s.id)
        .eq("action", action)
        .eq("status", "expired")
        .gte("executed_at", todayStart.toISOString())
        .limit(1);
      if (existing?.length) return;
      expiredRows.push({
        farm_id: s.farm_id,
        equipment_id: s.equipment_id,
        schedule_id: s.id,
        action,
        scheduled_time: t,
        executed_at: new Date().toISOString(),
        status: "expired",
        origin: "automatico",
      });
    };
    await checkSide("on");
    await checkSide("off");
  }

  if (expiredRows.length) {
    await supabase.from("automation_execution_log").insert(expiredRows);
  }
}
