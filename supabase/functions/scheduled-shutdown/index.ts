// scheduled-shutdown — Desligamento Programado (Fazenda Semear, 17h BRT).
// ───────────────────────────────────────────────────────────────────────────
// Máquina de estados IDEMPOTENTE, disparada pelo pg_cron a cada minuto entre
// 17:00 e 17:03 BRT (= 20:00–20:03 UTC). Cada invocação avança uma tentativa,
// usando a tabela `scheduled_shutdowns` como estado (1 linha por fazenda/dia).
//
//   17:00 → tentativa 1 (desliga todas as bombas ligadas)
//   17:01 → confere; tentativa 2 (reenvia só p/ as que resistiram)
//   17:02 → confere; tentativa 3 (FORÇADO p/ as que ainda resistem)
//   17:03 → confere final; se sobrou alguma → 1 alerta WhatsApp consolidado
//
// Desligar = RPC enqueue_reset_pump_command (TX 0 incondicional). Bomba ligada
// LOCAL (ou tentativa 3): garante forced_shutdown_enabled=true → o agente roda a
// sequência de desligamento FORÇADO sozinho. NÃO interfere se o auto/web já
// comandou desligar (desired_running já false e não é local).
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
const MAX_ATTEMPTS = 3;
const CONFIRM_WAIT_MS = 50_000; // ~1 min entre tentativas (cron dispara a cada 1 min)
const COMM_STALE_MS = 30 * 60_000;

function isRunning(los: string | null, saida: number | null): boolean {
  const p = String(los ?? "");
  const idx = (saida ?? 1) - 1;
  if (p.length === 1) return p === "1";
  if (!/^[01]{1,6}$/.test(p)) return false;
  if (idx < 0 || idx >= p.length) return false;
  return p[idx] === "1";
}

