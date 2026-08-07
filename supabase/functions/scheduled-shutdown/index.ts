// scheduled-shutdown — Desligamento Programado (Fazenda Semear, 17h BRT).
// ───────────────────────────────────────────────────────────────────────────
// Máquina de estados IDEMPOTENTE, disparada pelo pg_cron a cada minuto entre
// 17:00 e 17:20 BRT (= 20:00–20:20 UTC), SEGUNDA A SEXTA. Cada passo é indexado
// pelo MINUTO BRT e roda uma única vez (registrado em scheduled_shutdowns.steps_done).
//
//   17:00 → Tentativa 1: desliga TODAS as bombas ligadas
//   17:05 → Tentativa 2: reenvia p/ as que continuam ligadas (forçado se local)
//   17:10 → Tentativa 3: reenvia FORÇADO p/ as que resistem  +  AVISO 1 (WhatsApp)
//   17:20 → Verificação final: se AINDA há bomba ligada → AVISO 2 (último aviso)
//
//   AVISO 1 (17:10): lista consolidada das bombas que não desligaram após 3 tentativas.
//   AVISO 2 (17:20): só se ainda houver bomba ligada — "verificar presencialmente".
//   Se todas desligaram em qualquer ponto → silêncio.
//
// Desligar = RPC enqueue_reset_pump_command (TX 0 incondicional). Bomba ligada
// LOCAL (ou a partir da 3ª tentativa): garante forced_shutdown_enabled=true → o
// agente roda a sequência de desligamento FORÇADO sozinho. NÃO interfere se o
// auto/web já comandou desligar (só monitora), exceto na 3ª tentativa (força).
// ───────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const GRAPH = "https://graph.facebook.com/v21.0";

// ── CONFIG (futuro: mover para tabela shutdown_schedules por fazenda) ──
const FARM_ID = "0b1d53df-6d5c-4674-8517-9299aac3ec18"; // Fazenda Semear
const FARM_NAME = "Fazenda Semear";
const EXCLUDE_EQUIPMENT_IDS: string[] = [];              // futuro: bombas de reservatório etc.
const ALERT_RECIPIENTS = ["5577999608294", "5577981503951"];
const COMM_STALE_MS = 30 * 60_000;

// Passos indexados pelo minuto BRT (hora fixa = 17). Ordenados por minuto.
type Step = { key: string; minute: number; attempt?: number; forcedAll?: boolean; alert?: 1 | 2; final?: boolean };
const STEPS: Step[] = [
  { key: "a1", minute: 0, attempt: 1, forcedAll: false },
  { key: "a2", minute: 5, attempt: 2, forcedAll: false },
  { key: "a3", minute: 10, attempt: 3, forcedAll: true, alert: 1 },
  { key: "final", minute: 20, final: true, alert: 2 },
];

function isRunning(los: string | null, saida: number | null): boolean {
  const p = String(los ?? "");
  const idx = (saida ?? 1) - 1;
  if (p.length === 1) return p === "1";
  if (!/^[01]{1,6}$/.test(p)) return false;
  if (idx < 0 || idx >= p.length) return false;
  return p[idx] === "1";
}

