// scheduled-shutdown — Automações Programadas de desligamento (config-driven).
// ───────────────────────────────────────────────────────────────────────────
// SEM nada hardcoded. Disparada pelo pg_cron a cada minuto. A cada tick:
//   1. lê scheduled_automations WHERE is_active
//   2. para cada regra, checa se o dia da semana (BRT) e a janela de horário batem
//   3. executa a máquina de estados de tentativas conforme a config da regra
//
// Config por regra (tabela scheduled_automations):
//   time_brt (HH:MM = tentativa 1), retry_interval_min, max_retries,
//   days_of_week (mon..sun), excluded_equipment_ids, alert_after_retries, action.
//
// Cronograma derivado (offsets em minutos a partir de time_brt):
//   tentativa k em (k-1)*interval, k=1..max_retries
//   AVISO 1 junto da última tentativa (se alert_after_retries)
//   verificação final em max_retries*interval → AVISO 2 se ainda houver bomba ligada
//
// Desligar = RPC enqueue_reset_pump_command (TX 0). Bomba LOCAL (ou última
// tentativa): forced_shutdown_enabled=true → o agente roda o forçado sozinho.
// NÃO interfere se o auto/web já mandou desligar (só monitora), exceto na
// última tentativa (força). Idempotente via scheduled_shutdowns.steps_done.
// ───────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const GRAPH = "https://graph.facebook.com/v21.0";
const ALERT_RECIPIENTS = ["5577999608294", "5577981503951"]; // futuro: por regra
const COMM_STALE_MS = 30 * 60_000;
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type Step = { key: string; offset: number; attempt?: number; forcedAll?: boolean; alert?: 1 | 2; final?: boolean };

function isRunning(los: string | null, saida: number | null): boolean {
  const p = String(los ?? "");
  const idx = (saida ?? 1) - 1;
  if (p.length === 1) return p === "1";
  if (!/^[01]{1,6}$/.test(p)) return false;
  if (idx < 0 || idx >= p.length) return false;
  return p[idx] === "1";
}

// Componentes locais (BRT, UTC-3).
function brtParts(d: Date) {
  const brt = new Date(d.getTime() - 3 * 3600_000);
  const hour = brt.getUTCHours();
  const minute = brt.getUTCMinutes();
  return { date: brt.toISOString().slice(0, 10), hour, minute, dow: brt.getUTCDay(), minuteOfDay: hour * 60 + minute };
}