// Data local (BRT, UTC-3) em YYYY-MM-DD — chave do "run" do dia.
function brtDateStr(d: Date): string {
  const brt = new Date(d.getTime() - 3 * 3600_000);
  return brt.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = new Date();
  const runDate = brtDateStr(now);

  // 1) linha de estado do dia (cria se não existir)
  let { data: run } = await supabase
    .from("scheduled_shutdowns")
    .select("*").eq("farm_id", FARM_ID).eq("run_date", runDate).maybeSingle();
  if (!run) {
    const ins = await supabase.from("scheduled_shutdowns")
      .insert({ farm_id: FARM_ID, run_date: runDate, attempt: 0, status: "running" })
      .select("*").single();
    run = ins.data;
  }
  if (!run) return json({ ok: false, error: "no_run_row" }, 500);
  if (run.status === "done") return json({ ok: true, skipped: "already_done" });

  // 2) bombas da fazenda (poço/bombeamento ativas, exceto excluídas)
  const { data: eqs } = await supabase
    .from("equipments")
    .select("id, name, saida, last_outputs_state, desired_running, last_actuation_origin, forced_shutdown_enabled, communication_status, last_communication")
    .eq("farm_id", FARM_ID).in("type", ["poco", "bombeamento"]).eq("active", true);
  const pumps = ((eqs ?? []) as any[]).filter((e) => !EXCLUDE_EQUIPMENT_IDS.includes(e.id));
  const onPumps = pumps.filter((e) => isRunning(e.last_outputs_state, e.saida));

  const lastAt = run.last_attempt_at ? new Date(run.last_attempt_at).getTime() : 0;
  const elapsed = now.getTime() - lastAt;

  // 3) FASE FINAL — depois da 3ª tentativa: confere e (se sobrou) alerta consolidado.
  if (run.attempt >= MAX_ATTEMPTS) {
    if (elapsed < CONFIRM_WAIT_MS) return json({ ok: true, phase: "final_wait" });
    if (onPumps.length === 0) {
      await supabase.from("scheduled_shutdowns")
        .update({ status: "done", alert_sent: false, remaining: [], updated_at: now.toISOString() })
        .eq("id", run.id);
      return json({ ok: true, result: "all_off_silent" });
    }
    await sendConsolidatedAlert(supabase, onPumps);
    await supabase.from("scheduled_shutdowns")
      .update({ status: "done", alert_sent: true, remaining: onPumps.map((p) => ({ id: p.id, name: p.name })), updated_at: now.toISOString() })
      .eq("id", run.id);
    return json({ ok: true, result: "alert_sent", remaining: onPumps.length });
  }

  // 4) TENTATIVAS 1/2/3 — respeita a janela de confirmação de ~60s entre elas.
  if (run.attempt > 0 && elapsed < CONFIRM_WAIT_MS) return json({ ok: true, phase: "wait", attempt: run.attempt });

  const attempt = run.attempt + 1;
  const forcedAll = attempt >= MAX_ATTEMPTS; // 3ª tentativa = forçado p/ todas as remanescentes
  const acted: any[] = [];

  for (const p of onPumps) {
    const isLocal = String(p.last_actuation_origin ?? "").toLowerCase() === "local";
    const alreadyOffCmd = p.desired_running === false && !isLocal;
    // NÃO interfere se o auto/web já mandou desligar (evita conflito) — só monitora,
    // exceto na 3ª tentativa (aí força de qualquer forma).
    if (alreadyOffCmd && attempt < MAX_ATTEMPTS) {
      acted.push({ id: p.id, name: p.name, action: "monitor", origin: p.last_actuation_origin });
      continue;
    }
    const useForced = forcedAll || isLocal;
    try {
      if (useForced && p.forced_shutdown_enabled !== true) {
        await supabase.from("equipments").update({ forced_shutdown_enabled: true }).eq("id", p.id);
      }
      await supabase.from("equipments").update({ desired_running: false }).eq("id", p.id);
      await supabase.rpc("enqueue_reset_pump_command", {
        _farm_id: FARM_ID, _equipment_id: p.id,
        _reason: `scheduled_shutdown_17h_a${attempt}${useForced ? "_forced" : ""}`,
      });
      acted.push({ id: p.id, name: p.name, action: useForced ? "forced" : "normal", origin: p.last_actuation_origin });
    } catch (e) {
      acted.push({ id: p.id, name: p.name, action: "error", error: (e as Error).message });
    }
  }

  await supabase.from("scheduled_shutdowns")
    .update({ attempt, last_attempt_at: now.toISOString(), targeted: acted, status: "running", updated_at: now.toISOString() })
    .eq("id", run.id);
  console.log(`[scheduled-shutdown] ${FARM_NAME} tentativa ${attempt}/${MAX_ATTEMPTS}: ${acted.length} bomba(s) — ${JSON.stringify(acted).slice(0, 500)}`);
  return json({ ok: true, attempt, on: onPumps.length, acted });
});

// ── Alerta WhatsApp CONSOLIDADO (1 única mensagem) ──
async function sendConsolidatedAlert(supabase: any, remaining: any[]): Promise<void> {
  try {
    const { data: cfg } = await supabase
      .from("whatsapp_config").select("api_token, phone_number_id")
      .not("api_token", "is", null).not("phone_number_id", "is", null)
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!cfg?.api_token || !cfg?.phone_number_id) {
      console.error("[scheduled-shutdown] sem whatsapp_config — não enviei alerta");
      return;
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
    const freeText =
      `⚠️ DESLIGAMENTO 17H — ${FARM_NAME}\n\n` +
      `${n} bomba${n === 1 ? "" : "s"} NÃO desligaram após ${MAX_ATTEMPTS} tentativas:\n` +
      `${lines.join("\n")}\n\n` +
      `Ação necessária: verificar presencialmente.`;
    const tplParams = [
      `⚠️ DESLIGAMENTO 17H — ${n} bomba${n === 1 ? "" : "s"} resistiram`,
      FARM_NAME,
      "Falha no desligamento programado",
      `${names} · Verificar presencialmente`,
    ].map((s) => String(s).replace(/[\r\n\t]+/g, " ").replace(/\s{5,}/g, "    ").slice(0, 1000));

    for (const to of ALERT_RECIPIENTS) {
      // fora da janela de 24h (admins): template. Se falhar por 131047, tenta texto.
      const okTpl = await sendTemplate(cfg, to, "alerta_equipamento", tplParams);
      if (!okTpl) await sendText(cfg, to, freeText);
    }
  } catch (e) {
    console.error("[scheduled-shutdown] alerta falhou:", (e as Error).message);
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