// Componentes locais (BRT, UTC-3): data YYYY-MM-DD, hora, minuto, dia-da-semana (0=dom..6=sáb).
function brtParts(d: Date) {
  const brt = new Date(d.getTime() - 3 * 3600_000);
  return {
    date: brt.toISOString().slice(0, 10),
    hour: brt.getUTCHours(),
    minute: brt.getUTCMinutes(),
    dow: brt.getUTCDay(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = new Date();
  const p = brtParts(now);

  // Guardas de janela: só seg–sex, só na hora 17 BRT.
  if (p.dow < 1 || p.dow > 5) return json({ ok: true, skipped: "weekend", dow: p.dow });
  if (p.hour !== 17) return json({ ok: true, skipped: "off_hours", hour: p.hour });

  // 1) linha de estado do dia (cria se não existir)
  let { data: run } = await supabase
    .from("scheduled_shutdowns")
    .select("*").eq("farm_id", FARM_ID).eq("run_date", p.date).maybeSingle();
  if (!run) {
    const ins = await supabase.from("scheduled_shutdowns")
      .insert({ farm_id: FARM_ID, run_date: p.date, attempt: 0, status: "running", steps_done: [] })
      .select("*").single();
    run = ins.data;
  }
  if (!run) return json({ ok: false, error: "no_run_row" }, 500);

  // 2) próximo passo devido: o mais cedo ainda não feito cujo minuto já chegou.
  const doneSet = new Set<string>((run.steps_done ?? []) as string[]);
  const step = STEPS.find((s) => !doneSet.has(s.key) && p.minute >= s.minute);
  if (!step) return json({ ok: true, phase: "idle", minute: p.minute, done: [...doneSet] });

  // 3) bombas ligadas AGORA (poço/bombeamento ativas, exceto excluídas)
  const onPumps = await fetchOnPumps(supabase);

  // 4) AVISO 1 (na 3ª tentativa) — lista consolidada ANTES de comandar o forçado.
  let alert1Sent = false;
  if (step.alert === 1 && onPumps.length > 0) {
    alert1Sent = await sendConsolidatedAlert(supabase, onPumps, 1);
  }

  // 5) Tentativas 1/2/3 — comanda desligamento nas bombas ligadas.
  let acted: any[] = [];
  if (step.attempt) acted = await commandShutdown(supabase, onPumps, step);

  // 6) AVISO 2 (verificação final 17:20) — só se ainda há bomba ligada.
  let alert2Sent = false;
  let finalDone = false;
  if (step.final) {
    if (onPumps.length > 0) alert2Sent = await sendConsolidatedAlert(supabase, onPumps, 2);
    finalDone = true;
  }

  // 7) persiste estado
  doneSet.add(step.key);
  const patch: Record<string, unknown> = {
    steps_done: [...doneSet],
    updated_at: now.toISOString(),
    status: finalDone ? "done" : "running",
  };
  if (step.attempt) { patch.attempt = step.attempt; patch.last_attempt_at = now.toISOString(); patch.targeted = acted; }
  if (step.alert === 1) { patch.alert1_sent = alert1Sent; patch.remaining = onPumps.map((x) => ({ id: x.id, name: x.name })); }
  if (step.final) { patch.alert2_sent = alert2Sent; patch.remaining = onPumps.map((x) => ({ id: x.id, name: x.name })); }
  await supabase.from("scheduled_shutdowns").update(patch).eq("id", run.id);

  console.log(`[scheduled-shutdown] ${FARM_NAME} passo ${step.key} (17:${String(step.minute).padStart(2, "0")}): ` +
    `on=${onPumps.length} acted=${acted.length} alert1=${alert1Sent} alert2=${alert2Sent}`);
  return json({ ok: true, step: step.key, on: onPumps.length, acted, alert1Sent, alert2Sent });
});

// ── Bombas ligadas agora ──
async function fetchOnPumps(supabase: any): Promise<any[]> {
  const { data: eqs } = await supabase
    .from("equipments")
    .select("id, name, saida, last_outputs_state, desired_running, last_actuation_origin, forced_shutdown_enabled, last_communication")
    .eq("farm_id", FARM_ID).in("type", ["poco", "bombeamento"]).eq("active", true);
  const pumps = ((eqs ?? []) as any[]).filter((e) => !EXCLUDE_EQUIPMENT_IDS.includes(e.id));
  return pumps.filter((e) => isRunning(e.last_outputs_state, e.saida));
}

// ── Comanda o desligamento das bombas ligadas nesta tentativa ──
async function commandShutdown(supabase: any, onPumps: any[], step: Step): Promise<any[]> {
  const acted: any[] = [];
  for (const p of onPumps) {
    const isLocal = String(p.last_actuation_origin ?? "").toLowerCase() === "local";
    const alreadyOffCmd = p.desired_running === false && !isLocal;
    // NÃO interfere se o auto/web já mandou desligar — só monitora — exceto na
    // tentativa forçada (3ª), aí força de qualquer forma.
    if (alreadyOffCmd && !step.forcedAll) {
      acted.push({ id: p.id, name: p.name, action: "monitor", origin: p.last_actuation_origin });
      continue;
    }
    const useForced = step.forcedAll || isLocal;
    try {
      if (useForced && p.forced_shutdown_enabled !== true) {
        await supabase.from("equipments").update({ forced_shutdown_enabled: true }).eq("id", p.id);
      }
      await supabase.from("equipments").update({ desired_running: false }).eq("id", p.id);
      await supabase.rpc("enqueue_reset_pump_command", {
        _farm_id: FARM_ID, _equipment_id: p.id,
        _reason: `scheduled_shutdown_17h_a${step.attempt}${useForced ? "_forced" : ""}`,
      });
      acted.push({ id: p.id, name: p.name, action: useForced ? "forced" : "normal", origin: p.last_actuation_origin });
    } catch (e) {
      acted.push({ id: p.id, name: p.name, action: "error", error: (e as Error).message });
    }
  }
  return acted;
}

// ── Alerta WhatsApp CONSOLIDADO (1 única mensagem). which: 1 = pós-3ª tentativa, 2 = final ──
async function sendConsolidatedAlert(supabase: any, remaining: any[], which: 1 | 2): Promise<boolean> {
  try {
    const { data: cfg } = await supabase
      .from("whatsapp_config").select("api_token, phone_number_id")
      .not("api_token", "is", null).not("phone_number_id", "is", null)
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!cfg?.api_token || !cfg?.phone_number_id) {
      console.error("[scheduled-shutdown] sem whatsapp_config — não enviei alerta");
      return false;
    }
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
    const plural = n === 1 ? "" : "s";

    const freeText = which === 1
      ? `⚠️ DESLIGAMENTO 17H — ${FARM_NAME}\n\n` +
        `${n} bomba${plural} NÃO desligaram após 3 tentativas:\n${lines.join("\n")}\n\n` +
        `Nova verificação às 17:20.`
      : `🚨 DESLIGAMENTO 17H — ${FARM_NAME}\n\n` +
        `${n} bomba${plural} AINDA ligada${plural} após todas as tentativas:\n${lines.join("\n")}\n\n` +
        `Ação necessária: verificar presencialmente.`;

    const tplParams = (which === 1
      ? [
          `⚠️ DESLIGAMENTO 17H — ${n} bomba${plural} resistiram`,
          FARM_NAME,
          "Não desligaram após 3 tentativas",
          `${names} · Nova verificação 17:20`,
        ]
      : [
          `🚨 ÚLTIMO AVISO — ${n} bomba${plural} AINDA ligada${plural}`,
          FARM_NAME,
          "Desligamento programado falhou",
          `${names} · Verificar presencialmente`,
        ]
    ).map((s) => String(s).replace(/[\r\n\t]+/g, " ").replace(/\s{5,}/g, "    ").slice(0, 1000));

    let anyOk = false;
    for (const to of ALERT_RECIPIENTS) {
      const okTpl = await sendTemplate(cfg, to, "alerta_equipamento", tplParams);
      if (okTpl) anyOk = true;
      else await sendText(cfg, to, freeText); // fallback dentro da janela de 24h
    }
    return anyOk;
  } catch (e) {
    console.error("[scheduled-shutdown] alerta falhou:", (e as Error).message);
    return false;
  }
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