// Constrói os passos a partir da config da regra.
function buildSteps(maxRetries: number, interval: number, alertAfter: boolean): Step[] {
  const steps: Step[] = [];
  for (let k = 1; k <= maxRetries; k++) {
    const last = k === maxRetries;
    steps.push({ key: `a${k}`, offset: (k - 1) * interval, attempt: k, forcedAll: last, alert: last && alertAfter ? 1 : undefined });
  }
  steps.push({ key: "final", offset: maxRetries * interval, final: true, alert: alertAfter ? 2 : undefined });
  return steps;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = new Date();
  const p = brtParts(now);
  const dowToken = DOW[p.dow];

  const { data: autos, error } = await supabase
    .from("scheduled_automations").select("*").eq("is_active", true);
  if (error) return json({ ok: false, error: error.message }, 500);

  const ran: any[] = [];
  for (const a of (autos ?? []) as any[]) {
    try {
      const days: string[] = a.days_of_week ?? [];
      if (!days.includes(dowToken)) continue;

      const mt = /^(\d{2}):(\d{2})$/.exec(String(a.time_brt ?? ""));
      if (!mt) continue;
      const startMin = parseInt(mt[1], 10) * 60 + parseInt(mt[2], 10);
      const interval = Math.max(1, a.retry_interval_min ?? 5);
      const maxRetries = Math.max(1, a.max_retries ?? 3);
      const elapsed = p.minuteOfDay - startMin;
      const windowEnd = maxRetries * interval;
      if (elapsed < 0 || elapsed > windowEnd) continue; // fora da janela desta regra

      const steps = buildSteps(maxRetries, interval, a.alert_after_retries !== false);

      // linha de estado do dia (por automação)
      let { data: run } = await supabase
        .from("scheduled_shutdowns")
        .select("*").eq("automation_id", a.id).eq("run_date", p.date).maybeSingle();
      if (!run) {
        const ins = await supabase.from("scheduled_shutdowns")
          .insert({ automation_id: a.id, farm_id: a.farm_id, run_date: p.date, attempt: 0, status: "running", steps_done: [] })
          .select("*").single();
        run = ins.data;
      }
      if (!run) continue;

      const doneSet = new Set<string>((run.steps_done ?? []) as string[]);
      const step = steps.find((s) => !doneSet.has(s.key) && elapsed >= s.offset);
      if (!step) continue;

      const farmName = await fetchFarmName(supabase, a.farm_id);
      const onPumps = await fetchOnPumps(supabase, a);

      // AVISO 1 (na última tentativa) — lista consolidada ANTES de comandar o forçado.
      let alert1Sent = false;
      if (step.alert === 1 && onPumps.length > 0) alert1Sent = await sendAlert(supabase, farmName, onPumps, 1, maxRetries);

      // Tentativas — comanda desligamento nas bombas ligadas.
      let acted: any[] = [];
      if (step.attempt) acted = await commandShutdown(supabase, a, onPumps, step);

      // AVISO 2 (verificação final) — só se ainda há bomba ligada.
      let alert2Sent = false;
      if (step.final && onPumps.length > 0) alert2Sent = await sendAlert(supabase, farmName, onPumps, 2, maxRetries);

      // persiste estado do run
      doneSet.add(step.key);
      const patch: Record<string, unknown> = {
        steps_done: [...doneSet], updated_at: now.toISOString(),
        status: step.final ? "done" : "running",
      };
      if (step.attempt) { patch.attempt = step.attempt; patch.last_attempt_at = now.toISOString(); patch.targeted = acted; }
      if (step.alert === 1 || step.final) patch.remaining = onPumps.map((x) => ({ id: x.id, name: x.name }));
      if (step.alert === 1) patch.alert1_sent = alert1Sent;
      if (step.final) patch.alert2_sent = alert2Sent;
      await supabase.from("scheduled_shutdowns").update(patch).eq("id", run.id);

      // marca a regra
      await supabase.from("scheduled_automations").update({
        last_run_at: now.toISOString(),
        last_run_result: { step: step.key, on: onPumps.length, acted: acted.length, alert1Sent, alert2Sent, at: now.toISOString() },
        updated_at: now.toISOString(),
      }).eq("id", a.id);

      console.log(`[scheduled-shutdown] "${a.name}" (${farmName}) passo ${step.key}: on=${onPumps.length} acted=${acted.length} a1=${alert1Sent} a2=${alert2Sent}`);
      ran.push({ automation: a.name, step: step.key, on: onPumps.length, acted: acted.length, alert1Sent, alert2Sent });
    } catch (e) {
      console.error(`[scheduled-shutdown] erro na regra "${a?.name}":`, (e as Error).message);
      ran.push({ automation: a?.name, error: (e as Error).message });
    }
  }

  return json({ ok: true, brt: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`, dow: dowToken, ran });
});

async function fetchFarmName(supabase: any, farmId: string): Promise<string> {
  const { data } = await supabase.from("farms").select("name").eq("id", farmId).maybeSingle();
  return data?.name ?? "Fazenda";
}

async function fetchOnPumps(supabase: any, a: any): Promise<any[]> {
  const { data: eqs } = await supabase
    .from("equipments")
    .select("id, name, saida, last_outputs_state, desired_running, last_actuation_origin, forced_shutdown_enabled, last_communication")
    .eq("farm_id", a.farm_id).in("type", ["poco", "bombeamento"]).eq("active", true);
  let pumps = (eqs ?? []) as any[];
  if (a.action === "shutdown_specific") {
    const targets = new Set<string>(a.target_equipment_ids ?? []);
    pumps = pumps.filter((e) => targets.has(e.id));      // apenas as escolhidas
  } else {
    const ex = new Set<string>(a.excluded_equipment_ids ?? []);
    pumps = pumps.filter((e) => !ex.has(e.id));          // todas, menos as exceções
  }
  return pumps.filter((e) => isRunning(e.last_outputs_state, e.saida));
}

async function commandShutdown(supabase: any, a: any, onPumps: any[], step: Step): Promise<any[]> {
  const farmId = a.farm_id;
  // Atribuição no relatório ("Por"). Gravamos APENAS last_changed_by (campo
  // display-only; o agente nunca o lê). NÃO tocamos last_actuation_origin: a
  // detecção de bomba LOCAL (='local') alimenta o desligamento FORÇADO e a
  // reconciliação do polling no agente; sobrescrever quebraria isso. A troca de
  // ORIGEM no relatório é feita pelo trigger BEFORE INSERT em automation_log.
  // Rótulo "Automação {HH}h" derivado do horário da regra (ex.: "Automação 17h").
  const hh = parseInt(String(a.time_brt ?? "").slice(0, 2), 10);
  // "Por" no relatório = NOME da regra (ex.: "Desligamento 17h Semear"); só cai no
  // genérico "Automação {HH}h" se a regra não tiver nome.
  const changedBy = (a.name && String(a.name).trim())
    ? String(a.name).trim()
    : (Number.isFinite(hh) ? `Automação ${hh}h` : "Desligamento Programado");
  const nowIso = new Date().toISOString();
  const acted: any[] = [];
  for (const p of onPumps) {
    const isLocal = String(p.last_actuation_origin ?? "").toLowerCase() === "local";
    const alreadyOffCmd = p.desired_running === false && !isLocal;
    if (alreadyOffCmd && !step.forcedAll) {
      acted.push({ id: p.id, name: p.name, action: "monitor", origin: p.last_actuation_origin });
      continue;
    }
    const useForced = step.forcedAll || isLocal;
    try {
      if (useForced && p.forced_shutdown_enabled !== true) {
        await supabase.from("equipments").update({ forced_shutdown_enabled: true }).eq("id", p.id);
      }
      await supabase.from("equipments").update({
        desired_running: false,
        last_changed_by: changedBy,
        updated_at: nowIso,
      }).eq("id", p.id);
      await supabase.rpc("enqueue_reset_pump_command", {
        _farm_id: farmId, _equipment_id: p.id,
        _reason: `scheduled_shutdown_a${step.attempt}${useForced ? "_forced" : ""}`,
      });
      acted.push({ id: p.id, name: p.name, action: useForced ? "forced" : "normal", origin: p.last_actuation_origin });
    } catch (e) {
      acted.push({ id: p.id, name: p.name, action: "error", error: (e as Error).message });
    }
  }
  return acted;
}

// which: 1 = pós-última tentativa · 2 = verificação final
async function sendAlert(supabase: any, farmName: string, remaining: any[], which: 1 | 2, maxRetries: number): Promise<boolean> {
  try {
    const { data: cfg } = await supabase
      .from("whatsapp_config").select("api_token, phone_number_id")
      .not("api_token", "is", null).not("phone_number_id", "is", null)
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!cfg?.api_token || !cfg?.phone_number_id) { console.error("[scheduled-shutdown] sem whatsapp_config"); return false; }

    const now = Date.now();
    const reasonFor = (p: any): string => {
      const stale = p.last_communication ? (now - new Date(p.last_communication).getTime()) > COMM_STALE_MS : true;
      if (stale) return "Sem comunicação";
      if (String(p.last_actuation_origin ?? "").toLowerCase() === "local") return "Ligado via Local (forçado falhou)";
      return "Ligado (não desligou)";
    };
    const lines = remaining.map((p) => `• ${p.name} — ${reasonFor(p)}`);
    const names = remaining.map((p) => p.name).join(", ");
    const n = remaining.length;
    const pl = n === 1 ? "" : "s";

    const freeText = which === 1
      ? `⚠️ DESLIGAMENTO PROGRAMADO — ${farmName}\n\n${n} bomba${pl} NÃO desligaram após ${maxRetries} tentativas:\n${lines.join("\n")}\n\nNova verificação em instantes.`
      : `🚨 DESLIGAMENTO PROGRAMADO — ${farmName}\n\n${n} bomba${pl} AINDA ligada${pl} após todas as tentativas:\n${lines.join("\n")}\n\nAção necessária: verificar presencialmente.`;

    const tplParams = (which === 1
      ? [`⚠️ DESLIGAMENTO — ${n} bomba${pl} resistiram`, farmName, `Não desligaram após ${maxRetries} tentativas`, `${names} · Nova verificação em instantes`]
      : [`🚨 ÚLTIMO AVISO — ${n} bomba${pl} AINDA ligada${pl}`, farmName, "Desligamento programado falhou", `${names} · Verificar presencialmente`]
    ).map((s) => String(s).replace(/[\r\n\t]+/g, " ").replace(/\s{5,}/g, "    ").slice(0, 1000));

    let anyOk = false;
    for (const to of ALERT_RECIPIENTS) {
      const okTpl = await sendTemplate(cfg, to, "alerta_equipamento", tplParams);
      if (okTpl) anyOk = true; else await sendText(cfg, to, freeText);
    }
    return anyOk;
  } catch (e) { console.error("[scheduled-shutdown] alerta falhou:", (e as Error).message); return false; }
}

async function sendTemplate(cfg: any, to: string, name: string, params: string[]): Promise<boolean> {
  try {
    const r = await fetch(`${GRAPH}/${cfg.phone_number_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.api_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to, type: "template",
        template: { name, language: { code: "pt_BR" }, components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }] },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j as any)?.error) { console.error("[scheduled-shutdown] template fail", to, JSON.stringify((j as any)?.error || j)); return false; }
    return true;
  } catch (e) { console.error("[scheduled-shutdown] template err", to, (e as Error).message); return false; }
}
async function sendText(cfg: any, to: string, text: string): Promise<void> {
  try {
    await fetch(`${GRAPH}/${cfg.phone_number_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.api_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
    });
  } catch (e) { console.error("[scheduled-shutdown] text err", to, (e as Error).message); }
}
