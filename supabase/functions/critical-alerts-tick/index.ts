// Edge function: critical-alerts-tick
//
// Roda a cada 1 min via pg_cron. Gera alertas no sino (farm_notifications)
// 24/7 — mesmo sem nenhum cliente logado. Eventos separados em duas categorias:
//
//   FAILURE
//   #1  equipamento_offline           → sem comunicação por 15 min (1 saída)
//                                        ou 20 min (>1 saída/Boosters)
//   #5  automatico_nao_obedecido      → comando automático bem-sucedido há 1–3 min
//                                       cujo estado real não corresponde ao desejado
//   #6  falta_energia                 → ≥4 equipamentos da MESMA fazenda perderam
//                                       comunicação na mesma janela de 1 min
//   #7  safety_timer_fired            → agente disparou safety timer (bomba não
//                                       confirmou comando em 60s)
//
//   SYSTEM
//   #8  peak_hour_start / peak_hour_end  → 18:00 / 21:00 America/Sao_Paulo
//   #9  ota_applied                       → atualização do agente concluída
//
// Dedup: usa o unique index (farm_id, source, source_ref) de farm_notifications.
// Quando o equipamento volta a comunicar a notif #1 é DELETADA e marca resolved_at.
//
// Autenticação: header `x-cron-secret` == CRON_SECRET.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

// Thresholds por TIPO de equipamento (alinhado com a plataforma web):
//   • poço (type='poco')          → 15 min sem comunicação
//   • bomba (type='bombeamento')  → 20 min sem comunicação
//   • outros                      → 15 min (fallback conservador)
const OFFLINE_MIN_POCO  = 15;
const OFFLINE_MIN_BOMBA = 20;
const AUTO_CHECK_MIN_AGE_S = 60;
const AUTO_CHECK_MAX_AGE_S = 180;
const BLACKOUT_MIN_EQUIPS = 4;
const BLACKOUT_WINDOW_S = 60;
const BLACKOUT_COOLDOWN_MIN = 5;
const SAFETY_LOG_WINDOW_MIN = 5;
const OTA_WINDOW_MIN = 5;

type Equip = {
  id: string;
  farm_id: string;
  name: string;
  saida: number | null;
  desired_running: boolean;
  last_outputs_state: string | null;
  last_communication: string | null;
  communication_status: string;
  plc_group_id: string | null;
  maintenance_mode?: boolean | null;
  type?: string | null;
};



type AutoLog = {
  id: string;
  farm_id: string;
  equipment_id: string | null;
  equipment_name: string;
  action: string;
  occurred_at: string;
};

function bitAt(state: string | null, saida: number | null): "0" | "1" | null {
  if (!state || saida == null || saida < 1 || saida > state.length) return null;
  return state[saida - 1] === "1" ? "1" : "0";
}

