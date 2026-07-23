import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GRAPH_VERSION = "v21.0";

// [DIAG-SEMEAR] Log cirúrgico temporário — investigar silêncio de alertas.
// Remover após diagnóstico concluído.
const SEMEAR_FARM_ID = "0b1d53df-6d5c-4674-8517-9299aac3ec18";
const isSemear = (fid?: string | null) => fid === SEMEAR_FARM_ID;
const semearLog = (...args: unknown[]) => console.log("[DIAG-SEMEAR]", ...args);

function fmtTsBR(d?: Date): string {
  return (d ?? new Date()).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function getBRTMinutes(d = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function isWeekendBRT(d = new Date()): boolean {
  // Timezone explícita: o runtime pode estar em UTC e virar segunda enquanto ainda é domingo no BRT.
  const brtString = d.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
  const brtNow = new Date(brtString);
  const serverDay = d.getDay();
  const dayBRT = brtNow.getDay(); // 0=domingo, 6=sábado
  console.log("[peak-hours] weekend-check", {
    server_iso: d.toISOString(),
    server_day: serverDay,
    brt_local: brtString,
    brt_day: dayBRT,
  });
  return dayBRT === 0 || dayBRT === 6;
}

function isPeakWindowBRT(d = new Date()): boolean {
  if (isWeekendBRT(d)) return false; // Final de semana = demanda livre
  const minutes = getBRTMinutes(d);
  return minutes >= 18 * 60 && minutes < 21 * 60;
}

function sanitizeOutgoingBody(s: string): string {
  if (!s) return s;
  let out = s;
  out = out.replace(/(^|\n)[^\n]*aten[çc][ãa]o!?\s*foi\s+detectado[^\n]*(?=\n|$)/gi, "$1");
  out = out.replace(/[^.\n]*aten[çc][ãa]o!?\s*foi\s+detectado[^.\n]*\.?/gi, "");
  out = out.replace(/(^|\n)[^\n]*registrado\s+em:[^\n]*(?=\n|$)/gi, "$1");
  out = out.replace(/[^.\n]*registrado\s+em:[^.\n]*\.?/gi, "");
  out = out.replace(/[^.\n]*verifique\s+o\s+equipamento\s+localmente[^.\n]*\.?/gi, "");
  out = out.replace(/[^.\n]*entre\s+em\s+contato\s+com\s+o\s+administrador[^.\n]*\.?/gi, "");
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

function normalizePhone(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("55") ? digits : `55${digits}`;
}

function metaErrorCode(err: unknown): number | null {
  const e = err as any;
  const code = e?.code ?? e?.error?.code;
  const n = Number(code);
  if (!Number.isFinite(n) && err != null) {
    const match = JSON.stringify(err).match(/131047/);
    if (match) return 131047;
  }
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


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: any = {};
  try { body = await req.json(); } catch { /* noop */ }
  let { alert_type, equipment_id, equipment_name, new_running, farm_id, farm_name, last_heartbeat_at, recovered_at, minutes_offline, force } = body;
  // Agente envia `kind` (ex: agent_tx_stalled, agent_clone_detected). Normaliza para alert_type.
  if (!alert_type && typeof body?.kind === "string") {
    alert_type = body.kind;
  }

  if (isSemear(farm_id)) {
    semearLog("INBOUND alert", { alert_type, equipment_id, equipment_name, new_running, farm_id, farm_name, force });
  }

  if (alert_type === "peak_hours" && isWeekendBRT()) {
    console.log("[peak-hours] Weekend BRT, skipping");
    return new Response(JSON.stringify({ status: "weekend_brt_skipped" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (alert_type === "peak_hours" && !isPeakWindowBRT()) {
    console.warn("[whatsapp-alerts] peak_hours blocked — outside BRT window", { brtMinutes: getBRTMinutes() });
    return new Response(JSON.stringify({ status: "outside_peak_window_brt" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (alert_type === "peak_hours" && body?.dry_run === true) {
    console.log("[peak-hours] dry-run accepted after BRT guards", { brtMinutes: getBRTMinutes() });
    return new Response(JSON.stringify({ status: "dry_run_peak_hours_ok", brtMinutes: getBRTMinutes() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Alertas de segurança CRÍTICOS — sempre enviam, ignoram qualquer toggle/filtro por fazenda.
  // Regra absoluta: bombas podem queimar, reservatórios podem transbordar — sem opt-out.
  const CRITICAL_ALERT_TYPES = new Set([
    "bridge_warning", "bridge_offline", "bridge_recovered",
    "agent_tx_stalled", "agent_clone_detected", "agent_offline",
    "offline", "back_online",
    "safety_timer", "command_unconfirmed", "tx_queue_stalled",
  ]);
  const isBridgeAlert = CRITICAL_ALERT_TYPES.has(String(alert_type));

  // Equipamento em manutenção é silencioso: não envia LIGOU/DESLIGOU/OFFLINE/VOLTOU.
  if (equipment_id && ["local_change", "offline", "back_online"].includes(String(alert_type))) {
    const { data: eqMaint } = await supabase
      .from("equipments")
      .select("maintenance_mode")
      .eq("id", equipment_id)
      .maybeSingle();
    if ((eqMaint as any)?.maintenance_mode === true) {
      return new Response(JSON.stringify({ status: "ignored_maintenance_mode" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Master toggle NÃO se aplica a alertas críticos de segurança (sempre passam).
  // Para alertas não-críticos: default = habilitado (opt-out), nunca opt-in.
  if (!isBridgeAlert && !force) {
    let settings: any = null;
    if (farm_id) {
      const { data } = await supabase
        .from("whatsapp_alert_settings")
        .select("*")
        .eq("farm_id", farm_id)
        .maybeSingle();
      settings = data ?? null;
    }

    if (settings) {
      if (settings.alerts_enabled === false) {
        return new Response(JSON.stringify({ status: "alerts_disabled" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (alert_type === "local_change" && settings.alert_local_change_enabled === false) {
        return new Response(JSON.stringify({ status: "type_disabled" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (alert_type === "peak_hours" && settings.alert_peak_hours_enabled === false) {
        return new Response(JSON.stringify({ status: "type_disabled" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }
  }



  const { data: config } = await supabase
    .from("whatsapp_config")
    .select("api_token, bot_number, phone_number_id")
    .limit(1)
    .maybeSingle();

  if (!config?.api_token || !config?.phone_number_id) {
    return new Response(JSON.stringify({ error: "no_token" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Load ALL active operators, then filter to: operators of this farm + super_admins (across farms).
  // Matches the recipient logic used by whatsapp-automation-notify (local_change path) so back_online,
  // offline and all other alerts reach the same audience.
  const { data: allOperators } = await supabase
    .from("whatsapp_operators")
    .select("phone, name, role, notification_preference, receive_alerts, farm_id, last_message_at, is_active")
    .eq("is_active", true);

  // Fallback admins globais (contato@renovelectronics / Paulo Gabriel) — via env, opcional.
  // Se a fazenda não tem NENHUM operador com telefone, alertas críticos vão para os admins globais
  // e ficam registrados como "não entregues ao responsável local" no whatsapp_alerts_log.
  const adminFallbackPhones = String(Deno.env.get("WHATSAPP_ADMIN_FALLBACK_PHONES") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const farmOperators = (allOperators ?? []).filter((o: any) => {
    if (!o.phone) return false;
    if (o.role === "super_admin") return true;
    if (!farm_id) return true;
    return o.farm_id === farm_id;
  });

  let operators = farmOperators;
  let usedGlobalFallback = false;

  if ((!operators || !operators.length) && (isBridgeAlert || CRITICAL_ALERT_TYPES.has(String(alert_type)))) {
    // Alerta crítico sem responsável local — cai para admins globais.
    const fallback: any[] = [];
    // 1) super_admins (mesmo sem farm_id vinculado)
    const superAdmins = (allOperators ?? []).filter((o: any) => o.phone && o.role === "super_admin");
    fallback.push(...superAdmins);
    // 2) telefones hardcoded via env (contato@renovelectronics.com.br / Paulo Gabriel)
    for (const phone of adminFallbackPhones) {
      if (!fallback.some((o) => normalizePhone(o.phone) === normalizePhone(phone))) {
        fallback.push({ phone, name: "Admin Renov (fallback)", role: "super_admin", notification_preference: "default", receive_alerts: true, farm_id: null });
      }
    }
    if (fallback.length) {
      operators = fallback;
      usedGlobalFallback = true;
      console.warn("[whatsapp-alerts] using ADMIN GLOBAL FALLBACK — farm has no local operator", { farm_id, alert_type, recipients: fallback.length });
      // Audit: registrar não-entrega ao responsável local.
      try {
        await supabase.from("whatsapp_alerts_log").insert({
          alert_type: `undelivered_local:${alert_type}`,
          equipment_id: equipment_id || "00000000-0000-0000-0000-000000000000",
          equipment_name: equipment_name ?? `no_local_operator:${farm_id ?? "unknown"}`,
          message_sent: `[FALLBACK ADMIN GLOBAL] Fazenda ${farm_id ?? "—"} sem operador com telefone cadastrado.`,
        });
      } catch (_) { /* ignore */ }
    }
  }




  if (!operators?.length) {
    // Log crítico: alerta de segurança sem nenhum destinatário (nem local, nem admin global).
    if (isBridgeAlert || CRITICAL_ALERT_TYPES.has(String(alert_type))) {
      console.error("[whatsapp-alerts] CRITICAL ALERT UNDELIVERED — no operators and no admin fallback", { farm_id, alert_type, equipment_id });
      try {
        await supabase.from("whatsapp_alerts_log").insert({
          alert_type: `undelivered_total:${alert_type}`,
          equipment_id: equipment_id || "00000000-0000-0000-0000-000000000000",
          equipment_name: equipment_name ?? `no_recipients:${farm_id ?? "unknown"}`,
          message_sent: `[NÃO ENTREGUE] Fazenda ${farm_id ?? "—"} — alerta ${alert_type} sem destinatários (sem operador e sem fallback admin).`,
        });
      } catch (_) { /* ignore */ }
    }
    return new Response(JSON.stringify({ status: "no_operators", critical_undelivered: isBridgeAlert }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }


  // Build the free-text version + template params per alert type.
  let freeText = "";
  const tsLine = fmtTsBR();
  // Default template params shape: [equipName, farmName, description, timestamp]
  let templateName = "alerta_equipamento";
  let templateParams: string[] = [];
  let farmLabel = farm_name || "—";
  const eqLabel = equipment_name || "Equipamento";

  // Fallback: look up farm name if not provided
  if (farmLabel === "—" && farm_id) {
    const { data: f } = await supabase.from("farms").select("name").eq("id", farm_id).maybeSingle();
    if (f?.name) farmLabel = f.name as string;
  }

  if (alert_type === "local_change") {
    const acao = new_running ? "LIGOU" : "DESLIGOU";
    const emoji = new_running ? "🔔" : "⚠️";
    freeText = `${emoji} ${eqLabel} ${acao} — Local (Painel do Poço)\n${farmLine(farmLabel)}\n${tsLine}`;
    templateParams = [farmDisplayName(farmLabel), eqLabel, `Acionamento local — ${acao}`, `${acao} pelo painel do poço em ${tsLine}`];
  } else if (alert_type === "offline") {
    freeText = `⚠️ ${eqLabel} está OFFLINE\n${farmLine(farmLabel)}\n${tsLine}`;
    templateParams = [farmDisplayName(farmLabel), eqLabel, "Equipamento OFFLINE", `Sem comunicação desde ${tsLine}`];
  } else if (alert_type === "back_online") {
    freeText = `✅ ${eqLabel} voltou ONLINE\n${farmLine(farmLabel)}\n${tsLine}`;
    templateParams = [farmDisplayName(farmLabel), eqLabel, "Equipamento ONLINE", `Comunicação restabelecida em ${tsLine}`];
  } else if (alert_type === "peak_hours") {
    // Group running equipment per farm and send ONE clean message to each farm's operators.
    const { data: runningEqs } = await supabase
      .from("equipments")
      .select("id, name, farm_id, farms!inner(id, name)")
      .eq("desired_running", true)
      .eq("communication_status", "online")
      .eq("active", true)
      .in("type", ["poco", "bombeamento"]);

    if (!runningEqs?.length) {
      return new Response(JSON.stringify({ status: "nothing_running" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Group
    const byFarm = new Map<string, { name: string; equipments: string[] }>();
    for (const eq of runningEqs as any[]) {
      const fid = eq.farm_id as string;
      const fname = (eq.farms?.name as string) || "Fazenda";
      if (!byFarm.has(fid)) byFarm.set(fid, { name: fname, equipments: [] });
      byFarm.get(fid)!.equipments.push(eq.name);
    }

    // Load all active operators with notification preferences in one query.
    const { data: allOps } = await supabase
      .from("whatsapp_operators")
      .select("phone, name, role, notification_preference, receive_alerts, farm_id, last_message_at")
      .eq("is_active", true);

    const { data: cfg } = await supabase
      .from("whatsapp_config")
      .select("api_token, phone_number_id")
      .limit(1)
      .maybeSingle();

    if (!cfg?.api_token || !cfg?.phone_number_id) {
      return new Response(JSON.stringify({ error: "no_token" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    async function sendTextDirect(to: string, text: string): Promise<{ id: string | null; ok: boolean; error?: any }> {
      try {
        const toDigits = normalizePhone(to);
        const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${cfg!.phone_number_id}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg!.api_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to: toDigits, type: "text", text: { body: text } }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || (j as any)?.error) {
          console.error("[peak_hours] send failed", to, JSON.stringify((j as any)?.error || j));
          return { id: null, ok: false, error: (j as any)?.error || j };
        }
        return { id: (j as any)?.messages?.[0]?.id ?? null, ok: true };
      } catch (e) { console.error("[peak_hours] send err", to, e); return { id: null, ok: false, error: e }; }
    }

    async function sendTemplateDirect(to: string, cleanText: string): Promise<{ id: string | null; ok: boolean; error?: any }> {
      try {
        const toDigits = normalizePhone(to);
        const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${cfg!.phone_number_id}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg!.api_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp", to: toDigits, type: "template",
            template: { name: "alerta_equipamento", language: { code: "pt_BR" }, components: [{
              type: "body", parameters: [{ type: "text", text: cleanText }],
            }] },
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || (j as any)?.error) {
          console.error("[peak_hours] template fallback failed", to, JSON.stringify((j as any)?.error || j));
          return { id: null, ok: false, error: (j as any)?.error || j };
        }
        return { id: (j as any)?.messages?.[0]?.id ?? null, ok: true };
      } catch (e) { console.error("[peak_hours] template fallback err", to, e); return { id: null, ok: false, error: e }; }
    }

    let totalSent = 0;
    for (const [fid, info] of byFarm.entries()) {
      const eqLines = info.equipments.map((n) => `• ${n}`).join("\n");
      const msg = `⚡ HORÁRIO DE PONTA (18:00-21:00)\n\n${farmLine(info.name)} — ${info.equipments.length} equipamento${info.equipments.length === 1 ? "" : "s"} ligado${info.equipments.length === 1 ? "" : "s"}:\n${eqLines}\n\nConsidere desligar para evitar tarifa elevada.`;

      const farmOps = (allOps as any[] | null ?? []).filter((o) => o.phone && (o.farm_id === fid || o.role === "super_admin"));
      for (const op of farmOps) {
        const pref = (op.notification_preference || "default") as string;
        if (op.role !== "super_admin") {
          if (pref === "mute") continue;
          if (op.receive_alerts === false) continue;
        }
        const textResult = await sendTextDirect(op.phone, msg);
        const templateFallback = !textResult.ok;
        const templateResult = templateFallback ? await sendTemplateDirect(op.phone, msg) : null;
        const mid = textResult.ok ? textResult.id : templateResult?.id ?? null;
        const usedMode = textResult.ok ? "text" : templateFallback ? "template" : "text_failed";
        if (!textResult.ok && !templateResult?.ok) continue;
        totalSent++;
        try {
          await supabase.from("whatsapp_message_log").insert({
            direction: "outgoing",
            phone: op.phone,
            operator_name: op.name ?? null,
            farm_id: fid,
            message_type: usedMode === "template" ? "template" : "alert",
            message_body: usedMode === "template" ? "[template:alerta_equipamento]" : msg,
            message_id: mid,
            metadata: { alert_type: "peak_hours", farm_id: fid, template: usedMode === "template" ? "alerta_equipamento" : undefined, params: usedMode === "template" ? [msg] : undefined },
            group_id: null,
          });
        } catch (_) { /* ignore */ }
      }

      await supabase.from("whatsapp_alerts_log").insert({
        alert_type: "peak_hours",
        equipment_id: "00000000-0000-0000-0000-000000000000",
        equipment_name: `peak:${info.name}`,
        message_sent: msg,
      });
    }

    return new Response(JSON.stringify({ status: "sent", farms: byFarm.size, recipients: totalSent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } else if (alert_type === "bridge_warning") {
    const hb = last_heartbeat_at ? new Date(last_heartbeat_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";
    freeText = `⚠️ *ALERTA: Bridge sem comunicação há 2 minutos*\n\nFazenda: ${farmLabel}\nÚltimo heartbeat: ${hb}\n\nAs bombas desligarão automaticamente em 13 minutos se não restabelecido.`;
    templateParams = [farmDisplayName(farmLabel), "Bridge RS-232", "Bridge sem comunicação (2 min)", `Último heartbeat: ${hb}. Desligamento automático em 13 min.`];
  } else if (alert_type === "bridge_offline") {
    const hb = last_heartbeat_at ? new Date(last_heartbeat_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";
    freeText = `🚨 *CRÍTICO: Bridge OFFLINE há 5 minutos*\n\nFazenda: ${farmLabel}\nÚltimo heartbeat: ${hb}`;
    templateParams = [farmDisplayName(farmLabel), "Bridge RS-232", "Bridge OFFLINE (crítico)", `Sem heartbeat há 5 min. Último: ${hb}`];
  } else if (alert_type === "bridge_recovered") {
    const at = (recovered_at ? new Date(recovered_at) : new Date()).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
    freeText = `✅ *Bridge ONLINE novamente*\n\nFazenda: ${farmLabel}\nRestabelecido às: ${at}\nTempo offline: ${minutes_offline ?? "—"} minutos`;
    templateParams = [farmDisplayName(farmLabel), "Bridge RS-232", "Bridge restabelecido", `Online às ${at} (offline por ${minutes_offline ?? "—"} min)`];
  } else if (alert_type === "level") {
    const reservoirName = body.reservoir_name || equipment_name || "Reservatório";
    const levelPercent = String(body.level_percent ?? "—");
    const statusText = body.status_text || "Verificar";
    freeText = `🚨 *Alerta de nível — ${reservoirName}*\n\nNível: ${levelPercent}%\nStatus: ${statusText}\nFazenda: ${farmLabel}`;
    templateName = "alerta_nivel";
    templateParams = [reservoirName, levelPercent, farmLabel, statusText];
  } else if (alert_type === "agent_tx_stalled") {
    const silenceSec = Number(body?.silence_seconds ?? 0);
    const silenceLabel = silenceSec >= 60
      ? `${Math.round(silenceSec / 60)} min`
      : `${silenceSec}s`;
    const detail = typeof body?.message === "string" && body.message.trim()
      ? body.message.trim()
      : `Agente sem transmitir há ${silenceLabel}`;
    freeText = `🚨 *CRÍTICO: Agente sem TX há ${silenceLabel}*\n\nFazenda: ${farmLabel}\n${detail}\n${tsLine}`;
    templateParams = [farmDisplayName(farmLabel), "Agente RS-232", `TX travada há ${silenceLabel}`, detail];
  } else if (alert_type === "agent_clone_detected") {
    const changed = Array.isArray(body?.changed_components) ? body.changed_components.join(", ") : "";
    const detail = typeof body?.message === "string" && body.message.trim()
      ? body.message.trim()
      : "Hardware nao autorizado tentou operar o agente desta fazenda.";
    freeText = `🚨 *SEGURANÇA: Clone de agente detectado*\n\nFazenda: ${farmLabel}\n${detail}${changed ? `\nComponentes divergentes: ${changed}` : ""}\n${tsLine}`;
    templateParams = [farmDisplayName(farmLabel), "Agente (anti-clone)", "Clone detectado", `${detail}${changed ? ` (${changed})` : ""}`];
  }



  if (!freeText) {
    return new Response(JSON.stringify({ status: "no_message" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // ── Órfão-guard: só envie "voltou ONLINE" se um alerta OFFLINE foi enviado antes ──
  // Regra: recovery alerts (back_online / bridge_recovered) exigem alerta de queda prévio.
  // Isso evita "voltou online" para micro-dropouts que nunca dispararam o alerta OFFLINE
  // (filtrados por debounce), causando confusão para o produtor.
  if (alert_type === "back_online" && equipment_id) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: priorOffline, error: priorErr } = await supabase
      .from("whatsapp_alerts_log")
      .select("id, created_at")
      .eq("equipment_id", equipment_id)
      .eq("alert_type", "offline")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1);
    if (priorErr) {
      console.error("[whatsapp-alerts] back_online orphan check failed", { equipment_id, error: priorErr });
    } else if (!priorOffline?.length) {
      console.warn("[whatsapp-alerts] back_online suppressed — no prior offline alert", { equipment_id });
      return new Response(JSON.stringify({ status: "orphan_suppressed_no_prior_offline" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  if (alert_type === "bridge_recovered") {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let q = supabase
      .from("whatsapp_alerts_log")
      .select("id, alert_type, created_at, message_sent")
      .in("alert_type", ["bridge_offline", "bridge_warning"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5);
    const { data: priorBridge, error: pbErr } = await q;
    if (pbErr) {
      console.error("[whatsapp-alerts] bridge_recovered orphan check failed", { farm_id, error: pbErr });
    } else {
      // Filtra por farm quando possível (log de bridge não tem equipment_id — usa farm_label no message_sent).
      const relevant = (priorBridge ?? []).filter((r: any) => {
        if (!farm_id && !farmLabel) return true;
        const m = String(r.message_sent || "");
        return farmLabel && farmLabel !== "—" ? m.includes(farmLabel) : true;
      });
      if (!relevant.length) {
        console.warn("[whatsapp-alerts] bridge_recovered suppressed — no prior bridge_offline/warning", { farm_id, farmLabel });
        return new Response(JSON.stringify({ status: "orphan_suppressed_no_prior_bridge_alert" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }
  }

  // Anti-spam: 30 min for local_change and other alerts
  // (state-aware: LIGOU vs DESLIGOU are different events), per (alert_type, equipment_id, state).
  const isLocalChange = alert_type === "local_change";
  const isOfflineLifecycle = alert_type === "offline" || alert_type === "back_online";
  if (equipment_id && isOfflineLifecycle) {
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: recentFlap, error: flapErr } = await supabase
      .from("whatsapp_alerts_log")
      .select("id, alert_type, created_at")
      .eq("equipment_id", equipment_id)
      .in("alert_type", ["offline", "back_online"])
      .gte("created_at", since)
      .limit(1);

    if (flapErr) {
      console.error("[whatsapp-alerts] offline/back_online flap check failed", { equipment_id, alert_type, error: flapErr });
    } else if (recentFlap?.length) {
      console.warn("[whatsapp-alerts] offline/back_online flap suppressed", { equipment_id, alert_type, recent: recentFlap[0] });
      return new Response(JSON.stringify({ status: "flap_suppressed_5min" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Dedup key suffix: distinguishes LIGOU/DESLIGOU at the claim + per-recipient layer.
  const dedupAlertType = isLocalChange ? `local_change_${new_running ? "on" : "off"}` : alert_type;
  if (equipment_id) {
    const windowMs = 30 * 60 * 1000;
    const since = new Date(Date.now() - windowMs).toISOString();
    let q = supabase
      .from("whatsapp_alerts_log")
      .select("id, message_sent")
      .eq("alert_type", alert_type)
      .eq("equipment_id", equipment_id)
      .gte("created_at", since)
      .limit(5);
    const { data: recent } = await q;
    const stateKeyword = isLocalChange ? (new_running ? "LIGOU" : "DESLIGOU") : null;
    const matched = (recent ?? []).some((r: any) =>
      stateKeyword ? String(r.message_sent || "").toUpperCase().includes(stateKeyword) : true
    );
    if (matched) {
      return new Response(JSON.stringify({ status: "already_sent" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }

  const phoneNumberId = config.phone_number_id;

  async function hasRecentIdenticalAlert(to: string): Promise<boolean> {
    if (!equipment_id || !alert_type || !to) return false;
    const windowMs = 30 * 60 * 1000;
    const since = new Date(Date.now() - windowMs).toISOString();
    // State-aware match: include new_running so LIGOU vs DESLIGOU are not deduped together.
    const matchMd: Record<string, unknown> = { alert_type, equipment_id };
    if (isLocalChange) matchMd.new_running = Boolean(new_running);
    const { data, error } = await supabase
      .from("whatsapp_message_log")
      .select("id")
      .eq("direction", "outgoing")
      .eq("phone", to)
      .contains("metadata", matchMd)
      .gte("created_at", since)
      .limit(1);

    if (error) {
      console.error("[whatsapp-alerts] dedup check failed", to, { alert_type, equipment_id, error });
      return false;
    }
    return Boolean(data?.length);
  }

  async function claimAlertSend(to: string): Promise<boolean> {
    if (!equipment_id || !alert_type || !to) return true;
    const windowSec = 30 * 60;
    const { data, error } = await supabase.rpc("claim_whatsapp_alert_send", {
      p_alert_type: dedupAlertType,
      p_equipment_id: equipment_id,
      p_phone: to,
      p_window_seconds: windowSec,
    });

    if (error) {
      console.error("[whatsapp-alerts] atomic claim failed", to, { alert_type: dedupAlertType, equipment_id, error });
      return false;
    }
    return data === true;
  }

  // Targets: super_admin always; others only if receive_alerts !== false AND not muted.
  type Op = { phone: string; name?: string | null; role?: string | null; notification_preference?: string | null; receive_alerts?: boolean | null; farm_id?: string | null; last_message_at?: string | null };
  const targets: Op[] = [];
  for (const o of (operators as Op[])) {
    if (!o.phone) continue;
    if (o.role === "super_admin") { targets.push(o); continue; }
    const pref = (o.notification_preference || "default") as string;
    if (pref === "mute") continue;
    if (o.receive_alerts === false) continue;
    targets.push(o);
  }

  if (targets.length === 0) {
    return new Response(JSON.stringify({ status: "no_targets" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  async function sendText(to: string, body: string): Promise<{ id: string | null; ok: boolean; error?: any }> {
    try {
      const cleaned = sanitizeOutgoingBody(body);
      const toDigits = normalizePhone(to);
      const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.api_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: toDigits, type: "text", text: { body: cleaned } }),
      });
      const j = await r.json().catch(() => ({}));
      console.log("[whatsapp-alerts] META text response", JSON.stringify({ farm_id, to, http_status: r.status, ok: r.ok, message_id: (j as any)?.messages?.[0]?.id ?? null, message_status: (j as any)?.messages?.[0]?.message_status ?? null, error: (j as any)?.error ?? null }));
      if (isSemear(farm_id)) {
        semearLog("META text response", { to, http_status: r.status, ok: r.ok, message_id: (j as any)?.messages?.[0]?.id ?? null, message_status: (j as any)?.messages?.[0]?.message_status ?? null, contacts: (j as any)?.contacts ?? null, error: (j as any)?.error ?? null });
      }
      if (!r.ok || (j as any)?.error) {
        console.error("[whatsapp-alerts] text send failed", to, JSON.stringify((j as any)?.error || j));
        return { id: null, ok: false, error: (j as any)?.error || j };
      }
      return { id: (j as any)?.messages?.[0]?.id ?? null, ok: true };
    } catch (e) {
      console.error("[whatsapp-alerts] send err", to, e);
      return { id: null, ok: false, error: e };
    }
  }

  async function sendTpl(to: string, name: string, params: string[]): Promise<{ id: string | null; ok: boolean; error?: any }> {
    try {
      const toDigits = normalizePhone(to);
      const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.api_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp", to: toDigits, type: "template",
          template: { name, language: { code: "pt_BR" }, components: [{
            type: "body", parameters: params.map((p) => ({ type: "text", text: p })),
          }] },
        }),
      });
      const j = await r.json().catch(() => ({}));
      console.log("[whatsapp-alerts] META template response", JSON.stringify({ farm_id, to, template: name, http_status: r.status, ok: r.ok, message_id: (j as any)?.messages?.[0]?.id ?? null, message_status: (j as any)?.messages?.[0]?.message_status ?? null, error: (j as any)?.error ?? null }));
      if (isSemear(farm_id)) {
        semearLog("META template response", { to, template: name, http_status: r.status, ok: r.ok, message_id: (j as any)?.messages?.[0]?.id ?? null, message_status: (j as any)?.messages?.[0]?.message_status ?? null, error: (j as any)?.error ?? null });
      }
      if (!r.ok || (j as any)?.error) {
        console.error(`[whatsapp-alerts] template ${name} send failed`, to, JSON.stringify((j as any)?.error || j));
        return { id: null, ok: false, error: (j as any)?.error || j };
      } else {
        console.log(`[whatsapp-alerts] template ${name} sent to ${to}`);
      }
      return { id: (j as any)?.messages?.[0]?.id ?? null, ok: true };
    } catch (e) {
      console.error("[whatsapp-alerts] template err", to, e);
      return { id: null, ok: false, error: e };
    }
  }

  let sentCount = 0;
  let skippedDuplicates = 0;
  for (const op of targets) {
    if (await hasRecentIdenticalAlert(op.phone)) {
      skippedDuplicates++;
      console.log("[whatsapp-alerts] duplicate suppressed", { alert_type, equipment_id, phone: op.phone });
      continue;
    }
    if (!(await claimAlertSend(op.phone))) {
      skippedDuplicates++;
      console.log("[whatsapp-alerts] simultaneous duplicate suppressed", { alert_type, equipment_id, phone: op.phone });
      continue;
    }

    let metaMessageId: string | null = null;
    let mode: "template" | "text" | "failed" = "template";
    const paramsForTpl = templateParams.length ? templateParams : [freeText];
    const tplResult = await sendTpl(op.phone, templateName, paramsForTpl);
    let textResult: { id: string | null; ok: boolean; error?: any } | null = null;
    if (tplResult.ok) {
      metaMessageId = tplResult.id;
    } else {
      // Fallback: se o template falhar (ex: template não encontrado / parâmetros inválidos),
      // tenta texto livre como último recurso. Só entrega se a janela de 24h estiver aberta.
      console.warn("[whatsapp-alerts] template failed, falling back to text", op.phone, { alert_type, equipment_id, tpl_error_code: metaErrorCode(tplResult.error) });
      mode = "text";
      textResult = await sendText(op.phone, freeText);
      metaMessageId = textResult.id;
      if (!textResult.ok) mode = "failed";
    }

    if (mode === "failed") {
      console.error("[whatsapp-alerts] smart sender failed", op.phone, { alert_type, equipment_id, tpl_error_code: metaErrorCode(tplResult.error), text_error_code: metaErrorCode(textResult?.error) });
      continue;
    }
    sentCount++;

    try {
      await supabase.from("whatsapp_message_log").insert({
        direction: "outgoing",
        phone: op.phone,
        operator_name: op.name ?? null,
        farm_id: op.farm_id ?? farm_id ?? null,
        message_type: mode === "template" ? "template" : "alert",
        message_body: mode === "template" ? `[template:${templateName}]` : freeText,
        message_id: metaMessageId,
        metadata: { alert_type, equipment_id: equipment_id ?? null, equipment_name: equipment_name ?? null, new_running: isLocalChange ? Boolean(new_running) : undefined, template: mode === "template" ? templateName : undefined, params: mode === "template" ? templateParams : undefined },
        group_id: null,
      });
    } catch (e) {
      console.error("[whatsapp-alerts] log failed", op.phone, e);
    }
  }

  if (sentCount === 0) {
    if (skippedDuplicates > 0) {
      return new Response(JSON.stringify({ status: "duplicates_suppressed", recipients: 0, skipped_duplicates: skippedDuplicates, targets: targets.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ status: "send_failed", recipients: 0, targets: targets.length }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  await supabase.from("whatsapp_alerts_log").insert({
    alert_type,
    equipment_id: equipment_id || "00000000-0000-0000-0000-000000000000",
    equipment_name,
    message_sent: freeText,
  });


  return new Response(JSON.stringify({ status: "sent", recipients: sentCount, skipped_duplicates: skippedDuplicates, targets: targets.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