// Retorna a hora local (0-23) America/Sao_Paulo
function hourInSaoPaulo(d: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit", hour12: false,
  });
  return Number(fmt.format(d));
}
function dateKeySaoPaulo(d: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(d); // YYYY-MM-DD
}
// UUID determinístico (v5-ish) a partir de string — sem dependência externa.
async function uuidFromString(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const b = Array.from(hash.slice(0, 16), hex).join("");
  return `${b.slice(0,8)}-${b.slice(8,12)}-${b.slice(12,16)}-${b.slice(16,20)}-${b.slice(20,32)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Auth: só permite chamadas do pg_cron/serviços internos.
  // Aceita `x-cron-secret == CRON_SECRET` OU bearer com o service_role_key.
  const cronHeader = req.headers.get("x-cron-secret") ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const ok =
    (CRON_SECRET.length > 0 && cronHeader === CRON_SECRET) ||
    (SERVICE_ROLE.length > 0 && bearer === SERVICE_ROLE);
  if (!ok) {
    console.warn("[critical-alerts-tick] unauthorized", {
      has_secret: !!cronHeader, has_auth: !!authHeader,
    });
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }
  console.log("[critical-alerts-tick] authorized invocation");

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const now = Date.now();
  const summary = {
    offline_inserted: 0, offline_cleared: 0,
    auto_violations: 0, blackouts: 0,
    safety_timer: 0, peak_events: 0, ota_events: 0,
    orphan_cycles_closed: 0,
    bridge_offline_events: 0, bridge_recovered_events: 0,
  };


  try {
    // ─── #0 fecha ciclos offline órfãos ──────────────────────────────────────
    // Equipamentos que estão online agora mas o último status_read no log foi
    // "equipamento_offline" recebem um "equipamento_online" sintético em
    // occurred_at = last_communication. Resolve eventos "Em andamento" eternos.
    //
    // PERFORMANCE: roda apenas 1x a cada 5 minutos (não a cada 1 min) — a
    // query é pesada (DISTINCT ON por equipamento + JOIN) e não precisa
    // dessa cadência. O cron continua disparando a cada 1 min para os outros
    // alertas (offline / blackout / safety), mas o RPC abaixo só executa
    // quando o minuto atual UTC é múltiplo de 5.
    if (new Date().getUTCMinutes() % 5 === 0) {
      try {
        const { data: closed } = await sb.rpc("close_orphan_offline_cycles");
        summary.orphan_cycles_closed = Number(closed ?? 0);
      } catch (e) {
        console.error("[critical-alerts-tick] close_orphan_offline_cycles", e);
      }
    }

    // ─── #1 equipamento_offline ──────────────────────────────────────────────
    // Critério por equipamento:
    //   • 1 saída no PLC          → offline após 15 min sem comunicação
    //   • >1 saídas no mesmo PLC  → offline após 20 min (Boosters)
    // Equipamentos/PLCs sem telemetria real há mais de 24 h são ignorados silenciosamente.
    const STALE_IGNORE_MS = 24 * 60 * 60_000;
    const staleIgnoreCutoff = new Date(now - STALE_IGNORE_MS).toISOString();

    const { data: allEquips } = await sb
      .from("equipments")
      .select("id, farm_id, name, saida, desired_running, last_outputs_state, last_communication, communication_status, plc_group_id, maintenance_mode, type")
      .eq("active", true)
      .in("communication_status", ["online", "offline"])
      .not("last_communication", "is", null);

    const equips = ((allEquips ?? []) as Equip[]).filter((e) => e.maintenance_mode !== true);

    // Compartilha last_communication entre equipamentos do mesmo PLC (mesma placa
    // física responde por todas as saídas). Sem isso, uma saída pode aparecer
    // offline enquanto outra do mesmo PLC acabou de responder.
    const plcLastComm = new Map<string, string>();
    for (const e of equips) {
      if (!e.plc_group_id || !e.last_communication) continue;
      const current = plcLastComm.get(e.plc_group_id);
      if (!current || new Date(e.last_communication).getTime() > new Date(current).getTime()) {
        plcLastComm.set(e.plc_group_id, e.last_communication);
      }
    }

    const effectiveLastComm = (e: Equip): string | null => {
      if (!e.plc_group_id) return e.last_communication;
      const shared = plcLastComm.get(e.plc_group_id);
      if (!shared) return e.last_communication;
      if (!e.last_communication) return shared;
      return new Date(shared).getTime() > new Date(e.last_communication).getTime() ? shared : e.last_communication;
    };

    // Threshold por TIPO de equipamento — alinhado com a plataforma web.
    const offlineMinFor = (e: Equip) => {
      const t = (e.type ?? "").toLowerCase();
      if (t === "bombeamento") return OFFLINE_MIN_BOMBA; // 20 min
      return OFFLINE_MIN_POCO; // 15 min — poço e demais
    };
    const isStaleFor = (e: Equip) => {
      const lastComm = effectiveLastComm(e);
      if (!lastComm || lastComm < staleIgnoreCutoff) return false;
      const cutoff = new Date(now - offlineMinFor(e) * 60_000).toISOString();
      return lastComm < cutoff;
    };
    const observedEquips = equips.filter((e) => {
      const lastComm = effectiveLastComm(e);
      return !!lastComm && lastComm >= staleIgnoreCutoff;
    });
    const offlineEquips = observedEquips.filter((e) => e.communication_status === "online" && isStaleFor(e));
    const onlineEquips = observedEquips.filter((e) => !isStaleFor(e));




    // Cache farm names for WhatsApp dispatch
    const farmIds = Array.from(new Set([...offlineEquips, ...onlineEquips].map((e) => e.farm_id)));
    const farmNameMap = new Map<string, string>();
    if (farmIds.length > 0) {
      const { data: farmRows } = await sb.from("farms").select("id, name").in("id", farmIds);
      for (const f of (farmRows ?? []) as Array<{id:string; name:string}>) farmNameMap.set(f.id, f.name);
    }

    async function dispatchWhatsApp(payload: Record<string, unknown>) {
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-alerts`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${SERVICE_ROLE}`,
            "apikey": SERVICE_ROLE,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        console.error("[critical-alerts-tick] whatsapp dispatch failed", e);
      }
    }

    if (offlineEquips.length > 0) {
      // Insere alerta novo apenas se NÃO existe alerta não-resolvido para o equipamento.
      const equipIds = offlineEquips.map((e) => e.id);
      const { data: openAlerts } = await sb
        .from("farm_notifications")
        .select("source_ref")
        .eq("source", "offline_alert")
        .is("resolved_at", null)
        .in("source_ref", equipIds);
      const openSet = new Set((openAlerts ?? []).map((r: { source_ref: string }) => r.source_ref));
      const newOfflineRaw = offlineEquips.filter((e) => !openSet.has(e.id));

      // Anti-flap WhatsApp: se houve offline/back_online do mesmo equipamento
      // nos últimos 5 minutos, não abre alerta nem dispara mensagem agora.
      const recentFlapIds = new Set<string>();
      if (newOfflineRaw.length > 0) {
        const fiveMinAgo = new Date(now - 5 * 60_000).toISOString();
        const { data: recentFlaps } = await sb
          .from("whatsapp_alerts_log")
          .select("equipment_id")
          .in("alert_type", ["offline", "back_online"])
          .gte("created_at", fiveMinAgo)
          .in("equipment_id", newOfflineRaw.map((e) => e.id));
        for (const row of (recentFlaps ?? []) as Array<{ equipment_id: string | null }>) {
          if (row.equipment_id) recentFlapIds.add(row.equipment_id);
        }
      }
      const newOffline = newOfflineRaw.filter((e) => !recentFlapIds.has(e.id));

      const rows = newOffline.map((e) => ({
          farm_id: e.farm_id, kind: "failure", severity: "warning", equipment_id: e.id,
          title: `${e.name} — Sem comunicação`,
          message: `Equipamento sem comunicação há mais de ${offlineMinFor(e)} minutos.`,
          source: "offline_alert", source_ref: e.id,
        }));
      if (rows.length > 0) {
        const { count } = await sb
          .from("farm_notifications")
          .upsert(rows, { onConflict: "farm_id,source,source_ref", ignoreDuplicates: true, count: "exact" });
        summary.offline_inserted = count ?? 0;
      }
      // BACKUP path: flip communication_status='offline' for equipments not yet flipped.
      // The notify_equipment_change trigger fires whatsapp-alerts INSTANTLY on the column
      // transition (primary path). The fetch fallback below covers the rare case where
      // pg_net is unavailable. whatsapp-alerts dedupes with a 30-min anti-spam window.
      const toFlipOffline = newOffline.filter((e) => e.communication_status !== "offline").map((e) => e.id);
      if (toFlipOffline.length > 0) {
        await sb.from("equipments").update({ communication_status: "offline" }).in("id", toFlipOffline);
      }
      for (const e of newOffline) {
        await dispatchWhatsApp({
          alert_type: "offline",
          equipment_id: e.id,
          equipment_name: e.name,
          farm_id: e.farm_id,
          farm_name: farmNameMap.get(e.farm_id) ?? null,
        });
      }
    }

    if (onlineEquips.length > 0) {
      const ids = onlineEquips.map((e) => e.id);
      // Quais estavam com alerta aberto? Esses são os que "voltaram".
      const { data: recovering } = await sb
        .from("farm_notifications")
        .select("source_ref")
        .eq("source", "offline_alert")
        .is("resolved_at", null)
        .in("source_ref", ids);
      const recoveringSet = new Set((recovering ?? []).map((r: { source_ref: string }) => r.source_ref));

      // Marca alertas como resolvidos (mantém histórico — NÃO deleta).
      const { count } = await sb.from("farm_notifications")
        .update({ resolved_at: new Date().toISOString() }, { count: "exact" })
        .eq("source", "offline_alert")
        .is("resolved_at", null)
        .in("source_ref", ids);
      summary.offline_cleared = count ?? 0;

      // Back-online só pode ser enviado quando existia um ciclo offline REAL
      // aberto pelo próprio critério de 30+ minutos (farm_notifications).
      // Não usar apenas communication_status='offline' aqui: esse campo pode ter
      // sido flipado por flaps/bridge legado antes dos 30 min, e isso geraria
      // um falso "voltou ONLINE" 1 minuto depois.
      const recoveredCandidatesRaw = onlineEquips.filter((e) => recoveringSet.has(e.id));

      const recentFlapIds = new Set<string>();
      if (recoveredCandidatesRaw.length > 0) {
        const fiveMinAgo = new Date(now - 5 * 60_000).toISOString();
        const { data: recentFlaps } = await sb
          .from("whatsapp_alerts_log")
          .select("equipment_id")
          .in("alert_type", ["offline", "back_online"])
          .gte("created_at", fiveMinAgo)
          .in("equipment_id", recoveredCandidatesRaw.map((e) => e.id));
        for (const row of (recentFlaps ?? []) as Array<{ equipment_id: string | null }>) {
          if (row.equipment_id) recentFlapIds.add(row.equipment_id);
        }
      }
      const recoveredCandidates = recoveredCandidatesRaw.filter((e) => !recentFlapIds.has(e.id));

      const realRecoveredIds = new Set<string>();
      if (recoveredCandidates.length > 0) {
        const fiveMinAgo = new Date(now - 5 * 60_000).toISOString();
        const last24h = new Date(now - 24 * 60 * 60_000).toISOString();
        const { data: offlineLogs } = await sb
          .from("whatsapp_alerts_log")
          .select("equipment_id")
          .eq("alert_type", "offline")
          .lt("created_at", fiveMinAgo)
          .gt("created_at", last24h)
          .in("equipment_id", recoveredCandidates.map((e) => e.id));
        for (const row of (offlineLogs ?? []) as Array<{ equipment_id: string | null }>) {
          if (row.equipment_id) realRecoveredIds.add(row.equipment_id);
        }
      }

      const recoveredEquips = recoveredCandidates.filter((e) => realRecoveredIds.has(e.id));

      // Flip status para 'online' sempre que a comunicação real voltou.
      // A proteção anti-flap acima suprime apenas o WhatsApp, não deve manter
      // o banco/página presos em OFFLINE quando a telemetria já voltou.
      const toFlipOnline = onlineEquips
        .filter((e) => e.communication_status !== "online")
        .map((e) => e.id);
      if (toFlipOnline.length > 0) {
        await sb.from("equipments").update({ communication_status: "online" }).in("id", toFlipOnline);
      }

      // Dispara back_online via whatsapp-alerts (dedup 30 min por destinatário).
      for (const e of recoveredEquips) {
        await dispatchWhatsApp({
          alert_type: "back_online",
          equipment_id: e.id,
          equipment_name: e.name,
          farm_id: e.farm_id,
          farm_name: farmNameMap.get(e.farm_id) ?? null,
        });
      }
    }


    // ─── #5 automatico_nao_obedecido ─────────────────────────────────────────
    const autoMaxTs = new Date(now - AUTO_CHECK_MIN_AGE_S * 1000).toISOString();
    const autoMinTs = new Date(now - AUTO_CHECK_MAX_AGE_S * 1000).toISOString();
    const { data: autoCmds } = await sb
      .from("automation_log")
      .select("id, farm_id, equipment_id, equipment_name, action, occurred_at")
      .eq("origin", "Automático").eq("result", "success")
      .in("action", ["Ligada", "Desligada"])
      .gte("occurred_at", autoMinTs).lte("occurred_at", autoMaxTs);

    const equipById = new Map(equips.map((e) => [e.id, e]));
    const autoRows: Array<Record<string, unknown>> = [];
    for (const log of (autoCmds ?? []) as AutoLog[]) {
      if (!log.equipment_id) continue;
      const eq = equipById.get(log.equipment_id);
      if (!eq) continue;
      const expected = log.action === "Ligada" ? "1" : "0";
      const real = bitAt(eq.last_outputs_state, eq.saida);
      if (real === null || real === expected) continue;
      autoRows.push({
        farm_id: log.farm_id, kind: "failure", severity: "critical", equipment_id: log.equipment_id,
        title: "Modo automático não obedecido",
        message: `${log.equipment_name} não obedeceu o automático — deveria estar ${expected === "1" ? "LIGADO" : "DESLIGADO"} (saída ${eq.saida})`,
        source: "automatico_nao_obedecido", source_ref: log.id,
      });
    }
    if (autoRows.length > 0) {
      const { count } = await sb.from("farm_notifications")
        .upsert(autoRows, { onConflict: "farm_id,source,source_ref", ignoreDuplicates: true, count: "exact" });
      summary.auto_violations = count ?? 0;
    }

    // ─── #6 falta_energia ────────────────────────────────────────────────────
    const blackoutStart = new Date(now - (BLACKOUT_WINDOW_S + 60) * 1000).toISOString();
    const blackoutEnd = new Date(now - 60 * 1000).toISOString();
    const recent = equips.filter(
      (e) => e.last_communication! >= blackoutStart && e.last_communication! <= blackoutEnd,
    );
    const byFarm = new Map<string, Equip[]>();
    for (const e of recent) {
      const arr = byFarm.get(e.farm_id) ?? [];
      arr.push(e); byFarm.set(e.farm_id, arr);
    }
    for (const [farmId, list] of byFarm) {
      if (list.length < BLACKOUT_MIN_EQUIPS) continue;
      const cooldownTs = new Date(now - BLACKOUT_COOLDOWN_MIN * 60_000).toISOString();
      const { data: existing } = await sb.from("farm_notifications")
        .select("id").eq("farm_id", farmId).eq("source", "falta_energia")
        .gte("created_at", cooldownTs).limit(1);
      if (existing && existing.length > 0) continue;
      const { error } = await sb.from("farm_notifications").insert({
        farm_id: farmId, kind: "failure", severity: "critical",
        title: "Possível falta de energia",
        message: `${list.length} equipamentos perderam comunicação simultaneamente`,
        source: "falta_energia", source_ref: crypto.randomUUID(),
      });
      if (!error) summary.blackouts++;
    }

    // ─── #7 safety_timer_fired ───────────────────────────────────────────────
    // Detecta bombas cujo safety_expired_at foi atualizado nos últimos 90s
    // E desired_running=false (agente cancelou o comando por falta de confirmação).
    // Dedup por source_ref = "<equipment_id>:<safety_expired_at_ms>" — naturalmente
    // único por evento, evita duplicação entre ticks.
    const safetyCutoff = new Date(now - 90 * 1000).toISOString();
    const { data: safetyEquips } = await sb
      .from("equipments")
      .select("id, farm_id, name, safety_expired_at, desired_running")
      .eq("desired_running", false)
      .not("safety_expired_at", "is", null)
      .gte("safety_expired_at", safetyCutoff);
    const safetyRows: Array<Record<string, unknown>> = [];
    for (const eq of (safetyEquips ?? []) as Array<{id:string; farm_id:string; name:string; safety_expired_at:string}>) {
      const ts = new Date(eq.safety_expired_at).getTime();
      const ref = await uuidFromString(`safety_timer_fired:${eq.id}:${ts}`);
      safetyRows.push({
        farm_id: eq.farm_id, kind: "failure", severity: "critical", equipment_id: eq.id,
        title: `${eq.name} — Falha de ativação`,
        message: "Bomba não confirmou comando em 60s. Verificar modo local/botoeira.",
        source: "safety_timer_fired", source_ref: ref,
      });
    }
    if (safetyRows.length > 0) {
      const { count } = await sb.from("farm_notifications")
        .upsert(safetyRows, { onConflict: "farm_id,source,source_ref", ignoreDuplicates: true, count: "exact" });
      summary.safety_timer = count ?? 0;
    }

    // ─── #8 peak_hour_start / peak_hour_end ──────────────────────────────────
    // 18h e 21h America/Sao_Paulo, exceto sábado/domingo e feriado nacional.
    // Dedup por source_ref UUID-determinístico baseado em (source, farm, dateKey).
    const nowDate = new Date(now);
    const hour = hourInSaoPaulo(nowDate);
    const dateKey = dateKeySaoPaulo(nowDate);
    const weekdaySP = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Sao_Paulo", weekday: "short",
    }).format(nowDate); // "Mon" .. "Sun"
    const isWeekend = weekdaySP === "Sat" || weekdaySP === "Sun";
    let isHoliday = false;
    if (!isWeekend && (hour === 18 || hour === 21)) {
      const { data: hol } = await sb
        .from("national_holidays")
        .select("holiday_date")
        .eq("holiday_date", dateKey)
        .limit(1);
      isHoliday = !!(hol && hol.length > 0);
    }
    const peakRows: Array<Record<string, unknown>> = [];
    if (!isWeekend && !isHoliday && (hour === 18 || hour === 21)) {
      const source = hour === 18 ? "peak_hour_start" : "peak_hour_end";
      const title = hour === 18
        ? "Horário de ponta iniciado (18h)"
        : "Horário de ponta encerrado (21h)";
      const message = hour === 18
        ? "Bombas ligadas neste período consomem energia na tarifa de ponta."
        : "Tarifa de energia voltou ao normal.";
      const { data: farmRows } = await sb.from("farms").select("id");
      for (const f of (farmRows ?? []) as Array<{id:string}>) {
        const ref = await uuidFromString(`${source}:${f.id}:${dateKey}`);
        peakRows.push({
          farm_id: f.id, kind: "system", severity: "info",
          title, message, source, source_ref: ref,
        });
      }
    }
    if (peakRows.length > 0) {
      const { count } = await sb.from("farm_notifications")
        .upsert(peakRows, { onConflict: "farm_id,source,source_ref", ignoreDuplicates: true, count: "exact" });
      summary.peak_events = count ?? 0;
    }

    // ─── #9 ota_applied ──────────────────────────────────────────────────────
    const otaCutoff = new Date(now - OTA_WINDOW_MIN * 60_000).toISOString();
    const { data: otaRows } = await sb
      .from("agent_update_history")
      .select("id, farm_id, from_version, to_version, status, created_at")
      .gte("created_at", otaCutoff)
      .eq("status", "success");
    const otaInserts: Array<Record<string, unknown>> = [];
    for (const o of (otaRows ?? []) as Array<{id:string; farm_id:string; from_version:string|null; to_version:string|null}>) {
      otaInserts.push({
        farm_id: o.farm_id, kind: "system", severity: "info",
        title: "Atualização do agente aplicada",
        message: `📦 Versão ${o.to_version ?? "?"} instalada com sucesso${o.from_version ? ` (vinda de ${o.from_version})` : ""}.`,
        source: "ota_applied", source_ref: o.id,
      });
    }
    if (otaInserts.length > 0) {
      const { count } = await sb.from("farm_notifications")
        .upsert(otaInserts, { onConflict: "farm_id,source,source_ref", ignoreDuplicates: true, count: "exact" });
      summary.ota_events = count ?? 0;
    }

    // ─── #10 bridge_offline / bridge_recovered ───────────────────────────────
    // Detecta Electron (agente local) sem heartbeat há > 2 min e dispara alerta
    // WhatsApp imediato + notificação no sino. Quando volta a bater heartbeat e
    // havia alerta aberto, marca resolvido e dispara bridge_recovered.
    // Dedup WhatsApp é feito por whatsapp-alerts (whatsapp_alerts_log).
    const BRIDGE_TIMEOUT_MIN = 2;
    const bridgeCutoffTs = new Date(now - BRIDGE_TIMEOUT_MIN * 60_000).toISOString();
    const { data: bridges } = await sb
      .from("bridge_heartbeat")
      .select("farm_id, bridge_name, last_heartbeat_at")
      .not("last_heartbeat_at", "is", null);

    const brRows = (bridges ?? []) as Array<{ farm_id: string; bridge_name: string; last_heartbeat_at: string }>;
    if (brRows.length > 0) {
      const brFarmIds = Array.from(new Set(brRows.map((b) => b.farm_id)));
      const brFarmMap = new Map<string, string>();
      const { data: brFarms } = await sb.from("farms").select("id, name").in("id", brFarmIds);
      for (const f of (brFarms ?? []) as Array<{ id: string; name: string }>) brFarmMap.set(f.id, f.name);

      // Alertas de bridge abertos (não-resolvidos), source_ref = "<farm_id>:<bridge_name>"
      const { data: openBridgeAlerts } = await sb
        .from("farm_notifications")
        .select("source_ref")
        .eq("source", "bridge_offline")
        .is("resolved_at", null)
        .in("farm_id", brFarmIds);
      const openBridgeSet = new Set((openBridgeAlerts ?? []).map((r: { source_ref: string }) => r.source_ref));

      for (const b of brRows) {
        const ref = `${b.farm_id}:${b.bridge_name || "main"}`;
        const isOffline = b.last_heartbeat_at < bridgeCutoffTs;
        const hasOpen = openBridgeSet.has(ref);
        const minsSince = (now - new Date(b.last_heartbeat_at).getTime()) / 60_000;

        if (isOffline && !hasOpen) {
          const uuidRef = await uuidFromString(`bridge_offline:${ref}:${b.last_heartbeat_at}`);
          const { error: insErr } = await sb.from("farm_notifications").insert({
            farm_id: b.farm_id,
            kind: "failure",
            severity: "critical",
            title: "Sistema OFFLINE — sem comunicação com o agente",
            message: `Electron sem heartbeat há ${Math.round(minsSince)} min. Bombas não podem ser controladas remotamente.`,
            source: "bridge_offline",
            source_ref: ref,
          });
          if (!insErr) {
            summary.bridge_offline_events++;
            // Marca status na tabela de heartbeat para consistência da UI
            await sb.from("bridge_heartbeat")
              .update({ status: "offline" })
              .eq("farm_id", b.farm_id)
              .eq("bridge_name", b.bridge_name);
            await dispatchWhatsApp({
              alert_type: "bridge_offline",
              farm_id: b.farm_id,
              farm_name: brFarmMap.get(b.farm_id) ?? null,
              last_heartbeat_at: b.last_heartbeat_at,
            });
          }
          // uuidRef intentionally unused — source_ref = ref é natural e único.
          void uuidRef;
        } else if (!isOffline && hasOpen) {
          // Voltou a comunicar — resolve alerta e dispara recovered
          const { data: prior } = await sb
            .from("farm_notifications")
            .select("id, created_at")
            .eq("source", "bridge_offline")
            .eq("source_ref", ref)
            .is("resolved_at", null)
            .order("created_at", { ascending: false })
            .limit(1);
          const priorRow = (prior ?? [])[0] as { id: string; created_at: string } | undefined;
          const offlineMinutes = priorRow
            ? Math.round((now - new Date(priorRow.created_at).getTime()) / 60_000)
            : null;

          await sb.from("farm_notifications")
            .update({ resolved_at: new Date().toISOString() })
            .eq("source", "bridge_offline")
            .eq("source_ref", ref)
            .is("resolved_at", null);
          summary.bridge_recovered_events++;
          await dispatchWhatsApp({
            alert_type: "bridge_recovered",
            farm_id: b.farm_id,
            farm_name: brFarmMap.get(b.farm_id) ?? null,
            recovered_at: new Date(now).toISOString(),
            minutes_offline: offlineMinutes ?? Math.round(minsSince),
          });
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, ...summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[critical-alerts-tick] error", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
