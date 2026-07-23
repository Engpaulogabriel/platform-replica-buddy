// WhatsApp Business webhook (Meta) — verifica token, ingere comandos e responde.
import { createClient } from "npm:@supabase/supabase-js@2";
import { classifyMessage, classifyPendingResponse, type ClassificationResult } from "./ai-classifier.ts";
import { classifyAction, isGeminiAvailable, getClassifierStatus } from "./action-classifier.ts";
import { routeWithAi, type RouterContext, type RouterResult } from "./ai-router.ts";

// WhatsApp Business Cloud API NÃO suporta grupos — toda conversa é 1:1.
// Helpers mantidos como stubs (sempre null/false) para compatibilidade interna.
function currentGroupId(): string | null { return null; }
function isInGroup(): boolean { return false; }

// Dedup de greetings/unknown (in-memory, per worker). Evita respostas duplicadas
// quando o mesmo operador envia a mesma mensagem em janela curta (<60s).
const recentGreetingDedup = new Map<string, number>();
const recentOutgoingAttempt = new Map<string, number>();
const recentOutgoingSuccess = new Map<string, number>();

// ─── Rate limiting (in-memory, per isolate) ────────────────────────────────
// Nota: cada instância da Edge Function tem seu próprio Map; sob autoscale
// os contadores são por worker (não globais). Suficiente para conter abuso
// de um número, não para SLA rígido.
type RateBucket = { count: number; windowStart: number; warned?: boolean };
const rlMinute = new Map<string, RateBucket>();   // 10/min → drop silencioso
const rlHour = new Map<string, RateBucket>();     // 30/h  → responde 1x e ignora
const rlDay = new Map<string, RateBucket>();      // 150/d → bloqueia + notifica super_admin
const rlDayNotified = new Map<string, number>();  // dedupe de notificação ao super_admin
const lastMessages = new Map<string, string[]>(); // últimas mensagens por número (dedup textual)

// Dedup por message_id da Meta (wamid). A Meta reenvia webhooks se não receber
// 200 rápido — sem isso, o mesmo comando gera 2..N execuções (efeito observado:
// 12x LIGADO/DESLIGADO por comando único).
const processedMessageIds = new Map<string, number>();
function isDuplicateMessageId(id: string | null | undefined): boolean {
  if (!id) return false;
  const now = Date.now();
  // GC entradas > 10 min
  for (const [k, ts] of processedMessageIds) {
    if (now - ts > 10 * 60_000) processedMessageIds.delete(k);
  }
  if (processedMessageIds.has(id)) return true;
  processedMessageIds.set(id, now);
  return false;
}

const RL_MIN_LIMIT = 10;
const RL_HOUR_LIMIT = 30;
const RL_DAY_LIMIT = 150;
const RL_DUP_LIMIT = 3;

type RateDecision =
  | { allowed: true }
  | { allowed: false; reason: "minute" | "duplicate" }
  | { allowed: false; reason: "hour"; sendWarning: boolean }
  | { allowed: false; reason: "day"; notifySuperAdmin: boolean };

function checkRateLimit(phone: string, text: string): RateDecision {
  const now = Date.now();
  const key = normalizePhone(phone);
  if (!key) return { allowed: true };

  // Dia
  const day = rlDay.get(key);
  if (!day || now - day.windowStart >= 24 * 3600_000) {
    rlDay.set(key, { count: 1, windowStart: now });
  } else {
    day.count++;
    if (day.count > RL_DAY_LIMIT) {
      const lastNotified = rlDayNotified.get(key) ?? 0;
      const notifySuperAdmin = now - lastNotified > 6 * 3600_000;
      if (notifySuperAdmin) rlDayNotified.set(key, now);
      return { allowed: false, reason: "day", notifySuperAdmin };
    }
  }

  // Hora
  const hour = rlHour.get(key);
  if (!hour || now - hour.windowStart >= 3600_000) {
    rlHour.set(key, { count: 1, windowStart: now, warned: false });
  } else {
    hour.count++;
    if (hour.count > RL_HOUR_LIMIT) {
      const sendWarning = !hour.warned;
      hour.warned = true;
      return { allowed: false, reason: "hour", sendWarning };
    }
  }

  // Minuto
  const min = rlMinute.get(key);
  if (!min || now - min.windowStart >= 60_000) {
    rlMinute.set(key, { count: 1, windowStart: now });
  } else {
    min.count++;
    if (min.count > RL_MIN_LIMIT) {
      return { allowed: false, reason: "minute" };
    }
  }

  // Dedup textual (3+ mensagens idênticas seguidas → ignora)
  const t = (text ?? "").trim().toLowerCase();
  if (t) {
    const arr = lastMessages.get(key) ?? [];
    arr.push(t);
    while (arr.length > 5) arr.shift();
    lastMessages.set(key, arr);
    const last3 = arr.slice(-3);
    if (last3.length === 3 && last3.every((m) => m === last3[0])) {
      return { allowed: false, reason: "duplicate" };
    }
  }

  return { allowed: true };
}

// Limpeza periódica (evita crescimento indefinido). Roda a cada minuto.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rlMinute) if (now - b.windowStart > 120_000) rlMinute.delete(k);
  for (const [k, b] of rlHour) if (now - b.windowStart > 3600_000 * 2) rlHour.delete(k);
  for (const [k, b] of rlDay) if (now - b.windowStart > 24 * 3600_000 * 1.5) rlDay.delete(k);
  for (const [k, ts] of rlDayNotified) if (now - ts > 24 * 3600_000) rlDayNotified.delete(k);
}, 60_000);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const DEFAULT_VERIFY_TOKEN = "renov_whatsapp_token_2026";
const DEFAULT_PHONE_NUMBER_ID = "1122648170939922";
const GRAPH_VERSION = "v25.0";
const AI_ROUTER_TIMEOUT_MS = 8_000;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ─────────────────────────────────────────────────────────────────────────────
// Protocolo RF (idêntico a src/lib/protocol.ts + src/lib/rfRouting.ts)
// ─────────────────────────────────────────────────────────────────────────────
const CR = "\r";
type Radio = "R1" | "R2" | "R3";
function buildLoRaFrame(tsnn: string, cmd: string, payload: string) {
  return `[${tsnn}_${cmd}_]{${payload}}[${tsnn}_ETX_]${CR}`;
}
function buildDirectToServer(_radio: Radio, frame: string) { return frame; }
function buildViaRepetidorTx(radioTx: Radio, frame: string) {
  return `REP:R3:TX:${radioTx}:${frame}`;
}
function buildCombinedPayload(
  currentState: string | null | undefined,
  saida: number,
  turnOn: boolean,
  total: number,
): string {
  const n = Math.max(1, Math.min(6, Math.floor(total) || 1));
  const pos = Math.max(1, Math.min(n, Math.floor(saida) || 1));
  let state: string;
  const cur = currentState ?? "";
  if (new RegExp(`^[01]{${n}}$`).test(cur)) state = cur;
  else if (/^[01]{6}$/.test(cur)) state = cur.substring(0, n);
  else state = "0".repeat(n);
  const bit = turnOn ? "1" : "0";
  return state.substring(0, pos - 1) + bit + state.substring(pos);
}
function buildOutputPayload(
  currentState: string | null | undefined,
  saida: number,
  turnOn: boolean,
  total: number,
): string {
  if (total <= 1) return turnOn ? "1" : "0";
  return buildCombinedPayload(currentState, saida, turnOn, total);
}

async function resolvePlcContext(eq: { hw_id: string; plc_group_id: string | null }): Promise<{ tsnn: string; total: number }> {
  let tsnn = (eq.hw_id ?? "").substring(0, 4);
  let total = 1;
  if (eq.plc_group_id) {
    const { data: plc } = await supabase
      .from("plc_groups")
      .select("hw_id, output_count")
      .eq("id", eq.plc_group_id)
      .maybeSingle();
    if (plc?.hw_id) tsnn = plc.hw_id as string;
    const oc = (plc as any)?.output_count;
    if (typeof oc === "number" && oc >= 1) total = Math.max(1, Math.min(6, oc));
  }
  return { tsnn, total };
}

async function loadFarmRouting(farmId: string): Promise<{ radio: Radio; viaRepetidor: boolean }> {
  const { data } = await supabase
    .from("rf_routing")
    .select("radio, via_repetidor")
    .eq("farm_id", farmId)
    .maybeSingle();
  const radio = (["R1", "R2", "R3"] as const).includes((data?.radio as Radio) ?? ("" as Radio))
    ? (data!.radio as Radio)
    : "R1";
  return { radio, viaRepetidor: !!data?.via_repetidor };
}

/**
 * Enfileira comando manual ON/OFF — replica enqueueManualPumpCommand de
 * src/lib/commandQueue.ts. Cancela polling pendente, insere em `commands`
 * (type='manual', priority=1) e sincroniza pending_command_id no equipamento.
 */
async function enqueueManualPumpCommandSrv(args: {
  eq: any;
  turnOn: boolean;
  whoLabel: string;
  createdBy: string | null;
}): Promise<{ ok: true; commandId: string } | { ok: false; reason: string }> {
  const { eq, turnOn } = args;
  if (eq.type === "nivel" || eq.type === "repetidor") {
    return { ok: false, reason: `Equipamento '${eq.type}' não aceita acionamento.` };
  }

  const saidaIdx = Math.max(1, Math.min(6, eq.saida ?? 1));
  const outputs: string = eq.last_outputs_state ?? "";
  const currentlyRunning =
    /^[01]{6}$/.test(outputs) ? outputs.charAt(saidaIdx - 1) === "1"
    : /^[01]$/.test(outputs) ? outputs === "1"
    : false;

  if (eq.last_actuation_origin === "local") {
    if (turnOn && currentlyRunning) return { ok: false, reason: "Bomba já está ligada localmente no painel físico." };
    if (!turnOn && !currentlyRunning) return { ok: false, reason: "Bomba já está desligada localmente no painel físico." };
  }
  const blockedUntil = eq.command_blocked_until ? new Date(eq.command_blocked_until) : null;
  if (eq.last_actuation_origin === "local" && blockedUntil && blockedUntil.getTime() > Date.now()) {
    const secs = Math.ceil((blockedUntil.getTime() - Date.now()) / 1000);
    return { ok: false, reason: `Acionamento local em janela de confirmação — aguarde ${secs}s.` };
  }

  const { tsnn, total } = await resolvePlcContext(eq);
  const newPayload = buildOutputPayload(eq.last_outputs_state, saidaIdx, turnOn, total);
  const routing = await loadFarmRouting(eq.farm_id);
  const lora = buildLoRaFrame(tsnn, "1", newPayload);
  const frame = routing.viaRepetidor
    ? buildViaRepetidorTx(routing.radio, lora)
    : buildDirectToServer(routing.radio, lora);

  // Cancela pollings pendentes para esta bomba
  const cancelAt = new Date().toISOString();
  await supabase
    .from("commands")
    .update({ status: "cancelled", responded_at: cancelAt, error_message: "Polling cancelado por comando manual (WhatsApp)" })
    .eq("farm_id", eq.farm_id)
    .eq("equipment_id", eq.id)
    .eq("type", "polling")
    .eq("status", "pending");

  // Insere comando manual
  const { data: inserted, error: insErr } = await supabase
    .from("commands")
    .insert({
      farm_id: eq.farm_id,
      equipment_id: eq.id,
      plc_hw_id: tsnn,
      type: "manual",
      priority: 1,
      frame,
      timeout_ms: 120_000,
      created_by: args.createdBy,
      client_event_id: crypto.randomUUID(),
      source_device: `whatsapp:${args.whoLabel}`.slice(0, 80),
    })
    .select("id")
    .single();
  if (insErr) return { ok: false, reason: insErr.message };

  const cmdId = (inserted as { id: string }).id;
  const { error: syncErr } = await supabase
    .from("equipments")
    .update({
      pending_command_id: cmdId,
      desired_running: turnOn,
      last_actuation_origin: "whatsapp",
      last_changed_by: args.whoLabel,
      updated_at: new Date().toISOString(),
    })
    .eq("id", eq.id)
    .eq("farm_id", eq.farm_id);
  if (syncErr) return { ok: false, reason: syncErr.message };

  return { ok: true, commandId: cmdId };
}

function normalizePhone(raw: string): string {
  return (raw || "").replace(/\D/g, "");
}

/**
 * Ensure a Brazilian phone is in the international format expected by Meta
 * WhatsApp Cloud API. Prepends "55" when missing. Without this, messages to
 * brand-new contacts silently never arrive.
 */
function toE164BR(raw: string): string {
  const d = normalizePhone(raw);
  if (!d) return d;
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return d;
}

function phoneMatchKeys(phone: string): string[] {
  const normalized = normalizePhone(phone);
  return Array.from(new Set([
    normalized,
    normalized.slice(-11),
    normalized.slice(-10),
  ].filter(Boolean)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser de comandos — tolerante: aliases de ação, aliases de tipo de
// equipamento, número flexível ("02"=="2") e múltiplos alvos numa só mensagem.
// ─────────────────────────────────────────────────────────────────────────────
type WaAction = "turn_on" | "turn_off" | "status";
type WaOp = { action: WaAction; base: string; nums: number[]; raw: string };
type ParsedCmd =
  | { kind: "status_all" }
  | { kind: "level"; base: string | null; nums: number[] }
  | { kind: "ops"; ops: WaOp[] }
  | { kind: "auto_mode"; target: string; activate: boolean }
  | { kind: "set_auto"; base: string; nums: number[]; enable: boolean }
  | { kind: "global_auto"; action: "on" | "off" | "query"; farmHint?: string }
  | { kind: "set_sched_active"; target: "all" | { base: string; nums: number[] }; active: boolean; days?: string[] }
  | { kind: "list_schedules"; base: string | null; nums: number[] }
  | { kind: "add_schedule"; base: string; nums: number[]; timeOn?: string | null; timeOff?: string | null; days?: string[] }
  | { kind: "edit_schedule"; base: string; nums: number[]; timeOn?: string | null; timeOff?: string | null; days?: string[] }
  | { kind: "del_schedule"; base: string; nums: number[]; days?: string[]; timeOn?: string | null; timeOff?: string | null }
  | { kind: "del_all_farm" }
  | { kind: "del_help" }
  | { kind: "add_holiday"; date: string /* YYYY-MM-DD */ }
  | { kind: "list_holidays" }
  | { kind: "schedule_help" }
  | { kind: "edit_help" }
  | null;


const LEVEL_ALIASES = new Set([
  "nivel", "nível", "niveis", "níveis", "nv", "nvl", "level", "levels",
  "reservatorio", "reservatório", "reservatorios", "reservatórios",
  "canal", "canais", "agua", "água", "tanque", "tanques", "caixa", "caixas",
]);

// Frases naturais que disparam o comando de nível (comparadas sem acento, lowercase).
const LEVEL_PHRASES = [
  "quanto tem de agua",
  "nivel da agua",
  "como ta o nivel",
  "como esta o nivel",
  "como ta os niveis",
  "como esta os niveis",
  "como tao os niveis",
  "como estao os niveis",
  "e os niveis",
  "e o nivel",
  "os niveis",
  "me mostra o nivel",
  "me mostra os niveis",
  "ver niveis",
  "ver nivel",
  "nivel dos reservatorios",
  "nivel do reservatorio",
  "niveis dos reservatorios",
  "niveis do reservatorio",
  "nivel dos canais",
  "nivel do canal",
  "niveis dos canais",
  "niveis do canal",
];

const AUTO_ON_ALIASES = new Set(["auto", "automatico", "automático"]);
const AUTO_OFF_ALIASES = new Set(["manual", "mn"]);
const LIST_SCHED_ALIASES = new Set([
  "programacao", "programação", "programacoes", "programações",
  "prog", "progs", "schedule", "schedules", "horario", "horários", "horarios",
]);
const ADD_SCHED_ALIASES = new Set(["programar", "agendar"]);
const DEL_SCHED_ALIASES = new Set(["excluir", "remover", "deletar", "apagar", "limpar", "cancelar", "tirar", "zerar"]);
const HOLIDAY_ALIASES = new Set(["feriado", "feriados"]);

// Manutenção precisa ser 100% determinística e preemptar qualquer conversation_state.
// Aceita acento removido e erro comum visto em campo: "manunteção" → "manuntecao".
const MANUT_WORD = "(?:manuten[;cç]?[aã]o(?:es)?|manunte[;cç]?[aã]o(?:es)?|reparo)";
const MAINTENANCE_WORD_RE = MANUT_WORD;
const MAINTENANCE_COMMAND_RE = new RegExp(
  `^(?:(?:colocar|coloca|botar|bota|ativar|ativa|ligar|liga|habilitar|habilita|por|poe)\\s+)?(?:em\\s+)?(?:modo\\s+)?${MANUT_WORD}(?:\\s+.+)?$|^(?:modo\\s+)?${MANUT_WORD}(?:\\s+.+)?$`,
  "i",
);
const MAINTENANCE_RELEASE_COMMAND_RE = new RegExp(
  `^(?:tirar|remove(?:r)?|remover|desativar|desativa|desligar|desliga|desabilitar|desabilita|finalizar|finaliza|liberar|libera|desbloquear|desbloqueia|sair)\\s+(?:o\\s+|a\\s+|d[ao]\\s+)?(?:modo\\s*)?${MANUT_WORD}(?:\\s+.+)?$|^(?:liberar|libera|desbloquear|desbloqueia|destrava|destravar)\\s+.+`,
  "i",
);

const ACTION_ALIASES: Record<string, WaAction> = {
  // ligar
  "ligar": "turn_on", "liga": "turn_on", "ligue": "turn_on", "lg": "turn_on", "on": "turn_on",
  // desligar
  "desligar": "turn_off", "desliga": "turn_off", "desligue": "turn_off", "desl": "turn_off",
  "deslg": "turn_off", "dl": "turn_off", "off": "turn_off",
  // status
  "status": "status", "st": "status", "sts": "status",
};

// Alias do tipo de equipamento → termo canônico usado no ilike.
// Inclui formas plurais ("bombas", "poços", "conjuntos", "boosters", "canais").
const BASE_ALIASES: Record<string, string> = {
  // poço
  "poço": "poço", "poços": "poço", "poco": "poço", "pocos": "poço",
  "pç": "poço", "pçs": "poço", "pc": "poço", "pcs": "poço", "p": "poço",
  // bomba
  "bomba": "bomba", "bombas": "bomba",
  "bb": "bomba", "bbs": "bomba", "bba": "bomba", "bbas": "bomba", "b": "bomba",
  // conjunto
  "conjunto": "conjunto", "conjuntos": "conjunto",
  "conj": "conjunto", "conjs": "conjunto",
  "cjt": "conjunto", "cjts": "conjunto",
  "cj": "conjunto", "cjs": "conjunto",
  // booster (incluindo erros comuns de digitação)
  "booster": "booster", "boosters": "booster",
  "boost": "booster", "bst": "booster", "bsts": "booster",
  "buster": "booster", "busters": "booster",
  "boster": "booster", "bosters": "booster",
  "bstr": "booster", "bstrs": "booster",
  "bostr": "booster", "bostrs": "booster",
  // canal
  "canal": "canal", "canais": "canal", "cn": "canal",
  // recalque
  "recalque": "recalque", "recalques": "recalque",
  "rec": "recalque", "recs": "recalque",
  // reservatório
  "reservatório": "reservatório", "reservatorio": "reservatório",
  "reserv": "reservatório", "res": "reservatório", "rsv": "reservatório",
};


// Remove acentos e cedilha — "poço" → "poco", "situação" → "situacao".
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ç/g, "c");
}

function normalizeCommandText(text: string): string {
  return stripAccents((text || "").trim().toLowerCase()).replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
}

function isMaintenanceDeterministicCommand(text: string): boolean {
  const t = normalizeCommandText(text);
  return MAINTENANCE_COMMAND_RE.test(t) || MAINTENANCE_RELEASE_COMMAND_RE.test(t);
}

function isAutoModeDeterministicCommand(text: string): boolean {
  const message = (text || "").trim();
  return /^(?:ativar|desativar|ligar|desligar|habilitar|desabilitar)\s+(?:modo\s+)?autom[aá]tico\s+(?:(?:do|da|no|na)\s+)?(.+)/i.test(message)
    || /^modo\s+autom[aá]tico\s+(?:(?:do|da|no|na)\s+)?(.+)/i.test(message)
    || /^(?:ativar|desativar|ligar|desligar|habilitar|desabilitar)\s+(?:modo\s+)?autom[aá]tico\s*$/i.test(message)
    || /^modo\s+autom[aá]tico\s*$/i.test(message);
}

// ─── Dias da semana (parsing dos comandos de programação) ─────────────────────
// IMPORTANTE: códigos canônicos em PT (alinhados ao frontend src/pages/Automatico.tsx)
const DAY_TOKEN_MAP: Record<string, string> = {
  seg: "seg", segunda: "seg", "segunda-feira": "seg", segundas: "seg", mon: "seg", monday: "seg",
  ter: "ter", terca: "ter", "terca-feira": "ter", tercas: "ter", tue: "ter", tuesday: "ter",
  qua: "qua", quarta: "qua", "quarta-feira": "qua", quartas: "qua", wed: "qua", wednesday: "qua",
  qui: "qui", quinta: "qui", "quinta-feira": "qui", quintas: "qui", thu: "qui", thursday: "qui",
  sex: "sex", sexta: "sex", "sexta-feira": "sex", sextas: "sex", fri: "sex", friday: "sex",
  sab: "sab", sabado: "sab", sabados: "sab", sat: "sab", saturday: "sab",
  dom: "dom", domingo: "dom", domingos: "dom", sun: "dom", sunday: "dom",
};
const ALL_DAYS_CODES = ["seg", "ter", "qua", "qui", "sex", "sab", "dom"];
const WEEKDAY_CODES = ["seg", "ter", "qua", "qui", "sex"];
const WEEKEND_CODES = ["sab", "dom"];
function normDayTok(s: string): string {
  return stripAccents((s || "").toLowerCase()).replace(/[,;]/g, "").trim();
}
// Lê tokens a partir de `start` e tenta extrair uma especificação de dias.
// Retorna { days, end } onde end é o índice após o último token consumido,
// ou null se não casou.
function parseDaySpec(toks: string[], start: number): { days: string[]; end: number } | null {
  const set = new Set<string>();
  let i = start;
  let matched = false;
  const peek = (k: number) => normDayTok(toks[i + k] ?? "");
  while (i < toks.length) {
    const t = normDayTok(toks[i]);
    if (!t) { i++; continue; }
    // ranges
    if (t === "seg-sex" || t === "segunda-sexta") { WEEKDAY_CODES.forEach((d) => set.add(d)); matched = true; i++; continue; }
    if (t === "seg-dom" || t === "todos" || t === "all") { ALL_DAYS_CODES.forEach((d) => set.add(d)); matched = true; i++; continue; }
    if (t === "fds") { WEEKEND_CODES.forEach((d) => set.add(d)); matched = true; i++; continue; }
    if (t === "uteis" || t === "util") { WEEKDAY_CODES.forEach((d) => set.add(d)); matched = true; i++; continue; }
    // multi-palavra
    if (t === "todos" && peek(1) === "os" && peek(2) === "dias") {
      ALL_DAYS_CODES.forEach((d) => set.add(d)); matched = true; i += 3; continue;
    }
    if (t === "dias" && (peek(1) === "uteis" || peek(1) === "util")) {
      WEEKDAY_CODES.forEach((d) => set.add(d)); matched = true; i += 2; continue;
    }
    if (t === "fim" && peek(1) === "de" && peek(2) === "semana") {
      WEEKEND_CODES.forEach((d) => set.add(d)); matched = true; i += 3; continue;
    }
    if (t === "de" && DAY_TOKEN_MAP[peek(1)] && peek(2) === "a" && DAY_TOKEN_MAP[peek(3)]) {
      // "de seg a sex"
      const a = ALL_DAYS_CODES.indexOf(DAY_TOKEN_MAP[peek(1)]);
      const b = ALL_DAYS_CODES.indexOf(DAY_TOKEN_MAP[peek(3)]);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        for (let k = lo; k <= hi; k++) set.add(ALL_DAYS_CODES[k]);
        matched = true; i += 4; continue;
      }
    }
    const d = DAY_TOKEN_MAP[t];
    if (d) { set.add(d); matched = true; i++; continue; }
    // separadores "a" / "e"
    if ((t === "e" || t === "a") && matched) { i++; continue; }
    break;
  }
  if (!matched) return null;
  return { days: Array.from(set), end: i };
}

// Detecta intenção de STATUS em linguagem natural ("como tá o poço 2?",
// "me manda o status", "resumo geral", "leitura das bombas"...).
// Retorna o ParsedCmd correspondente, ou null se não for status.
// Palavras plurais/coletivas que indicam pedido GERAL (todos os equipamentos).
// Sempre que aparecerem junto a uma keyword de status, devolvemos status_all,
// sem nunca tentar casar com um equipamento específico.
const PLURAL_GENERAL_WORDS = new Set([
  "bombas", "pocos", "equipamentos", "conjuntos", "boosters",
  "canais", "reservatorios", "tanques", "caixas",
  "todos", "todas", "tds", "tudo", "geral",
]);
function hasPluralGeneralWord(normText: string): boolean {
  const toks = normText.split(/[\s,;]+/).filter(Boolean);
  if (toks.some((t) => PLURAL_GENERAL_WORDS.has(t))) return true;
  // frases compostas
  return /\btodas?\s+as?\s+(bombas|pocos|equipamentos|conjuntos)\b/.test(normText)
      || /\btodos?\s+os?\s+(bombas|pocos|equipamentos|conjuntos)\b/.test(normText);
}

function isGenericEquipmentStatusRest(rest: string): boolean {
  const normRest = stripAccents(String(rest || "").toLowerCase())
    .replace(/[?!.,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(do|da|de|dos|das|o|a|os|as)\s+/, "");
  if (!normRest || /\d/.test(normRest)) return false;
  return /^(poco|pocos|bomba|bombas|equipamento|equipamentos|conjunto|conjuntos|booster|boosters|canal|canais|reservatorio|reservatorios)$/.test(normRest);
}

function detectNaturalStatus(text: string): ParsedCmd {
  const norm = stripAccents((text || "").toLowerCase()).replace(/[?!.]+/g, " ");
  const hasStatusKw =
    /\bstatus\b/.test(norm) ||
    /\bcomo\s+est/.test(norm) ||      // "como está", "como estão"
    /\bcomo\s+ta\b/.test(norm) ||     // "como tá" / "como ta"
    /\bsituacao\b/.test(norm) ||
    /\bleitura\b/.test(norm) ||
    /\brelatorio\b/.test(norm) ||
    /\bresumo\b/.test(norm) ||
    /\btudo\s+bem\b/.test(norm) ||
    /\bta\s+ligad/.test(norm) ||      // "tá ligado", "ta ligada"
    /\besta\s+ligad/.test(norm) ||
    /\bfuncionando\b/.test(norm);
  if (!hasStatusKw) return null;

  // ⚡ PRIORIDADE: pedido plural/coletivo ("status das bombas",
  // "como estão os poços", "situação de todos") → resumo geral.
  if (hasPluralGeneralWord(norm)) return { kind: "status_all" };

  // Procura tipo de equipamento mencionado (varre tokens contra BASE_ALIASES,
  // ambos exatos e versão sem acento).
  const tokens = norm.split(/[\s,;]+/).filter(Boolean);
  let baseCanon: string | null = null;
  const aliasMapNoAccent: Record<string, string> = {};
  for (const [k, v] of Object.entries(BASE_ALIASES)) {
    aliasMapNoAccent[stripAccents(k)] = v;
  }
  // Tipos genéricos ("p", "b") são ambíguos em frases livres — ignora 1 letra.
  for (const tk of tokens) {
    if (tk.length < 2) continue;
    const hit = aliasMapNoAccent[tk];
    if (hit) { baseCanon = hit; break; }
  }

  const nums: number[] = [];
  for (const tk of tokens) {
    if (/^\d+$/.test(tk)) nums.push(parseInt(tk, 10));
  }

  // Tipo genérico sem número (ex: "status poço") é resumo da fazenda padrão.
  if (nums.length === 0) return { kind: "status_all" };

  // Sem base mas com número → trate como status_all (não dá pra adivinhar tipo).
  if (!baseCanon) return { kind: "status_all" };

  // Há tipo + número → reusa o pipeline de ops com action=status.
  return {
    kind: "ops",
    ops: [{
      action: "status",
      base: baseCanon,
      nums,
      raw: nums.length ? `${baseCanon} ${nums.join(",")}` : baseCanon,
    }],
  };
}

// Helpers de parsing para os novos comandos (auto/manual/prog/feriado).
function parseHHMM(raw: string): string | null {
  const m = raw.match(/^(\d{1,2})[:hH](\d{2})$/) ?? raw.match(/^(\d{1,2})h$/i);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function parseFlexDate(tokens: string[]): string | null {
  const joined = tokens.join(" ").trim();
  if (!joined) return null;
  const tz = "America/Bahia";
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (/^(hoje)$/.test(joined)) return fmt(today);
  if (/^(amanha|amanhã)$/.test(joined)) {
    const d = new Date(today); d.setDate(d.getDate() + 1); return fmt(d);
  }
  // dd/mm[/yyyy] ou dd-mm[-yyyy]
  const m1 = joined.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m1) {
    const dd = parseInt(m1[1], 10), mm = parseInt(m1[2], 10);
    let yyyy = m1[3] ? parseInt(m1[3], 10) : today.getFullYear();
    if (yyyy < 100) yyyy += 2000;
    if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
    return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  // yyyy-mm-dd
  const m2 = joined.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m2) {
    const yyyy = parseInt(m2[1], 10), mm = parseInt(m2[2], 10), dd = parseInt(m2[3], 10);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  return null;
}

function resolveBaseFromTokens(toks: string[]): string | null {
  if (!toks.length) return null;
  const bj = toks.join(" ");
  const bl = toks[toks.length - 1];
  return BASE_ALIASES[bj] ?? BASE_ALIASES[bl] ?? bj;
}

function parseCommand(text: string): ParsedCmd {
  let t = (text || "").toLowerCase().trim().replace(/[.!?]+$/g, "");
  if (!t) return null;

  // ── Multi-word phrase rewrites for scheduling (must run BEFORE any
  //    tokenization-based parsing). Maps natural phrases to canonical
  //    first-token forms: "prog" (listing) or "programar" (creation).
  //    Matches both with and without accents.
  {
    const tNoAcc = stripAccents(t);
    // Pares: [regex sobre texto SEM acento, substituição canônica]
    // A substituição é aplicada sobre `t` (mantemos o restante intacto).
    const SCHED_LIST_PHRASES: RegExp[] = [
      /^programacoes\b/, /^programacao\b/, /^progs\b/, /^prog\b/,
      /^horarios?\b(?!\s+(?:das\s+)?bombas?\s+(?:ligar|liga|desligar))/, // bare "horario"
      /^timer\s+das?\s+bombas?\b/,
      /^timer\s+dos?\s+pocos?\b/,
      /^timer\b(?!\s+(?:pc|pç|poc))/, // "timer" sozinho → list; "timer poço X" → criar
      /^horarios?\s+das?\s+bombas?\b/,
      /^horarios?\s+dos?\s+pocos?\b/,
      /^horarios?\s+programados?\b/,
      /^configurar\s+horarios?\b/,
      /^ver\s+programacoes?\b/,
      /^listar\s+programacoes?\b/,
      /^mostrar\s+programacoes?\b/,
      /^quais\s+(?:as\s+)?programacoes?\b/,
      /^quais\s+os\s+horarios?\b/,
    ];
    const SCHED_CREATE_PHRASES: RegExp[] = [
      /^programar\b/,
      /^agendar\s+(?:bomba|poco|pocos|bombas)\b/,
      /^agendar\b/,
      /^fazer\s+programacao(?:\s+das?\s+bombas?)?\b/,
      /^criar\s+programacao\b/,
      /^nova\s+programacao\b/,
      /^adicionar\s+programacao\b/,
      /^configurar\s+horarios?\s+das?\s+bombas?\b/,
      /^configurar\s+como\s+auto\b/,
      /^configurar\s+(?:bomba|poco)s?\s+(?:para|pra)\s+ligar\s+sozinh[oa]\b/,
      /^timer\s+(?:poco|pocos|bomba|bombas)\b/,
    ];

    // ── EDIT phrase rewrites (must run BEFORE create/list rewrites).
    // Maps "mudar/editar/alterar/corrigir/modificar/ajustar prog[ramacao]?"
    // and "trocar/mudar/alterar/corrigir horario" → canonical "editar ...".
    const EDIT_SCHED_PHRASES: RegExp[] = [
      /^(?:mudar|editar|alterar|corrigir|modificar|ajustar)\s+programacao\b/,
      /^(?:mudar|editar|alterar|corrigir|modificar|ajustar)\s+progs?\b/,
      /^(?:trocar|mudar|alterar|corrigir)\s+horarios?\b/,
    ];
    let matchedEditPhrase = false;
    for (const re of EDIT_SCHED_PHRASES) {
      const m = tNoAcc.match(re);
      if (m) {
        t = ("editar " + t.slice(m[0].length).trim()).trim();
        matchedEditPhrase = true;
        break;
      }
    }
    if (matchedEditPhrase) {
      const rest = t.replace(/^editar\s*/, "").trim();
      // sem detalhes → help
      if (!rest) return { kind: "edit_help" };
      // sem números E sem horário E sem dias → help
      const hasTime = /\b\d{1,2}[:h]\d{2}\b/.test(rest);
      const hasNum = /\b\d+\b/.test(rest);
      const tokensRest = rest.split(/\s+/);
      const hasDay = tokensRest.some((tk) => DAY_TOKEN_MAP[normDayTok(tk)] || /^(?:seg-sex|segunda-sexta|seg-dom|todos|fds|uteis|util)$/.test(normDayTok(tk)));
      if (!hasNum && !hasTime && !hasDay) return { kind: "edit_help" };
    }

    // ── DELETE phrase rewrites (must run BEFORE list rewrite, which would
    // otherwise eat "apagar todas as programações" as just "prog todas...").
    {
      const DEL_VERBS = "(?:apagar|excluir|deletar|remover|limpar|cancelar|tirar|zerar|resetar)";
      const PROG_WORDS = "(?:programacoes|programacao|progs|prog)";
      const delAllPatterns: RegExp[] = [
        new RegExp(`^${DEL_VERBS}\\s+todas?\\s+(?:as?\\s+)?${PROG_WORDS}\\s*$`),
        new RegExp(`^${DEL_VERBS}\\s+${PROG_WORDS}\\s+todas?\\s*$`),
        new RegExp(`^(?:zerar|resetar)\\s+${PROG_WORDS}\\s*$`),
        // "apagar tudo" / "limpar tudo" / "zerar tudo" / "resetar tudo"
        new RegExp(`^(?:apagar|limpar|zerar|resetar|excluir|deletar|remover)\\s+tudo\\s*$`),
      ];
      for (const re of delAllPatterns) {
        if (re.test(tNoAcc)) return { kind: "del_all_farm" };
      }
      // verbo + prog/programacao, sem outro detalhe → del_help
      if (new RegExp(`^${DEL_VERBS}\\s+${PROG_WORDS}\\s*$`).test(tNoAcc)) {
        return { kind: "del_help" };
      }
    }

    let matchedListPhrase = false;
    let matchedCreatePhrase = false;
    for (const re of SCHED_CREATE_PHRASES) {
      const m = tNoAcc.match(re);
      if (m) {
        t = "programar " + t.slice(m[0].length).trim();
        t = t.trim();
        matchedCreatePhrase = true;
        break;
      }
    }
    if (!matchedCreatePhrase) {
      for (const re of SCHED_LIST_PHRASES) {
        const m = tNoAcc.match(re);
        if (m) {
          t = "prog " + t.slice(m[0].length).trim();
          t = t.trim();
          matchedListPhrase = true;
          break;
        }
      }
    }

    // Caso "criação sem horários" — frase de criação, mas sem HH:MM no resto.
    if (matchedCreatePhrase) {
      const rest = t.replace(/^programar\s*/, "");
      const hasTime = /\b\d{1,2}[:h]\d{2}\b/.test(rest);
      if (!hasTime) return { kind: "schedule_help" };
    }
    void matchedListPhrase;
  }

  // ── Implicit scheduling rewrite ────────────────────────────────────────────
  // Detect messages that contain equipment + ligar/desligar + HH:MM but DO NOT
  // start with the canonical "programar" keyword. Rewrite them so the
  // downstream parser treats them as add_schedule.
  // Examples handled:
  //   "poço 02 ligar 06:00 desligar 18:00 seg-sex"
  //   "bomba 1 ligar 08:00 seg-sex"
  //   "ligar poço 02 06:00 desligar 7:50 qui"           (single-action reorder)
  //   "coloca poço 02 pra ligar 06:00 desligar 18:00"
  //   "quero programar poço 02 ligar 06:00"
  {
    const tNoAcc2 = stripAccents(t);
    const ALREADY_CANON = /^(programar\b|prog\b|progs\b|editar\b|apagar\b|excluir\b|deletar\b|remover\b|limpar\b|cancelar\b|tirar\b|zerar\b|ativar\b|desativar\b|pausar\b|status\b|st\b|sts\b|nivel\b|níveis\b|niveis\b|auto\b|automatico\b|automático\b|manual\b|alertas?\b|feriado|broadcast|cadastr|aprovar|revogar|ajuda|help|menu)/i;
    const hasTime = /\b\d{1,2}[:h]\d{2}\b/.test(tNoAcc2);
    const hasLigOrDesl = /\b(ligar|liga|ligue|lg|desligar|desliga|desligue|desl|dl|on|off)\b/.test(tNoAcc2);
    const BASE_RE = /\b(poco|pocos|pc|pcs|p|bomba|bombas|bb|bbs|bba|bbas|b|conjunto|conjuntos|conj|conjs|cjt|cjts|cj|cjs|booster|boosters|bst|bsts|canal|canais|cn|cns|reservatorio|reservatorios|reserv|res|rec|recalque|recalques)\b/i;
    const hasBaseAndNum =
      BASE_RE.test(tNoAcc2) &&
      (/\d/.test(tNoAcc2) || /\b(todos?|todas?)\b/.test(tNoAcc2));
    if (!ALREADY_CANON.test(tNoAcc2) && hasTime && hasLigOrDesl && hasBaseAndNum) {
      let cleaned = t;
      // Strip leading conversational verbs/phrases.
      cleaned = cleaned.replace(
        /^(?:eu\s+)?(?:quero|queria|gostaria(?:\s+de)?|preciso|pode|poderia|por\s+favor|favor)\s+(?:de\s+)?/i,
        "",
      );
      cleaned = cleaned.replace(
        /^(?:coloca(?:r)?|coloque|bota(?:r)?|bote|p[oõ]e(?:r)?|ponha|agenda(?:r)?|agende|marca(?:r)?|marque|seta(?:r)?|sete|deixa(?:r)?|deixe|configura(?:r)?|configure|programa(?:r)?)\s+/i,
        "",
      );
      // Drop "pra/para (ligar|desligar)" connector → keep just the verb.
      cleaned = cleaned.replace(/\bpr[ao]\s+(ligar|liga|ligue|desligar|desliga|desligue)\b/gi, "$1");
      // Drop "às/as" before HH:MM.
      cleaned = cleaned.replace(/\b(?:às|as)\s+(\d{1,2}[:h]\d{2})/gi, "$1");

      // Reorder "ligar/desligar <equip> <HH:MM>" → "<equip> ligar/desligar <HH:MM>"
      // ONLY when the leading verb is not part of a "ligar X ... desligar X"
      // (Formato 3) pattern — i.e. the message has only one ligar/desligar verb
      // or one of them appears without a following equipment.
      const reorderRe = /^(ligar|liga|ligue|lg|on|desligar|desliga|desligue|desl|dl|off)\s+(.+)$/i;
      const m = cleaned.match(reorderRe);
      if (m) {
        const verb = m[1].toLowerCase();
        const rest = m[2];
        // Only reorder if the rest contains a base+num immediately, and the
        // verb does not reappear in the form "<other-verb> <base> <num>"
        // (Formato 3 already handles those well).
        const restNoAcc = stripAccents(rest);
        const startsWithBase = new RegExp(`^${BASE_RE.source.replace(/^\\b|\\b$/g, "")}\\b`, "i").test(restNoAcc);
        if (startsWithBase) {
          const timeMatch = rest.match(/\b\d{1,2}[:h]\d{2}\b/);
          if (timeMatch) {
            const idx = rest.indexOf(timeMatch[0]);
            cleaned = (rest.slice(0, idx) + verb + " " + rest.slice(idx)).replace(/\s+/g, " ").trim();
          }
        }
      }

      t = ("programar " + cleaned).replace(/\s+/g, " ").trim();
    }
  }



  if (/^(status|st|sts)$/.test(t)) return { kind: "status_all" };

  // ── MODO AUTOMÁTICO (prioritário) ──────────────────────────────────────────
  // Deve vir antes de qualquer parser/catch-all administrativo que tente buscar
  // operador por nome.
  {
    const message = (text || "").trim();

    // Modo automático: ativar/desativar
    const autoMatch = message.match(
      /^(?:ativar|desativar|ligar|desligar|habilitar|desabilitar)\s+(?:modo\s+)?autom[aá]tico\s+(?:(do|da|no|na|poço|poco|bomba|conjunto)\s+)?(.+)/i,
    );
    if (autoMatch) {
      const prefix = stripAccents((autoMatch[1] ?? "").toLowerCase());
      const rawTarget = autoMatch[2].trim();
      // Se o regex consumiu o tipo do equipamento (poço/bomba/conjunto),
      // recoloca no alvo para o resolver existente conseguir achar base+número.
      const target = /^(poco|bomba|conjunto)$/.test(prefix) ? `${autoMatch[1]} ${rawTarget}` : rawTarget;
      const isActivating = /^(ativar|ligar|habilitar)/i.test(message);
      return { kind: "auto_mode", target, activate: isActivating };
    }

    // Variação: "modo automatico poço 03 sossego" (sem ativar/desativar = ativar)
    const autoMatch2 = message.match(
      /^modo\s+autom[aá]tico\s+(?:(do|da|no|na|poço|poco|bomba|conjunto)\s+)?(.+)/i,
    );
    if (autoMatch2) {
      const prefix = stripAccents((autoMatch2[1] ?? "").toLowerCase());
      const rawTarget = autoMatch2[2].trim();
      const target = /^(poco|bomba|conjunto)$/.test(prefix) ? `${autoMatch2[1]} ${rawTarget}` : rawTarget;
      return { kind: "auto_mode", target, activate: true };
    }
  }

  // "status fazenda Sossego" / "status Terra Norte" é status de fazenda,
  // não status de equipamento chamado "fazenda ...".
  {
    const normStatusFarm = stripAccents(t).replace(/[?!.,;]+/g, " ").replace(/\s+/g, " ").trim();
    if (/^(status|st|sts|resumo|situacao)\s+(?:da\s+|de\s+|do\s+)?fazenda\b/.test(normStatusFarm)) {
      return { kind: "status_all" };
    }
    const m = normStatusFarm.match(/^(status|st|sts)\s+(.+)$/);
    if (m) {
      const rest = m[2].trim();
      if (isGenericEquipmentStatusRest(rest)) return { kind: "status_all" };
      const restTokens = rest.split(/\s+/).filter(Boolean);
      const firstRest = restTokens[0] ?? "";
      const looksLikeEquipmentStatus = !!BASE_ALIASES[firstRest] || restTokens.some((tk) => !!BASE_ALIASES[tk]) || /\d/.test(rest);
      if (!looksLikeEquipmentStatus) return { kind: "status_all" };
    }
  }


  // ⚡ Pedido GERAL: "status" (ou sinônimos) + plural/coletivo, em qualquer
  // posição. Tem que vir ANTES de qualquer tentativa de casar equipamento
  // específico — senão "status das bombas" vira "Bomba 3" por engano.
  {
    const normFull = stripAccents(t).replace(/[?!.,;]+/g, " ");
    const hasStatusKw =
      /\bstatus\b/.test(normFull) || /\bcomo\s+est/.test(normFull) ||
      /\bcomo\s+ta\b/.test(normFull) || /\bsituacao\b/.test(normFull) ||
      /\bresumo\b/.test(normFull) || /\bleitura\b/.test(normFull) ||
      /\brelatorio\b/.test(normFull);
    if (hasStatusKw && hasPluralGeneralWord(normFull)) {
      return { kind: "status_all" };
    }
  }

  // Normaliza separadores: " e ", vírgula, ponto-e-vírgula → espaço.
  let tokens = t
    .replace(/\s+e\s+/g, " ")
    .split(/[\s,;]+/)
    .filter(Boolean);

  // ── Pré-processamento p/ programação em massa ──────────────────────────────
  // Aplicado sempre (seguro globalmente):
  //  • Remove "às"/"as" quando seguidos de horário (ex: "às 21:02").
  //  • Tira sufixo "h" ou "hs" de tokens de horário ("21:02h", "06:00hs").
  //  • Expande intervalos numéricos curtos ("1-6" → "1 2 3 4 5 6"; até 50).
  //  • Mantém "todos"/"todas" como tokens (resolveEquipmentsForBase trata
  //    nums vazios como "todos do tipo").
  {
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      const next = tokens[i + 1] ?? "";
      // "às"/"as" antes de horário: pula
      if (
        (stripAccents(tk) === "as") &&
        /^\d{1,2}[:h]\d{2}h?s?$/i.test(next)
      ) continue;
      // Horário com sufixo "h"/"hs": normaliza para HH:MM
      const tmHs = tk.match(/^(\d{1,2})[:h](\d{2})h?s?$/i);
      if (tmHs) { out.push(`${tmHs[1].padStart(2, "0")}:${tmHs[2]}`); continue; }
      // Intervalo numérico "N-M" (apenas dígitos curtos, span ≤ 50)
      const rm = tk.match(/^(\d{1,2})-(\d{1,2})$/);
      if (rm) {
        const a = parseInt(rm[1], 10), b = parseInt(rm[2], 10);
        if (a <= b && (b - a) <= 50) {
          for (let n = a; n <= b; n++) out.push(String(n));
          continue;
        }
      }
      out.push(tk);
    }
    tokens = out;
  }

  const first = tokens[0];


  // ── NÍVEL via frase natural (ex: "quanto tem de água", "como tá o nível") ──
  const tNoAcc = stripAccents(t);
  if (LEVEL_PHRASES.some((p) => tNoAcc === p || tNoAcc.startsWith(p + " ") || tNoAcc.startsWith(p))) {
    return { kind: "level", base: null, nums: [] };
  }

  // ── FERIADO ────────────────────────────────────────────────────────────────
  if (HOLIDAY_ALIASES.has(first) || (first === "adicionar" && HOLIDAY_ALIASES.has(tokens[1] ?? ""))
      || (first === "listar" && HOLIDAY_ALIASES.has(tokens[1] ?? ""))) {
    // "feriados" / "listar feriados"
    if (first === "feriados" || (first === "listar" && tokens[1] === "feriados")) {
      return { kind: "list_holidays" };
    }
    // "adicionar feriado [data]" / "feriado [data]"
    const start = first === "adicionar" ? 2 : 1;
    const rest = tokens.slice(start);
    if (rest.length === 0) return { kind: "list_holidays" };
    const date = parseFlexDate(rest);
    if (!date) return null;
    return { kind: "add_holiday", date };
  }

  // ── MODO AUTOMÁTICO GLOBAL (master toggle da fazenda) ──────────────────────
  // Aceita uma vasta lista de frases naturais. Sempre verifica a string
  // INTEIRA (sem acentos) — evita confundir com "auto poço 02" / "manual
  // poço 02", que são tratados no bloco per-equipamento mais abaixo, e com
  // "programar/prog ...", que são tratados antes deste ponto.
  {
    const tNo = stripAccents(t).replace(/\s+/g, " ").trim();
    // Núcleo "automático": permite "automatico", "modo auto",
    // "modo automatico", "o automatico", "o modo automatico" etc.
    const CORE = "(?:o\\s+)?(?:modo\\s+)?(?:auto|automatico)";
    // Sufixo opcional com nome de fazenda: "... terra norte", "... na fazenda X",
    // "... da fazenda X". O grupo capturado vira farmHint.
    const FARM_TAIL = "(?:\\s+(?:(?:em|na|no|de|da|do|para|pra)\\s+)?(?:fazenda\\s+)?(.+))?";

    // ON
    const GA_ON_PATTERNS: RegExp[] = [
      new RegExp(`^${CORE}\\s+(?:on|ligado|ativo|ativad[oa])${FARM_TAIL}$`),
      new RegExp(`^(?:ativar?|ativa|ligar?|liga|habilitar?|habilita|acionar?|aciona)\\s+${CORE}${FARM_TAIL}$`),
      // "ligar bombas no (modo) automatico"
      new RegExp(`^ligar\\s+(?:as\\s+)?bombas?\\s+no\\s+(?:modo\\s+)?(?:auto|automatico)${FARM_TAIL}$`),
      // "colocar/botar/por (as bombas) no (modo) automatico|auto"
      new RegExp(`^(?:colocar|botar|por|pôr)\\s+(?:as\\s+bombas?\\s+)?no\\s+(?:modo\\s+)?(?:auto|automatico)${FARM_TAIL}$`),
    ];

    // OFF
    const GA_OFF_PATTERNS: RegExp[] = [
      new RegExp(`^${CORE}\\s+(?:off|desligado|inativo|desativad[oa]|pausad[oa])${FARM_TAIL}$`),
      new RegExp(`^(?:desativar?|desativa|desligar?|desliga|desabilitar?|desabilita|parar?|para|pausar?|pausa|interromper|interrompa|cancelar?|cancela)\\s+${CORE}${FARM_TAIL}$`),
      /^modo\s+manual$/,
      new RegExp(`^(?:tirar|sair)\\s+(?:as\\s+bombas?\\s+)?do\\s+(?:modo\\s+)?(?:auto|automatico)${FARM_TAIL}$`),
      new RegExp(`^(?:colocar|botar|por|pôr)\\s+(?:as\\s+bombas?\\s+)?no\\s+manual${FARM_TAIL}$`),
      // "parar tudo" / "desligar tudo" — apenas DESATIVA o automático (não apaga programações)
      /^parar\s+tudo$/,
      /^desligar\s+tudo$/,
    ];

    // QUERY (consulta)
    const GA_QUERY_PATTERNS: RegExp[] = [
      new RegExp(`^${CORE}$`),
      new RegExp(`^${CORE}\\s+status$`),
      new RegExp(`^status(?:\\s+do)?\\s+${CORE}$`),
      /^status\s+modo\s+auto(?:matico)?$/,
      new RegExp(`^verificar\\s+${CORE}$`),
      new RegExp(`^como\\s+(?:esta|ta)\\s+${CORE}$`),
      new RegExp(`^${CORE}\\s+(?:ta|esta)\\s+(?:ligado|ativo|ativad[oa])$`),
    ];

    const cleanHint = (s: string | undefined) => {
      if (!s) return undefined;
      const v = s.trim().replace(/[?!.,;]+$/g, "").trim();
      return v.length ? v : undefined;
    };
    for (const re of GA_ON_PATTERNS) {
      const m = re.exec(tNo);
      if (m) return { kind: "global_auto", action: "on", farmHint: cleanHint(m[1]) };
    }
    for (const re of GA_OFF_PATTERNS) {
      const m = re.exec(tNo);
      if (m) return { kind: "global_auto", action: "off", farmHint: cleanHint(m[1]) };
    }
    for (const re of GA_QUERY_PATTERNS) if (re.test(tNo)) return { kind: "global_auto", action: "query" };
  }


  // ── ATIVAR / DESATIVAR PROGRAMAÇÃO ─────────────────────────────────────────
  // "ativar prog poço 02", "desativar programação bomba 1", "pausar prog cj 2",
  // "ativar prog todas", "ativar todas programações", "desativar todas",
  // "pausar todas".
  if (
    (first === "ativar" || first === "desativar" || first === "pausar") &&
    tokens.length >= 2
  ) {
    const active = first === "ativar";
    // detecta se o próximo token é "prog/programação..." OU "todas/todos"
    const second = tokens[1];
    const isProgWord = LIST_SCHED_ALIASES.has(second);
    const isTodas = second === "todas" || second === "todos";
    if (isProgWord || isTodas) {
      // "todas as programações" / "todas programações" / "todas"
      const rest = tokens.slice(isProgWord ? 2 : (second === "as" ? 3 : 2));
      const restJoined = tokens.slice(1).join(" ");
      if (
        isTodas ||
        /\btodas?\b/.test(restJoined) ||
        rest.length === 0
      ) {
        // ativar/desativar prog todas | ativar todas programações
        if (
          isTodas ||
          rest.length === 0 ||
          rest[0] === "todas" || rest[0] === "todos" ||
          LIST_SCHED_ALIASES.has(rest[0] ?? "")
        ) {
          const dsAll = parseDaySpec(tokens, 2) ?? parseDaySpec(tokens, 3);
          return { kind: "set_sched_active", target: "all", active, days: dsAll?.days };
        }
      }
      // por equipamento: "ativar prog poço 02 [dias...]"
      if (isProgWord) {
        let i = 2;
        const baseToks: string[] = [];
        while (i < tokens.length && !isNumTok(tokens[i]) && !DAY_TOKEN_MAP[normDayTok(tokens[i])]) {
          const tkn = stripAccents(tokens[i]);
          if (tkn !== "todos" && tkn !== "todas" && tkn !== "todo" && tkn !== "toda" && tkn !== "os" && tkn !== "as") {
            baseToks.push(tokens[i]);
          }
          i++;
        }
        const nums: number[] = [];
        while (i < tokens.length && isNumTok(tokens[i])) { pushNumTok(nums, tokens[i]); i++; }
        const ds = parseDaySpec(tokens, i);
        const base = resolveBaseFromTokens(baseToks);
        if (base) return { kind: "set_sched_active", target: { base, nums: Array.from(new Set(nums)) }, active, days: ds?.days };

      }
    }
  }


  // ── EXCLUIR PROGRAMAÇÃO ────────────────────────────────────────────────────
  // "excluir prog poço 02" / "excluir prog poço 01 seg"
  if (DEL_SCHED_ALIASES.has(first) && tokens.length >= 3 && LIST_SCHED_ALIASES.has(tokens[1])) {
    let i = 2;
    const baseToks: string[] = [];
    while (i < tokens.length && !isNumTok(tokens[i]) && !DAY_TOKEN_MAP[normDayTok(tokens[i])]) {
      const tkn = stripAccents(tokens[i]);
      if (tkn !== "todos" && tkn !== "todas" && tkn !== "todo" && tkn !== "toda" && tkn !== "os" && tkn !== "as") {
        baseToks.push(tokens[i]);
      }
      i++;
    }
    const nums: number[] = [];
    while (i < tokens.length && isNumTok(tokens[i])) { pushNumTok(nums, tokens[i]); i++; }
    // Filtro opcional por horário específico: "ligar HH:MM" / "desligar HH:MM"
    let dTimeOn: string | null = null;
    let dTimeOff: string | null = null;
    const LIG_TOKS_D = new Set(["ligar", "liga", "ligue", "lg", "on"]);
    const DL_TOKS_D = new Set(["desligar", "desliga", "desligue", "dl", "off"]);
    for (let k = i; k < tokens.length - 1; k++) {
      if (LIG_TOKS_D.has(tokens[k])) {
        const hm = parseHHMM(tokens[k + 1]);
        if (hm) dTimeOn = hm;
      } else if (DL_TOKS_D.has(tokens[k])) {
        const hm = parseHHMM(tokens[k + 1]);
        if (hm) dTimeOff = hm;
      }
    }
    const ds = parseDaySpec(tokens, i);
    const base = resolveBaseFromTokens(baseToks);
    if (!base) return null;
    // Sem nums e sem filtro = del_help (ex: "apagar prog poço")
    if (nums.length === 0 && !ds && !dTimeOn && !dTimeOff) return { kind: "del_help" };
    return { kind: "del_schedule", base, nums: Array.from(new Set(nums)), days: ds?.days, timeOn: dTimeOn, timeOff: dTimeOff };
  }


  // ── EDITAR PROGRAMAÇÃO ─────────────────────────────────────────────────────
  // "editar [equipamento] [ligar HH:MM] [desligar HH:MM] [dias]"
  // Suporta atualização parcial: só horário, só dias, ou substituição completa.
  if (first === "editar") {
    const LIG_TOKS_E = new Set(["ligar", "liga", "ligue", "lg", "on"]);
    const DL_TOKS_E = new Set(["desligar", "desliga", "desligue", "dl", "off"]);
    const isTimeTokE = (tk: string) => /^\d{1,2}:\d{2}$/.test(tk);
    const scanFwdTimeE = (start: number): { time: string | null; idx: number } => {
      for (let i = start; i < tokens.length; i++) {
        if (isTimeTokE(tokens[i])) {
          const hm = parseHHMM(tokens[i]);
          if (hm) return { time: hm, idx: i };
        }
      }
      return { time: null, idx: -1 };
    };

    let timeOn: string | null = null;
    let timeOff: string | null = null;
    let baseEnd = tokens.length;

    const ligIdx = tokens.findIndex((tk) => LIG_TOKS_E.has(tk));
    const dlIdx = tokens.findIndex((tk) => DL_TOKS_E.has(tk));
    let ligTimeIdx = -1, dlTimeIdx = -1;
    if (ligIdx >= 0) {
      const s = scanFwdTimeE(ligIdx + 1);
      timeOn = s.time; ligTimeIdx = s.idx;
    }
    if (dlIdx >= 0) {
      const s = scanFwdTimeE(dlIdx + 1);
      timeOff = s.time; dlTimeIdx = s.idx;
    }
    const cand = [ligIdx, dlIdx].filter((x) => x >= 0);
    if (cand.length) baseEnd = Math.min(...cand);

    // baseEnd pode incluir tokens de dias se não houver horários — ajusta.
    if (cand.length === 0) {
      for (let k = 1; k < tokens.length; k++) {
        const ntk = normDayTok(tokens[k]);
        if (DAY_TOKEN_MAP[ntk] || /^(?:seg-sex|segunda-sexta|seg-dom|todos|all|fds|uteis|util)$/.test(ntk)) {
          baseEnd = k;
          break;
        }
      }
    }

    // Coleta base + nums.
    let i = 1;
    const baseToks: string[] = [];
    while (i < baseEnd && !isNumTok(tokens[i])) {
      const tk = tokens[i];
      const tkn = stripAccents(tk);
      if (tkn === "todos" || tkn === "todas" || tkn === "todo" || tkn === "toda" || tkn === "os" || tkn === "as") {
        // skip
      } else {
        baseToks.push(tk);
      }
      i++;
    }
    const nums: number[] = [];
    while (i < baseEnd) {
      if (isNumTok(tokens[i])) pushNumTok(nums, tokens[i]);
      i++;
    }
    const base = resolveBaseFromTokens(baseToks);
    if (!base || nums.length === 0) return { kind: "edit_help" };
    const uniqNums = Array.from(new Set(nums));

    // Dias: após o último horário, ou direto após nums se sem horários.
    let dsStart = -1;
    if (ligTimeIdx >= 0 || dlTimeIdx >= 0) {
      dsStart = Math.max(ligTimeIdx, dlTimeIdx) + 1;
    } else {
      dsStart = baseEnd;
    }
    while (
      dsStart > 0 && dsStart < tokens.length &&
      !DAY_TOKEN_MAP[normDayTok(tokens[dsStart])] &&
      !/^(?:seg-sex|segunda-sexta|seg-dom|todos|all|fds|uteis|util|dias|fim|de)$/.test(normDayTok(tokens[dsStart]))
    ) dsStart++;
    const ds = dsStart > 0 && dsStart < tokens.length ? parseDaySpec(tokens, dsStart) : null;

    if (!timeOn && !timeOff && !(ds && ds.days.length)) return { kind: "edit_help" };

    return { kind: "edit_schedule", base, nums: uniqNums, timeOn, timeOff, days: ds?.days };
  }


  // ── ADICIONAR PROGRAMAÇÃO ──────────────────────────────────────────────────
  // Suporta:
  //  • "programar poço 02 ligar 06:00 desligar 18:00 [dias]"
  //  • "programar poço 1,2,3,4,5,6 ligar HH:MM desligar HH:MM"
  //  • "programar poço 1-6 ligar HH:MM desligar HH:MM"
  //  • "programar todos os poços ligar HH:MM desligar HH:MM"
  //  • "ligar poço 1,2,3 21:02 desligar poço 1,2,3 17:45 [dias]" (Formato 3)
  //  • "fazer programação poço 1,2,3 ligar 21:02 desligar 17:45"
  //  • "prog poço 02 06:00-18:00"
  const LIG_TOKS = new Set(["ligar", "liga", "ligue", "lg", "on"]);
  const DL_TOKS = new Set(["desligar", "desliga", "desligue", "dl", "off"]);
  const isTimeTok = (tk: string) => /^\d{1,2}:\d{2}$/.test(tk);
  const scanForwardTime = (start: number): { time: string | null; idx: number } => {
    for (let i = start; i < tokens.length; i++) {
      if (isTimeTok(tokens[i])) {
        const hm = parseHHMM(tokens[i]);
        if (hm) return { time: hm, idx: i };
      }
    }
    return { time: null, idx: -1 };
  };

  const isSchedEntry =
    ADD_SCHED_ALIASES.has(first) ||
    (LIST_SCHED_ALIASES.has(first) && tokens.length >= 3 && /\d/.test(tokens.slice(1).join(" "))) ||
    // Formato 3/4: começa com ligar/liga e contém desligar/desliga + HH:MM
    (LIG_TOKS.has(first) && tokens.some((tk) => DL_TOKS.has(tk)) && tokens.some(isTimeTok));

  if (isSchedEntry) {
    // detecta padrão "HH:MM-HH:MM"
    const rangeIdx = tokens.findIndex((tk) => /^\d{1,2}[:h]\d{2}[\-–]\d{1,2}[:h]\d{2}$/.test(tk));
    let timeOn: string | null = null;
    let timeOff: string | null = null;
    let baseEnd = tokens.length;
    let ligIdx = -1, dlIdx = -1;
    let ligTimeIdx = -1, dlTimeIdx = -1;
    if (rangeIdx >= 0) {
      const [a, b] = tokens[rangeIdx].split(/[\-–]/);
      timeOn = parseHHMM(a); timeOff = parseHHMM(b);
      baseEnd = rangeIdx;
    } else {
      ligIdx = tokens.findIndex((tk) => LIG_TOKS.has(tk));
      dlIdx = tokens.findIndex((tk) => DL_TOKS.has(tk));
      if (ligIdx >= 0) {
        const onScan = scanForwardTime(ligIdx + 1);
        timeOn = onScan.time;
        ligTimeIdx = onScan.idx;
      }
      if (dlIdx >= 0) {
        const offScan = scanForwardTime(dlIdx + 1);
        timeOff = offScan.time;
        dlTimeIdx = offScan.idx;
      }
      // baseEnd = onde começa a primeira palavra-chave ligar/desligar presente
      const candIdxs = [ligIdx, dlIdx].filter((x) => x >= 0);
      if (candIdxs.length) baseEnd = Math.min(...candIdxs);
      // Se "ligar" é o PRIMEIRO token (Formato 3), os equipamentos vêm DEPOIS
      // de "ligar". Nesse caso, baseEnd vira o índice do primeiro HH:MM.
      if (LIG_TOKS.has(first) && ligIdx === 0 && ligTimeIdx > 0) {
        baseEnd = ligTimeIdx;
      }
    }
    if (!timeOn && !timeOff) {
      if (ADD_SCHED_ALIASES.has(first) || LIG_TOKS.has(first)) return null;
      // não é add_schedule — segue p/ list_schedules
    } else {
      // Onde começar a coletar base+nums:
      //  - Padrão (programar/prog/agendar/...): a partir de tokens[1]
      //  - Formato 3 ("ligar poço ..."): a partir de tokens[ligIdx+1]
      const startIdx = LIG_TOKS.has(first) && ligIdx === 0 ? ligIdx + 1 : 1;
      let i = startIdx;
      const baseToks: string[] = [];
      let allOfType = false;
      // Coleta palavras de base até achar um número
      while (i < baseEnd && !isNumTok(tokens[i])) {
        const tk = tokens[i];
        const tkn = stripAccents(tk);
        // "todos/todas/todo/toda" + opcional "os/as" → allOfType
        if (tkn === "todos" || tkn === "todas" || tkn === "todo" || tkn === "toda") {
          allOfType = true;
        } else if (tkn === "os" || tkn === "as") {
          // skip conector
        } else {
          baseToks.push(tk);
        }
        i++;
      }
      const nums: number[] = [];
      while (i < baseEnd) { if (isNumTok(tokens[i])) pushNumTok(nums, tokens[i]); i++; }
      const base = resolveBaseFromTokens(baseToks);
      if (!base) return null;
      if (!allOfType && nums.length === 0) return null;
      // Dedup nums
      const uniqNums = Array.from(new Set(nums));
      // Detecta dias APÓS o último horário capturado.
      let afterTimes = -1;
      if (rangeIdx >= 0) afterTimes = rangeIdx + 1;
      else afterTimes = Math.max(ligTimeIdx, dlTimeIdx) + 1;
      // No Formato 3, pode haver "desligar poço X" entre os tempos — pula
      // tokens não-dia até chegar nos dias.
      let dsStart = afterTimes;
      while (
        dsStart > 0 && dsStart < tokens.length &&
        !DAY_TOKEN_MAP[normDayTok(tokens[dsStart])] &&
        !/^(?:seg-sex|segunda-sexta|seg-dom|todos|all|fds|uteis|util|dias|fim|de)$/.test(normDayTok(tokens[dsStart]))
      ) dsStart++;
      const ds = dsStart > 0 && dsStart < tokens.length ? parseDaySpec(tokens, dsStart) : null;
      return { kind: "add_schedule", base, nums: allOfType ? [] : uniqNums, timeOn, timeOff, days: ds?.days };
    }
  }



  // ── LISTAR PROGRAMAÇÕES ────────────────────────────────────────────────────
  if (LIST_SCHED_ALIASES.has(first)) {
    let i = 1;
    const baseToks: string[] = [];
    while (i < tokens.length && !isNumTok(tokens[i])) { baseToks.push(tokens[i]); i++; }
    const nums: number[] = [];
    while (i < tokens.length) { if (isNumTok(tokens[i])) pushNumTok(nums, tokens[i]); i++; }
    return { kind: "list_schedules", base: resolveBaseFromTokens(baseToks), nums };
  }

  // ── MODO AUTO / MANUAL ─────────────────────────────────────────────────────
  // "auto poço 02" / "modo auto bomba 1" / "manual cj 2"
  let autoEnable: boolean | null = null;
  let autoStart = 1;
  if (first === "modo" && tokens[1]) {
    if (AUTO_ON_ALIASES.has(tokens[1])) { autoEnable = true; autoStart = 2; }
    else if (AUTO_OFF_ALIASES.has(tokens[1])) { autoEnable = false; autoStart = 2; }
  } else if (AUTO_ON_ALIASES.has(first)) {
    autoEnable = true;
  } else if (AUTO_OFF_ALIASES.has(first)) {
    autoEnable = false;
  }
  if (autoEnable !== null) {
    let i = autoStart;
    const baseToks: string[] = [];
    while (i < tokens.length && !isNumTok(tokens[i])) { baseToks.push(tokens[i]); i++; }
    const nums: number[] = [];
    while (i < tokens.length) { if (isNumTok(tokens[i])) pushNumTok(nums, tokens[i]); i++; }
    const base = resolveBaseFromTokens(baseToks);
    if (!base) return detectNaturalStatus(text);
    return { kind: "set_auto", base, nums, enable: autoEnable };
  }

  // Comando de nível (com ou sem alvo: "nivel", "nv canal", "nivel reservatorio 1")
  if (LEVEL_ALIASES.has(first)) {
    let j = 1;
    const baseToks: string[] = [];
    while (j < tokens.length && !isNumTok(tokens[j])) {
      baseToks.push(tokens[j]);
      j++;
    }
    const nums: number[] = [];
    while (j < tokens.length) {
      if (isNumTok(tokens[j])) pushNumTok(nums, tokens[j]);
      j++;
    }
    let baseCanon: string | null = null;
    if (baseToks.length) {
      const bj = baseToks.join(" ");
      const bl = baseToks[baseToks.length - 1];
      baseCanon = BASE_ALIASES[bj] ?? BASE_ALIASES[bl] ?? bj;
    }
    return { kind: "level", base: baseCanon, nums };
  }

  if (tokens.length < 2) return detectNaturalStatus(text);

  const action = ACTION_ALIASES[tokens[0]];
  if (!action) return detectNaturalStatus(text);

  // Tokens de base = todos não-numéricos consecutivos após o verbo.
  let i = 1;
  const baseTokens: string[] = [];
  while (i < tokens.length && !isNumTok(tokens[i])) {
    baseTokens.push(tokens[i]);
    i++;
  }
  if (baseTokens.length === 0) return detectNaturalStatus(text);

  const baseJoined = baseTokens.join(" ");
  const baseLast = baseTokens[baseTokens.length - 1];
  const baseCanon =
    BASE_ALIASES[baseJoined] ?? BASE_ALIASES[baseLast] ?? baseJoined;

  const nums: number[] = [];
  while (i < tokens.length) {
    if (isNumTok(tokens[i])) pushNumTok(nums, tokens[i]);
    i++;
  }

  const op: WaOp = {
    action,
    base: baseCanon,
    nums,
    raw: nums.length ? `${baseCanon} ${nums.join(",")}` : baseCanon,
  };
  return { kind: "ops", ops: [op] };
}


// Extrai todos os inteiros do nome (ex: "Poço 02" → [2]).
function extractNumbers(s: string): number[] {
  return Array.from(String(s ?? "").matchAll(/\d+/g)).map((m) =>
    parseInt(m[0], 10),
  );
}

// ── Number-token helpers (shared by all bulk commands) ───────────────────────
// Accepts a single token and returns the expanded list of equipment numbers.
// Supports ONLY:
//   • "5"         → [5]
//   • "17"        → [17]              (multi-digit = ONE equipment number)
//   • "1-6"       → [1,2,3,4,5,6]     (range)
//   • "01-06"     → [1,2,3,4,5,6]     (range with leading zeros)
// DOES NOT split concatenated digits — "123456" is treated as equipment 123456.
function expandNumberToken(tok: string): number[] {
  if (!tok) return [];
  const r = tok.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (r) {
    const a = parseInt(r[1], 10), b = parseInt(r[2], 10);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const out: number[] = [];
      for (let i = lo; i <= hi && i - lo < 100; i++) out.push(i);
      return out;
    }
    return [];
  }
  if (!/^\d+$/.test(tok)) return [];
  const n = parseInt(tok, 10);
  return Number.isFinite(n) && n > 0 ? [n] : [];
}

// Whether a token "looks like a number" for the purpose of stopping
// base-word collection. Accepts plain digits and ranges ("1-6").
function isNumTok(tk: string): boolean {
  return /^\d+(?:[-–]\d+)?$/.test(tk || "");
}

// Push expanded numbers from a token into the given array.
function pushNumTok(arr: number[], tk: string): void {
  for (const n of expandNumberToken(tk)) arr.push(n);
}

// Parse bulk targets: aceita "todas/todos", ranges "1-6", listas "1,2,3" ou
// "1 2 3". Cada token é UM número (sem expansão de dígitos concatenados).
function parseBulkTargets(rest: string): { allOfType: boolean; nums: number[]; ambiguous: boolean } {
  const s = stripAccents((rest || "").toLowerCase());
  if (
    /\btodas?\s+(?:as?\s+)?(?:bombas?|pocos?|equipamentos?|conjuntos?)\b/.test(s)
    || /\btodos?\s+(?:os?\s+)?(?:bombas?|pocos?|equipamentos?|conjuntos?)\b/.test(s)
    || /^\s*todas?\s*$/.test(s)
    || /^\s*todos?\s*$/.test(s)
  ) {
    return { allOfType: true, nums: [], ambiguous: false };
  }
  const nums = new Set<number>();
  let work = s;
  // 1) Ranges "1-6" / "01-06"
  const rangeRe = /(\d+)\s*[-–]\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = rangeRe.exec(s))) {
    for (const n of expandNumberToken(`${m[1]}-${m[2]}`)) nums.add(n);
    work = work.replace(m[0], " ");
  }
  // 2) Tokens separados por vírgula e/ou espaço (cada token = um número)
  const toks = work.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  for (const tk of toks) {
    if (!/^\d+$/.test(tk)) continue;
    const n = parseInt(tk, 10);
    if (Number.isFinite(n) && n > 0) nums.add(n);
  }
  return { allOfType: false, nums: [...nums].sort((a, b) => a - b), ambiguous: false };
}

// Detecta se o "rest" usa forma plural sem números (ex: "bombas", "poços").
function isPluralBaseWithoutNumbers(rest: string): boolean {
  const s = stripAccents((rest || "").toLowerCase()).trim();
  if (/\d/.test(s)) return false;
  return /^(?:bombas|pocos|equipamentos|conjuntos|boosters)\b/.test(s);
}





async function getWaCreds(farmId?: string): Promise<{
  api_token: string | null;
  phone_number_id: string;
}> {
  let data: any = null;
  if (farmId) {
    const { data: scoped, error } = await supabase
      .from("whatsapp_config")
      .select("api_token, phone_number_id, farm_id, updated_at")
      .eq("farm_id", farmId)
      .not("api_token", "is", null)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) console.error("WA getWaCreds scoped err", error.message);
    data = scoped;
  }

  // Safety net: if a farm-specific config is missing, use any valid WhatsApp
  // config instead of silently dropping replies. The phone_number_id is shared
  // in this deployment, so this keeps the bot responsive across farms.
  if (!data?.api_token) {
    if (farmId) console.warn("WA getWaCreds: farm config missing, falling back to global token", { farmId });
    const { data: fallback, error } = await supabase
      .from("whatsapp_config")
      .select("api_token, phone_number_id, farm_id, updated_at")
      .not("api_token", "is", null)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) console.error("WA getWaCreds fallback err", error.message);
    data = fallback;
  }
  return {
    api_token: data?.api_token ?? null,
    phone_number_id: data?.phone_number_id || DEFAULT_PHONE_NUMBER_ID,
  };
}

async function logMessage(args: {
  direction: "incoming" | "outgoing";
  phone: string;
  operator_name?: string | null;
  operator_id?: string | null;
  farm_id?: string | null;
  message_type?: string | null;
  message_body?: string | null;
  message_id?: string | null;
  command_parsed?: string | null;
  command_result?: string | null;
  metadata?: Record<string, unknown> | null;
  timestamp_meta?: string | null;
  group_id?: string | null;
  original_type?: string | null;
  audio_duration_seconds?: number | null;
}) {
  try {
    await supabase.from("whatsapp_message_log").insert({
      direction: args.direction,
      phone: args.phone,
      operator_name: args.operator_name ?? null,
      operator_id: args.operator_id ?? null,
      farm_id: args.farm_id ?? null,
      message_type: args.message_type ?? null,
      message_body: args.message_body ?? null,
      message_id: args.message_id ?? null,
      command_parsed: args.command_parsed ?? null,
      command_result: args.command_result ?? null,
      metadata: args.metadata ?? null,
      timestamp_meta: args.timestamp_meta ?? null,
      group_id: args.group_id ?? currentGroupId(),
      original_type: args.original_type ?? "text",
      audio_duration_seconds: args.audio_duration_seconds ?? null,
    });
  } catch (e) {
    console.error("logMessage err", e);
  }
}

// Remove frases promocionais/genéricas indesejadas das mensagens enviadas
// (ex.: sugestões de "Envie *ajuda*..." que vazam da IA ou de templates antigos).
function sanitizeOutgoingBody(s: string): string {
  if (!s) return s;
  let out = s;
  // Linhas/sentenças contendo "envie ... ajuda" ou "envie ajuda".
  out = out.replace(/(^|\n)[^\n]*envie\s+\*?ajuda\*?[^\n]*(?=\n|$)/gi, "$1");
  out = out.replace(/[^.\n]*envie\s+\*?ajuda\*?[^.\n]*\.?/gi, "");
  // Frases tipo "para ver o que posso fazer por você"
  out = out.replace(/[^.\n]*o\s+que\s+posso\s+fazer\s+por\s+voc[eê][^.\n]*\.?/gi, "");
  // Frases verbosas de templates antigos — remover globalmente.
  out = out.replace(/(^|\n)[^\n]*aten[çc][ãa]o!?\s*foi\s+detectado[^\n]*(?=\n|$)/gi, "$1");
  out = out.replace(/[^.\n]*aten[çc][ãa]o!?\s*foi\s+detectado[^.\n]*\.?/gi, "");
  out = out.replace(/(^|\n)[^\n]*registrado\s+em:[^\n]*(?=\n|$)/gi, "$1");
  out = out.replace(/[^.\n]*registrado\s+em:[^.\n]*\.?/gi, "");
  out = out.replace(/[^.\n]*verifique\s+o\s+equipamento\s+localmente[^.\n]*\.?/gi, "");
  out = out.replace(/[^.\n]*entre\s+em\s+contato\s+com\s+o\s+administrador[^.\n]*\.?/gi, "");
  // Normaliza espaços/linhas em branco múltiplas.
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

// Meta não aceita parâmetros de TEMPLATE com \n, \t ou mais de 4 espaços.
// Centralizado aqui para impedir broadcasts "aceitos" pelo código mas rejeitados pela API.
function sanitizeTplParam(s: string): string {
  return String(s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

function sanitizeTemplateComponents(components: any[]): any[] {
  return (components ?? []).map((component) => ({
    ...component,
    parameters: Array.isArray(component?.parameters)
      ? component.parameters.map((param: any) => (
        param?.type === "text"
          ? { ...param, text: sanitizeTplParam(String(param?.text ?? "")) }
          : param
      ))
      : component?.parameters,
  }));
}


async function sendWhatsAppText(
  to: string,
  body: string,
  farmId?: string | null,
  logExtra?: { command_parsed?: string | null; command_result?: string | null },
): Promise<boolean> {
  body = sanitizeOutgoingBody(body);
  recentOutgoingAttempt.set(normalizePhone(to), Date.now());
  try {
    const { api_token, phone_number_id } = await getWaCreds(farmId ?? undefined);
    // Se a mensagem foi originada de um grupo, responder no grupo (não no privado).
    const groupId = currentGroupId();
    const recipient = groupId ?? to;
    if (!api_token) {
      console.warn("WA: api_token ausente em whatsapp_config; reply ignorado");
      await logMessage({
        direction: "outgoing",
        phone: recipient,
        farm_id: farmId ?? null,
        message_type: "text",
        message_body: body,
        command_parsed: logExtra?.command_parsed ?? null,
        command_result: logExtra?.command_result ?? "error_no_token",
        group_id: groupId,
      });
      return false;
    }
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phone_number_id}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient,
        type: "text",
        text: { body },
      }),
    });
    let sentId: string | null = null;
    let resultLabel = logExtra?.command_result ?? "sent";
    if (!res.ok) {
      const t = await res.text();
      console.error("WA send falhou", res.status, t);
      resultLabel = `error_${res.status}`;
    } else {
      try {
        const j = await res.json();
        sentId = j?.messages?.[0]?.id ?? null;
      } catch (_) { /* ignore */ }
    }
    await logMessage({
      direction: "outgoing",
      phone: recipient,
      farm_id: farmId ?? null,
      message_type: "text",
      message_body: body,
      message_id: sentId,
      command_parsed: logExtra?.command_parsed ?? null,
      command_result: resultLabel,
      group_id: groupId,
    });
    if (res.ok) recentOutgoingSuccess.set(normalizePhone(to), Date.now());
    return res.ok;
  } catch (e) {
    console.error("WA send err", e);
    await logMessage({
      direction: "outgoing",
      phone: to,
      farm_id: farmId ?? null,
      message_type: "text",
      message_body: body,
      command_parsed: logExtra?.command_parsed ?? null,
      command_result: "error_exception",
      group_id: currentGroupId(),
    });
    return false;
  }
}

// Envia direto para o número informado, IGNORANDO qualquer contexto de grupo
// atual. Uso: notificações internas (ex.: LEAD COMERCIAL) que NUNCA podem cair
// no chat/grupo do cliente originador.
async function sendWhatsAppDirect(
  to: string,
  body: string,
  farmId?: string | null,
): Promise<boolean> {
  try {
    const cleanBody = sanitizeOutgoingBody(body);
    const { api_token, phone_number_id } = await getWaCreds(farmId ?? undefined);
    if (!api_token) {
      console.warn("[direct] api_token ausente; envio ignorado para", to);
      return false;
    }
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phone_number_id}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${api_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: normalizePhone(to),
        type: "text",
        text: { body: cleanBody },
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("[direct] send falhou", res.status, t);
      return false;
    }
    try {
      await logMessage({
        direction: "outgoing",
        phone: normalizePhone(to),
        farm_id: farmId ?? null,
        message_type: "text",
        message_body: cleanBody,
        command_parsed: "notificar_equipe",
        command_result: "sent_direct",
        group_id: null,
      });
    } catch (_e) { /* opcional */ }
    return true;
  } catch (e) {
    console.error("[direct] err", (e as Error).message);
    return false;
  }
}



// ─── WhatsApp Template Senders (24h window aware) ──────────────────────────
async function sendTemplateMessage(
  to: string,
  templateName: string,
  components: any[],
  farmId?: string | null,
  meta?: Record<string, unknown>,
): Promise<any> {
  try {
    const safeComponents = sanitizeTemplateComponents(components);
    const { api_token, phone_number_id } = await getWaCreds(farmId ?? undefined);
    if (!api_token) {
      console.warn(`[template] api_token ausente — ${templateName}`);
      return { error: "no_token" };
    }
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phone_number_id}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${api_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: { name: templateName, language: { code: "pt_BR" }, components: safeComponents },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data as any)?.error) {
      console.error(`[template] send failed [${templateName}] to ${to}`, JSON.stringify((data as any)?.error || data));
      await logMessage({
        direction: "outgoing", phone: to, farm_id: farmId ?? null,
        message_type: "template", message_body: `[template:${templateName}]`,
        command_result: `error_template_${(data as any)?.error?.code ?? res.status}`,
        metadata: { template: templateName, components: safeComponents, error: (data as any)?.error, ...(meta ?? {}) },
      });
      return data;
    }
    console.log(`[template] sent [${templateName}] to ${to}`);
    const sentId = (data as any)?.messages?.[0]?.id ?? null;
    await logMessage({
      direction: "outgoing", phone: to, farm_id: farmId ?? null,
      message_type: "template", message_body: `[template:${templateName}]`,
      message_id: sentId, command_result: "sent",
      metadata: { template: templateName, components: safeComponents, ...(meta ?? {}) },
    });
    return data;
  } catch (e) {
    console.error(`[template] exception [${templateName}]`, e);
    return { error: String(e) };
  }
}

function metaSendOk(result: any): boolean {
  return !!result && !result.error && Array.isArray(result.messages) && result.messages.length > 0;
}

async function sendAuthTemplate(to: string, code: string, farmId?: string | null): Promise<any> {
  return await sendTemplateMessage(to, "codigo_acesso2", [
    { type: "body", parameters: [{ type: "text", text: code }] },
    { type: "button", sub_type: "url", index: 0, parameters: [{ type: "text", text: code }] },
  ], farmId, { code_masked: true });
}

async function getOperatorLastMessageAt(phone: string): Promise<number> {
  try {
    const tail8 = normalizePhone(phone).slice(-8);
    const { data } = await supabase
      .from("whatsapp_operators")
      .select("last_message_at")
      .ilike("phone", `%${tail8}`)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const v = (data as any)?.last_message_at;
    return v ? new Date(v).getTime() : 0;
  } catch { return 0; }
}

async function sendProactiveMessage(
  to: string,
  templateName: string,
  templateParams: string[],
  freeTextVersion: string,
  farmId?: string | null,
): Promise<any> {
  const last = await getOperatorLastMessageAt(to);
  const within24h = last > 0 && (Date.now() - last) < 24 * 60 * 60 * 1000;
  const safeTemplateParams = templateParams.map((p) => sanitizeTplParam(p).slice(0, 1000));
  console.log("[broadcast] Template/texto:", within24h ? freeTextVersion : `[template:${templateName}] ${safeTemplateParams.join(" | ")}`);
  if (within24h) {
    const ok = await sendWhatsAppText(to, freeTextVersion, farmId ?? null);
    console.log("[broadcast] Enviando para:", to, "resultado:", ok ? "sent_text" : "failed_text");
    return { delivered: "text", ok, status: ok ? "sent_text" : "failed_text" };
  }
  const result = await sendTemplateMessage(to, templateName, [{
    type: "body",
    parameters: safeTemplateParams.map((p) => ({ type: "text", text: p })),
  }], farmId);
  const ok = metaSendOk(result);
  console.log("[broadcast] Enviando para:", to, "resultado:", ok ? "sent_template" : "failed_template", JSON.stringify(result));
  return { delivered: "template", ok, status: ok ? "sent_template" : "failed_template", result };
}

function fmtBahiaNow(): string {
  return new Date().toLocaleString("pt-BR", { timeZone: "America/Bahia", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}


function fmtHHMM(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Bahia",
  });
}

async function handleVerification(url: URL): Promise<Response> {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  let valid = token === DEFAULT_VERIFY_TOKEN;
  if (!valid && token) {
    const { data } = await supabase
      .from("whatsapp_config")
      .select("webhook_verify_token")
      .eq("webhook_verify_token", token)
      .limit(1);
    valid = !!(data && data.length > 0);
  }

  if (mode === "subscribe" && valid) {
    return new Response(challenge, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }
  return new Response("forbidden", { status: 403, headers: corsHeaders });
}

const HELP_MSG =
  `📋 *CENTRAL DE AJUDA — RENOV*\n\n` +
  `🔧 *CONTROLE DE BOMBAS:*\n` +
  `• "ligar poço 3" ou "dá partida no poço 3"\n` +
  `• "desligar bomba 1" ou "corta a bomba 1"\n` +
  `• "ligar poço 2 Terra Norte"\n\n` +
  `📊 *CONSULTAS:*\n` +
  `• "como está a fazenda [nome]" — visão geral\n` +
  `• "como está os níveis" — reservatórios\n` +
  `• "como está as bombas" — status ligado/desligado\n` +
  `• "bombas que estão offline"\n` +
  `• "quais estão no automático"\n` +
  `• "quem tá local / remoto"\n\n` +
  `🤖 *MODO AUTOMÁTICO:*\n` +
  `• "ativar automático [fazenda]"\n` +
  `• "desativar automático [fazenda]"\n` +
  `• "quais programações"\n\n` +
  `📞 *COMERCIAL:*\n` +
  `• "quero expandir o projeto"\n` +
  `• "quero falar com o comercial"\n\n` +
  `📸 *FOTOS:*\n` +
  `• Envie uma foto de um problema e descreva — a IA ajuda a diagnosticar\n\n` +
  `💡 *DICAS:*\n` +
  `• Pode escrever de forma natural, não precisa de comando exato\n` +
  `• Funciona com áudio também`;

// Exact-match negations (short tokens; avoid substring false positives).
const NEGATION_EXACT = new Set([
  "nao", "n", "nn", "no", "cancela", "cancelar", "cancelado", "negativo", "neg",
  "deixa", "esquece", "para", "pare", "❌", "👎",
]);
// Phrase-match negations (use substring on normalized text).
const NEGATION_PHRASES = [
  "nao quero", "deixa pra la", "deixa para la", "nao precisa", "nao manda",
  "cancela isso", "cancela esse", "cancela este",
];
function normalizeForMatch(text: string): string {
  return stripAccents((text || "").trim().toLowerCase())
    .replace(/[.!?,]+$/g, "")
    .replace(/\s+/g, " ");
}
function isNegationWord(text: string): boolean {
  const t = normalizeForMatch(text);
  if (!t) return false;
  if (NEGATION_EXACT.has(t)) return true;
  return NEGATION_PHRASES.some((p) => t === p || t.includes(p));
}

const HELP_TRIGGERS = /^(ajuda|help|comandos?|menu|\?|passo\s*a\s*passo|como\s+funciona|como\s+usar|como\s+opera[rn]?|me\s+ensina[r]?(?:\s+a\s+operar)?|tutorial|o\s+que\s+(?:eu\s+)?posso\s+fazer|o\s+que\s+voce\s+faz|o\s+que\s+vc\s+faz)[!?.\s]*$/;
const GREETING_RE = /^(?:(?:oi+|ola|alo|hello|hi|hey|opa|e\s*ai|eae|salve)(?:\s+(?:bom\s*dia|boa\s*tarde|boa\s*noite))?|bom\s*dia|boa\s*tarde|boa\s*noite)[!.\s]*$/;
const THANKS_RE = /^(obrigad[oa]|obg|valeu|vlw|tmj|thanks|thx|grat[oa])[!.\s]*$/;
const ACK_RE = /^(ok+|beleza|blz|certo|entendi|show|massa|legal|bom)[!.\s]*$/;
const QUESTION_RE = /^(como\s+funciona|o\s+que\s+voce\s+faz|o\s+que\s+vc\s+faz|quem\s+e\s+voce|quem\s+e\s+vc|help|info)[!?.\s]*$/;

function getBrazilGreeting(): "Bom dia" | "Boa tarde" | "Boa noite" {
  const hour = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  ).getHours();
  if (hour >= 5 && hour < 12) return "Bom dia";
  if (hour >= 12 && hour < 18) return "Boa tarde";
  return "Boa noite";
}

function firstName(fullName?: string | null): string {
  return (fullName || "").trim().split(/\s+/)[0] || "";
}

function smartFallbackMessage(text: string, operatorName?: string | null): string {
  const t = stripAccents((text || "").trim().toLowerCase());
  if (!t) return "👍";
  if (HELP_TRIGGERS.test(t)) return HELP_MSG;
  if (GREETING_RE.test(t)) {
    const greet = getBrazilGreeting();
    const fn = firstName(operatorName);
    return fn ? `${greet}, ${fn}! Como posso ajudar?` : `${greet}! Como posso ajudar?`;
  }
  if (THANKS_RE.test(t)) return "👍 Disponível!";
  if (QUESTION_RE.test(t)) return HELP_MSG;
  if (ACK_RE.test(t)) return "👍";
  return "Não entendi. Para comandos rápidos, envie: *status*, *níveis*, *ligar/desligar [equipamento]*, *ops* ou *ajuda*.";
}

const DAY_LABELS_PT: Record<string, string> = {
  seg: "Seg", ter: "Ter", qua: "Qua", qui: "Qui", sex: "Sex", sab: "Sáb", dom: "Dom",
  // compat: leituras legadas em inglês
  mon: "Seg", tue: "Ter", wed: "Qua", thu: "Qui", fri: "Sex", sat: "Sáb", sun: "Dom",
};
const WEEK_ORDER = ["seg", "ter", "qua", "qui", "sex", "sab", "dom"];
const LEGACY_EN_TO_PT: Record<string, string> = {
  mon: "seg", tue: "ter", wed: "qua", thu: "qui", fri: "sex", sat: "sab", sun: "dom",
};
function formatDays(days: string[]): string {
  const set = new Set((days ?? []).map((d) => {
    const k = String(d).toLowerCase();
    return LEGACY_EN_TO_PT[k] ?? k;
  }));
  if (set.size === 7) return "Todos os dias";
  if (WEEKDAY_CODES.every((d) => set.has(d)) && !set.has("sab") && !set.has("dom")) return "Seg-Sex";
  return WEEK_ORDER.filter((d) => set.has(d)).map((d) => DAY_LABELS_PT[d]).join(", ");
}

// Gera variantes para busca ILIKE no campo `name` do equipamento.
// Cobre singular/plural, com e sem acentos/cedilha — o ILIKE do Postgres é
// case-insensitive mas SENSÍVEL a acentos, então precisamos enviar as duas
// formas para casar nomes cadastrados como "Poço 02", "POCO 2", "Bomba 03".
function baseSearchVariants(base: string): string[] {
  const b = String(base ?? "").trim().toLowerCase();
  if (!b) return [];
  const map: Record<string, string[]> = {
    "poço":         ["poço", "poco"],
    "poco":         ["poço", "poco"],
    "bomba":        ["bomba"],
    "conjunto":     ["conjunto"],
    "booster":      ["booster"],
    "canal":        ["canal", "canais"],
    "canais":       ["canal", "canais"],
    "reservatorio": ["reservatório", "reservatorio"],
    "reservatório": ["reservatório", "reservatorio"],
    "recalque":     ["recalque"],
  };
  const out = map[b] ?? [b, stripAccents(b)];
  return Array.from(new Set(out.filter(Boolean)));
}

// Resolve equipamentos da fazenda casando base+números (mesmo critério dos ops).
async function resolveEquipmentsForBase(
  farmId: string,
  base: string,
  nums: number[],
): Promise<any[]> {
  const variants = baseSearchVariants(base);
  const seen = new Set<string>();
  const pool: any[] = [];
  for (const v of variants) {
    const { data } = await supabase
      .from("equipments")
      .select("id, name, farm_id")
      .eq("farm_id", farmId)
      .ilike("name", `%${v}%`)
      .limit(500);
    for (const r of (data ?? []) as any[]) {
      if (!seen.has(r.id)) { seen.add(r.id); pool.push(r); }
    }
  }
  if (nums.length === 0) return pool;
  return pool.filter((e) => {
    const ns = extractNumbers(e.name);
    return nums.some((n) => ns.includes(n));
  });
}


function computeEqState(eq: any): { estado: string; isOffline: boolean; inMaintenance: boolean } {
  const inMaintenance = eq?.maintenance_mode === true;
  const commStatus = String(eq.communication_status ?? "").toLowerCase();
  const lastCommMs = eq.last_communication ? new Date(eq.last_communication).getTime() : 0;
  const stale30m = lastCommMs > 0 && (Date.now() - lastCommMs) > 30 * 60 * 1000;
  const isOffline = commStatus === "offline" && stale30m;
  let estado: string;
  if (inMaintenance) estado = "MANUTENÇÃO 🔧";
  else if (isOffline) estado = "Offline ⚫";
  else if (eq.desired_running) estado = "Ligado ✅";
  else estado = "Desligado 🔴";
  return { estado, isOffline, inMaintenance };
}

function fmtMaintStarted(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "America/Bahia",
  }).replace(",", "");
}

function fmtMaintDuration(iso?: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

function maintenanceLockMessage(eq: any): string {
  const who = eq.maintenance_started_by ?? "—";
  const nameLower = String(eq.name ?? "equipamento").toLowerCase();
  return [
    `🔧 ${eq.name} está em MANUTENÇÃO — não é possível LIGAR.`,
    `Bloqueado por: ${who}`,
    `Para liberar: use 'Liberar' na página Manutenção ou envie 'liberar ${nameLower}' no WhatsApp.`,
  ].join("\n");
}

function originLabel(origin: string | null | undefined): string {
  const o = String(origin ?? "").toLowerCase();
  if (o === "local") return "Local 🔧";
  if (o === "remote") return "Remoto 📡";
  if (o === "schedule" || o === "automation") return "Automático 🤖";
  if (o === "whatsapp") return "WhatsApp 📱";
  return "—";
}

function fmtLastComm(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Bahia",
  }).replace(",", "");
}


// ──────────────────────────────────────────────────────────────────────────────
// Confirmação SIM/NÃO antes de executar liga/desliga.
// ──────────────────────────────────────────────────────────────────────────────
const CONFIRM_EXACT = new Set([
  "sim", "s", "si", "yes", "y", "ok", "okay", "k",
  "confirma", "confirmar", "confirmo", "confirmado",
  "pode", "manda", "vai", "bora", "beleza", "blz",
  "positivo", "afirmativo", "claro", "isso", "faz", "faca",
  "👍", "✅",
]);
const CONFIRM_PHRASES = [
  "sim por favor", "sim pode", "pode ser", "pode sim", "pode mandar", "pode fazer",
  "manda ver", "manda bala", "faz isso", "faca isso", "isso mesmo",
  "com certeza", "claro que sim", "ta bom", "tudo bem",
];
const PENDING_TTL_MS = 60 * 1000;

function isConfirmWord(text: string): boolean {
  const t = normalizeForMatch(text);
  if (!t) return false;
  if (CONFIRM_EXACT.has(t)) return true;
  return CONFIRM_PHRASES.some((p) => t === p || t.includes(p));
}

function describePending(p: any): string {
  const action = (p?.action_type === "liga" || p?.action_type === "post_maintenance_ligar") ? "LIGAR" : "DESLIGAR";
  const name = (p?.original_text || p?.equipment_name || "equipamento").replace(/^(ligar|desligar|liberar)\s+/i, "");
  return `${action} ${name}`;
}

async function fetchAllPending(phone: string) {
  const { data } = await supabase
    .from("whatsapp_pending_actions")
    .select("*")
    .eq("operator_phone", phone)
    .order("created_at", { ascending: false });
  return (data ?? []) as any[];
}

async function deleteAllPending(phone: string) {
  await supabase.from("whatsapp_pending_actions").delete().eq("operator_phone", phone);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATION STATE — bot lembra do que perguntou (qual fazenda/equip/etc).
// Estados comuns expiram em 5 minutos; aprovação administrativa expira em 30 minutos.
// ─────────────────────────────────────────────────────────────────────────────
const CONV_STATE_TTL_MS = 5 * 60 * 1000;
const APPROVAL_CONV_STATE_TTL_MS = 30 * 60 * 1000;
const VISIT_DATE_CONV_STATE_TTL_MS = 24 * 60 * 60 * 1000; // 24h para responder a data da visita

async function saveConvState(phone: string, awaiting: string, context: any) {
  await supabase
    .from("whatsapp_conversation_state")
    .upsert({ operator_phone: phone, awaiting, context, updated_at: new Date().toISOString() }, { onConflict: "operator_phone" });
}

async function getConvState(phone: string): Promise<{ awaiting: string; context: any } | null> {
  const { data } = await supabase
    .from("whatsapp_conversation_state")
    .select("*")
    .eq("operator_phone", phone)
    .maybeSingle();
  if (!data) return null;
  const ts = new Date(data.updated_at ?? data.created_at).getTime();
  const ttl = data.awaiting === "awaiting_approval"
    ? APPROVAL_CONV_STATE_TTL_MS
    : data.awaiting === "awaiting_visit_date"
      ? VISIT_DATE_CONV_STATE_TTL_MS
      : CONV_STATE_TTL_MS;
  if (Date.now() - ts > ttl) {
    await supabase.from("whatsapp_conversation_state").delete().eq("operator_phone", phone);
    return null;
  }
  let context = data.context ?? {};
  if (typeof context === "string") {
    try { context = JSON.parse(context); }
    catch (_e) { context = {}; }
  }
  return { awaiting: data.awaiting, context };
}

async function clearConvState(phone: string) {
  await supabase.from("whatsapp_conversation_state").delete().eq("operator_phone", phone);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAINTENANCE VISIT — fluxo de agendamento iniciado pelo relatório diário
// (offline-daily-report grava convState 'awaiting_visit_date' para o super_admin)
// ─────────────────────────────────────────────────────────────────────────────
function parseVisitDateBR(raw: string): { iso: string; label: string } | null {
  const t = stripAccents((raw || "").toLowerCase()).trim();
  if (!t) return null;
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const fmtLabel = (d: Date) => {
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${d.getUTCFullYear()}`;
  };
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  // hoje / amanhã / depois de amanhã
  if (/^hoje\b/.test(t)) return { iso: toIso(base), label: fmtLabel(base) };
  if (/^amanha\b/.test(t)) {
    const d = new Date(base); d.setUTCDate(d.getUTCDate() + 1);
    return { iso: toIso(d), label: fmtLabel(d) };
  }
  if (/^depois de amanha\b/.test(t)) {
    const d = new Date(base); d.setUTCDate(d.getUTCDate() + 2);
    return { iso: toIso(d), label: fmtLabel(d) };
  }
  // dias da semana (próximo)
  const weekdays: Record<string, number> = {
    domingo: 0, segunda: 1, "segunda-feira": 1, terca: 2, "terca-feira": 2,
    quarta: 3, "quarta-feira": 3, quinta: 4, "quinta-feira": 4,
    sexta: 5, "sexta-feira": 5, sabado: 6,
  };
  for (const [name, idx] of Object.entries(weekdays)) {
    if (new RegExp(`^${name}\\b`).test(t)) {
      const d = new Date(base);
      const cur = d.getUTCDay();
      let diff = (idx - cur + 7) % 7;
      if (diff === 0) diff = 7;
      d.setUTCDate(d.getUTCDate() + diff);
      return { iso: toIso(d), label: fmtLabel(d) };
    }
  }
  // dd/mm ou dd/mm/yyyy ou dd-mm
  const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    let yyyy = m[3] ? parseInt(m[3], 10) : now.getUTCFullYear();
    if (yyyy < 100) yyyy += 2000;
    if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (Number.isNaN(d.getTime())) return null;
    // se data sem ano e já passou, joga pro próximo ano
    if (!m[3] && d.getTime() < base.getTime()) d.setUTCFullYear(d.getUTCFullYear() + 1);
    return { iso: toIso(d), label: fmtLabel(d) };
  }
  return null;
}

async function handleMaintenanceVisitFlow(
  from: string, phone: string, op: any, text: string,
): Promise<boolean> {
  const raw = (text || "").trim();
  if (!raw) return false;
  const tNorm = stripAccents(raw.toLowerCase()).replace(/[.!?]+$/g, "").trim();

  // Comandos de reativação de alertas: cancela visitas pendentes do super_admin
  if (/^(reativar|reativa|continuar|retomar)\s+alertas?/.test(tNorm)
      || /^continuar alertando/.test(tNorm)) {
    if (!isSuperAdmin(op)) return false;
    const { data: pend } = await supabase
      .from("maintenance_visits")
      .select("id")
      .eq("status", "pending");
    if (pend && pend.length > 0) {
      await supabase
        .from("maintenance_visits")
        .update({ status: "cancelled" })
        .in("id", (pend as any[]).map((p) => p.id));
    }
    await clearConvState(phone);
    await sendWhatsAppText(
      from,
      `✅ Alertas diários de offline reativados. ${pend?.length ?? 0} visita(s) pendente(s) cancelada(s).`,
      op.farm_id ?? null,
    );
    return true;
  }

  const conv = await getConvState(phone);
  if (!conv || conv.awaiting !== "awaiting_visit_date") return false;
  if (!isSuperAdmin(op)) return false;

  // Escape 1: comandos explícitos de cancelamento encerram o fluxo.
  if (/^(cancelar|cancela|sair|abortar|encerrar|desistir|nao|não|no)\b/.test(tNorm)) {
    await clearConvState(phone);
    await sendWhatsAppText(
      from,
      `✅ Agendamento de visita cancelado. Se quiser retomar, aguarde o próximo relatório diário ou envie *reativar alertas*.`,
      op.farm_id ?? null,
    );
    return true;
  }

  const parsed = parseVisitDateBR(raw);
  if (!parsed) {
    // Escape 2: se a mensagem claramente não parece data (sem dígitos e sem
    // palavras temporais), o usuário mudou de assunto. Limpa o estado preso e
    // devolve controle ao roteador normal (return false) em vez de repetir
    // "não entendi a data" indefinidamente.
    const hasDigits = /\d/.test(tNorm);
    const hasDateWord = /\b(hoje|amanha|amanhã|depois|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\b/.test(tNorm);
    const looksLikeQuestion = tNorm.includes("?") || /\b(qual|quais|como|porque|por que|onde|quando|quem|melhor|pior|dica|ajuda|status|liga|desliga|ligar|desligar|manuten)\b/.test(tNorm);
    if (!hasDigits && !hasDateWord) {
      await clearConvState(phone);
      if (looksLikeQuestion) {
        // curto aviso e segue: o próximo turno já processa normal.
        await sendWhatsAppText(
          from,
          `ℹ️ Cancelei o agendamento de visita pendente para responder sua mensagem.`,
          op.farm_id ?? null,
        );
      }
      return false;
    }
    await sendWhatsAppText(
      from,
      `❓ Não entendi a data. Envie por exemplo: *30/06*, *amanhã*, *segunda*, *03/07/2026*.\n\nOu envie *cancelar* para encerrar.`,
      op.farm_id ?? null,
    );
    return true;
  }

  const groups = Array.isArray(conv.context?.groups) ? conv.context.groups : [];
  if (groups.length === 0) {
    await clearConvState(phone);
    await sendWhatsAppText(from, `⚠️ Contexto da visita expirou. Aguarde o próximo relatório diário.`, op.farm_id ?? null);
    return true;
  }

  // Para cada fazenda, registra a visita e notifica os gestores (admins/super_admins).
  const farmsNotified: Array<{ name: string; phones: string[] }> = [];
  for (const g of groups) {
    const farmId = String(g.farm_id || "");
    const farmName = String(g.farm_name || "Fazenda");
    const equipmentIds: string[] = Array.isArray(g.equipment_ids) ? g.equipment_ids : [];
    if (!farmId || equipmentIds.length === 0) continue;

    const { data: managers } = await supabase
      .from("whatsapp_operators")
      .select("phone, name, role")
      .eq("farm_id", farmId)
      .eq("is_active", true)
      .in("role", ["admin", "super_admin"]);

    const phones = Array.from(new Set(
      ((managers ?? []) as any[])
        .map((m) => String(m.phone || "").replace(/\D/g, ""))
        .filter((p) => p && p !== phone),
    ));

    const visitMsg =
      `📅 Visita técnica agendada para *${parsed.label}* para verificar os equipamentos offline na *${farmName}*.`;

    for (const to of phones) {
      try { await sendWhatsAppText(to, visitMsg, farmId); } catch (_e) { /* noop */ }
    }

    try {
      await supabase.from("maintenance_visits").insert({
        farm_id: farmId,
        equipment_ids: equipmentIds,
        scheduled_date: parsed.iso,
        status: "pending",
        notified_operators: phones,
        created_by_phone: phone,
        notified_at: new Date().toISOString(),
      });
    } catch (e) {
      console.error("[maintenance-visit] insert failed", e);
    }

    farmsNotified.push({ name: farmName, phones });
  }

  await clearConvState(phone);

  const totalPhones = farmsNotified.reduce((acc, f) => acc + f.phones.length, 0);
  const summary = farmsNotified.map((f) => `• ${f.name} (${f.phones.length} gestor${f.phones.length === 1 ? "" : "es"})`).join("\n");
  await sendWhatsAppText(
    from,
    `✅ Gestores notificados. Visita marcada para *${parsed.label}*.\n\n${summary}\n\nTotal: ${totalPhones} contato(s) avisado(s). Os alertas diários para esses equipamentos ficarão pausados até a data da visita. Envie *reativar alertas* para retomar antes.`,
    op.farm_id ?? null,
  );
  return true;
}


function matchFarmFromText(text: string, options: Array<{ id: string; name: string }>): { id: string; name: string } | null {
  const t = stripAccents((text || "").toLowerCase()).trim().replace(/[.!?]+$/g, "");
  if (!t) return null;
  // numeric selection (1..N)
  const numMatch = t.match(/^\d+$/);
  if (numMatch) {
    const idx = parseInt(numMatch[0], 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
  }
  const normOpts = options.map((o) => {
    const norm = stripAccents(String(o.name ?? "").toLowerCase());
    return { o, norm, compact: norm.replace(/^fazenda\s+/, "").trim() };
  });
  // exact compact match
  const exact = normOpts.find((x) => x.norm === t || x.compact === t);
  if (exact) return exact.o;
  // substring either way
  const partial = normOpts.find((x) =>
    (x.compact && (t.includes(x.compact) || x.compact.includes(t))) ||
    (x.norm && (t.includes(x.norm) || x.norm.includes(t)))
  );
  return partial?.o ?? null;
}

function findFarmMentionInText(text: string, farms: Array<{ id: string; name: string }>): { id: string; name: string } | null {
  const t = ` ${stripAccents((text || "").toLowerCase()).replace(/[.!?]+/g, " ").replace(/\s+/g, " ").trim()} `;
  if (!t.trim()) return null;
  const ranked = farms
    .map((farm) => {
      const norm = stripAccents(String(farm.name ?? "").toLowerCase()).replace(/\s+/g, " ").trim();
      const compact = norm.replace(/^fazenda\s+/, "").trim();
      return { farm, norm, compact, score: Math.max(norm.length, compact.length) };
    })
    .filter((x) => (x.norm && t.includes(` ${x.norm} `)) || (x.compact && t.includes(` ${x.compact} `)))
    .sort((a, b) => b.score - a.score);
  if (ranked[0]?.farm) return ranked[0].farm;

  // Tolerância para menções abreviadas no final do comando, ex.:
  // "desativar auto poco 03 sosse" deve resolver Fazenda Sossego e NÃO cair
  // silenciosamente na fazenda padrão do operador.
  const normOpts = farms.map((farm) => {
    const norm = stripAccents(String(farm.name ?? "").toLowerCase()).replace(/\s+/g, " ").trim();
    const compact = norm.replace(/^fazenda\s+/, "").trim();
    return { farm, norm, compact };
  });
  const words = t.trim().split(/\s+/).filter((w) => w.length >= 4);
  const prefixMatches = normOpts.filter((x) => {
    const farmWords = Array.from(new Set([...x.norm.split(/\s+/), ...x.compact.split(/\s+/)]))
      .filter((w) => w.length >= 4 && w !== "fazenda");
    return words.some((word) => farmWords.some((farmWord) => farmWord.startsWith(word)));
  });
  return prefixMatches.length === 1 ? prefixMatches[0].farm : null;
}

function escapeRegExp(s: string): string {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveEquipmentFromText(
  target: string,
  farmId: string,
): Promise<{ equipment: any | null; farm: { id: string; name: string } | null }> {
  const { data: farmRows } = await supabase
    .from("farms")
    .select("id, name")
    .order("name", { ascending: true });

  const farms = ((farmRows ?? []) as any[]).filter((f) => f?.id && f?.name) as Array<{ id: string; name: string }>;
  const mentionedFarm = findFarmMentionInText(target, farms);
  const defaultFarm = farms.find((f) => f.id === farmId) ?? null;
  const farm = mentionedFarm ?? defaultFarm;
  if (!farm) return { equipment: null, farm: null };

  let cleaned = String(target || "").trim();
  if (mentionedFarm) {
    const normName = stripAccents(String(mentionedFarm.name ?? "").toLowerCase()).replace(/^fazenda\s+/, "").trim();
    const rawName = String(mentionedFarm.name ?? "").replace(/^fazenda\s+/i, "").trim();
    const farmTerms = Array.from(new Set([
      mentionedFarm.name,
      rawName,
      normName,
      `fazenda ${rawName}`,
      `fazenda ${normName}`,
    ].filter(Boolean)));
    for (const term of farmTerms.sort((a, b) => b.length - a.length)) {
      cleaned = cleaned.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, "ig"), " ");
    }
  }
  cleaned = cleaned
    .replace(/\bfazenda\b/ig, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = stripAccents(cleaned.toLowerCase()).split(/[\s,;]+/).filter(Boolean);
  const filler = new Set(["o", "a", "os", "as", "do", "da", "de", "em", "no", "na", "para", "pra"]);
  const baseToks: string[] = [];
  const nums: number[] = [];
  for (const tk of tokens) {
    if (filler.has(tk)) continue;
    if (isNumTok(tk)) {
      pushNumTok(nums, tk);
      continue;
    }
    if (nums.length === 0) baseToks.push(tk);
  }

  let base = resolveBaseFromTokens(baseToks);
  if (!base) {
    const baseToken = tokens.find((tk) => BASE_ALIASES[tk]);
    base = baseToken ? BASE_ALIASES[baseToken] : null;
  }
  if (!base) return { equipment: null, farm };

  const matches = await resolveEquipmentsForBase(farm.id, base, nums);
  return { equipment: matches[0] ?? null, farm };
}

// ─────────────────────────────────────────────────────────────────────────────
// runFarmWideAutoMode — ativa/desativa o Modo Automático da FAZENDA inteira.
// Compartilhado por `handleAutoMode` (quando alvo é só o nome da fazenda) e
// pelo handler `global_auto`. Dispara a mesma notificação de mode_change usada
// pelo dashboard web (`whatsapp-automation-notify`) para que os operadores
// recebam a lista de "Programação:" / "Bombas que saíram do automático:".
// ─────────────────────────────────────────────────────────────────────────────
async function runFarmWideAutoMode(
  farm: { id: string; name: string },
  activate: boolean,
  phone: string,
  from: string,
  op: any,
): Promise<void> {
  if (!isSuperAdmin(op) && op.farm_id !== farm.id && op.default_farm_id !== farm.id) {
    await sendWhatsAppText(from, "🚫 Você não tem acesso a essa fazenda.", op?.farm_id ?? null);
    return;
  }
  const operatorName = op?.name ?? phone;
  console.log("[global_auto/whatsapp] toggling engine", { farm_id: farm.id, farm_name: farm.name, activate, by: operatorName });
  const { data: upsertData, error, status, count } = await supabase
    .from("automation_engine")
    .upsert(
      { farm_id: farm.id, enabled: activate, last_changed_by: operatorName, last_changed_via: "whatsapp" },
      { onConflict: "farm_id", count: "exact" },
    )
    .select("farm_id, enabled");
  console.log("[global_auto/whatsapp] upsert result", {
    farm_id: farm.id,
    activate,
    status,
    rows_affected: count ?? (upsertData?.length ?? 0),
    returned: upsertData,
    error: error?.message ?? null,
  });
  if (error) {
    console.error("[global_auto/whatsapp] upsert failed", error);
    await sendWhatsAppText(from, `❌ Não consegui alterar o modo automático da ${farm.name}: ${error.message}`, farm.id);
    return;
  }

  // Verificação: relê a coluna para confirmar que o valor foi persistido.
  const { data: verify, error: verifyErr } = await supabase
    .from("automation_engine")
    .select("enabled")
    .eq("farm_id", farm.id)
    .maybeSingle();
  console.log("[global_auto/whatsapp] verify select", {
    farm_id: farm.id,
    expected: activate,
    got: verify?.enabled ?? null,
    error: verifyErr?.message ?? null,
  });
  if (verifyErr || !verify || verify.enabled !== activate) {
    await sendWhatsAppText(
      from,
      `⚠️ Não consegui ${activate ? "ativar" : "desativar"} o modo automático. Tente pela plataforma.`,
      farm.id,
    );
    return;
  }

  const txt = activate
    ? `🤖 Modo Automático (${farm.name}) ATIVADO. Programações ativas serão executadas.`
    : `🔧 Modo Automático (${farm.name}) DESATIVADO. Bombas só respondem a controle manual.`;
  await sendWhatsAppText(from, txt, farm.id);

  // Dispara notificação formatada (Programação: / Bombas que saíram do automático:)
  try {
    const notifyUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/whatsapp-automation-notify`;
    // NÃO exclui o autor: a mensagem formatada (Programação: / Bombas que
    // saíram do automático:) serve como confirmação visual também para quem
    // executou a ação via WhatsApp.
    const payload = {
      type: "mode_change",
      farm_id: farm.id,
      farm_name: farm.name,
      new_mode: activate ? "on" : "off",
      changed_by: operatorName,
      source: `${operatorName}|whatsapp`,
      via: "whatsapp",
      immediate: true,
    };
    console.log("[global_auto/whatsapp] dispatching mode_change notify", { farm_id: farm.id, payload });
    fetch(notifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify(payload),
    }).then(async (r) => {
      const t = await r.text().catch(() => "");
      console.log("[global_auto/whatsapp] notify response", r.status, t.slice(0, 400));
    }).catch((e) => {
      console.error("[global_auto/whatsapp] notify dispatch failed", (e as Error).message);
    });
  } catch (e) {
    console.error("[global_auto/whatsapp] notify dispatch threw", (e as Error).message);
  }
}

async function handleAutoMode(
  target: string,
  activate: boolean,
  phone: string,
  farmId: string,
  from: string,
  op: any,
): Promise<void> {
  console.log("[auto_mode] deterministic handler", {
    target,
    activate,
    operator: op?.name ?? phone,
    defaultFarm: farmId,
  });
  const { equipment, farm } = await resolveEquipmentFromText(target, farmId);

  if (!farm) {
    await sendWhatsAppText(
      from,
      `❓ Não identifiquei a fazenda. Envie: ativar modo automatico [poço/bomba] [número] [fazenda]`,
      farmId,
    );
    return;
  }

  if (!equipment) {
    // Detecta se o alvo é apenas o nome da fazenda (sem menção a poço/bomba/etc)
    // → tratar como toggle da FAZENDA INTEIRA (mesmo caminho do handler global_auto).
    const targetTokens = stripAccents(String(target || "").toLowerCase())
      .replace(/[.,;!?]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const hasBaseAlias = targetTokens.some((tk) => !!BASE_ALIASES[tk]);
    if (!hasBaseAlias) {
      console.log("[auto_mode] farm-wide intent detected (no equipment base tokens)", { target, farm_id: farm.id });
      await runFarmWideAutoMode(farm, activate, phone, from, op);
      return;
    }

    // Fazenda conhecida mas usuário não disse qual equipamento — pergunta e salva contexto.
    await deleteAllPending(phone);
    await supabase.from("whatsapp_pending_actions").insert({
      operator_phone: phone,
      farm_id: farm.id,
      action_type: "auto_mode_select_equipment",
      operator_id: op?.id ?? null,
      original_text: JSON.stringify({ farm_id: farm.id, farm_name: farm.name, activate }),
    });
    await sendWhatsAppText(
      from,
      `❓ Qual equipamento deseja ${activate ? "ativar" : "desativar"} o modo automático? (ex: poço 03)`,
      farm.id,
    );
    return;
  }

  if (!isSuperAdmin(op) && op.farm_id !== farm.id && op.default_farm_id !== farm.id) {
    await sendWhatsAppText(from, "🚫 Você não tem acesso a essa fazenda.", farmId);
    return;
  }

  const operatorName = op.name ?? phone;
  const equipmentUpdatePayload = {
    auto_mode: activate,
    last_changed_by: operatorName,
    last_actuation_origin: "whatsapp",
    updated_at: new Date().toISOString(),
  };
  console.log("[auto_mode] SQL", {
    sql: "UPDATE public.equipments SET auto_mode = $1, last_changed_by = $2, last_actuation_origin = 'whatsapp', updated_at = $3 WHERE id = $4 AND farm_id = $5 RETURNING id, name, auto_mode, farm_id",
    params: [activate, operatorName, equipmentUpdatePayload.updated_at, equipment.id, farm.id],
  });
  const { data: updatedEquipment, error } = await supabase
    .from("equipments")
    .update(equipmentUpdatePayload)
    .eq("id", equipment.id)
    .eq("farm_id", farm.id)
    .select("id, name, auto_mode, farm_id")
    .maybeSingle();

  if (error) {
    console.error("[auto_mode] update failed", error);
    await sendWhatsAppText(from, `❌ Não consegui alterar o modo automático de ${equipment.name}: ${error.message}`, farm.id);
    return;
  }
  if (!updatedEquipment) {
    console.error("[auto_mode] update affected zero rows", { equipment_id: equipment.id, farm_id: farm.id, target, activate });
    await sendWhatsAppText(from, `❌ Não alterei o modo automático: equipamento não encontrado em ${farm.name}.`, farm.id);
    return;
  }
  if ((updatedEquipment as any).auto_mode !== activate) {
    console.error("[auto_mode] update verification failed", { updatedEquipment, expected_auto_mode: activate });
    await sendWhatsAppText(from, `❌ Não consegui confirmar a alteração do modo automático de ${equipment.name}.`, farm.id);
    return;
  }
  console.log("[auto_mode] equipments update result", updatedEquipment);

  // Sincronizar programações do equipamento: ao desativar auto_mode, desabilita
  // todas as automation_schedules ativas para que o toggle do card também caia.
  // Ao reativar, religa as que estavam previamente cadastradas.
  let affectedSchedules = 0;
  try {
    console.log("[auto_mode] SQL", {
      sql: "UPDATE public.automation_schedules SET active = $1, last_modified_by_name = $2, last_modified_by_via = 'whatsapp', last_toggled_by = $2, last_toggled_via = 'whatsapp' WHERE farm_id = $3 AND equipment_id = $4 AND active <> $1 RETURNING id",
      params: [activate, operatorName, farm.id, equipment.id],
    });
    const { data: schedRows, error: schedErr } = await supabase
      .from("automation_schedules")
      .update({
        active: activate,
        last_modified_by_name: operatorName,
        last_modified_by_via: "whatsapp",
        last_toggled_by: operatorName,
        last_toggled_via: "whatsapp",
      })
      .eq("farm_id", farm.id)
      .eq("equipment_id", equipment.id)
      .neq("active", activate)
      .select("id");
    if (schedErr) {
      console.error("[auto_mode] schedules sync failed", schedErr);
      await sendWhatsAppText(from, `⚠️ Modo automático alterado em ${equipment.name}, mas falhei ao sincronizar as programações: ${schedErr.message}`, farm.id);
      return;
    } else {
      affectedSchedules = schedRows?.length ?? 0;
      console.log("[auto_mode] automation_schedules update result", { affectedSchedules, ids: (schedRows ?? []).map((r: any) => r.id) });
    }
  } catch (e) {
    console.error("[auto_mode] schedules sync exception", e);
    await sendWhatsAppText(from, `⚠️ Modo automático alterado em ${equipment.name}, mas falhei ao sincronizar as programações.`, farm.id);
    return;
  }

  if (!activate) {
    const { count: stillActiveCount, error: verifySchedulesErr } = await supabase
      .from("automation_schedules")
      .select("id", { count: "exact", head: true })
      .eq("farm_id", farm.id)
      .eq("equipment_id", equipment.id)
      .eq("active", true);
    if (verifySchedulesErr) {
      console.error("[auto_mode] schedules verification failed", verifySchedulesErr);
      await sendWhatsAppText(from, `⚠️ Modo automático alterado em ${equipment.name}, mas não consegui confirmar as programações.`, farm.id);
      return;
    }
    if ((stillActiveCount ?? 0) > 0) {
      console.error("[auto_mode] schedules still active after disable", { equipment_id: equipment.id, farm_id: farm.id, stillActiveCount });
      await sendWhatsAppText(from, `❌ Modo automático alterado, mas ainda há ${stillActiveCount} programação(ões) ativa(s) para ${equipment.name}.`, farm.id);
      return;
    }
  }

  const status = activate ? "✅ ativado" : "❌ desativado";
  console.log("[auto_mode] updated", { equipment_id: equipment.id, equipment_name: equipment.name, farm_id: farm.id, activate, affectedSchedules, verified_auto_mode: (updatedEquipment as any).auto_mode });
  const schedSuffix = affectedSchedules > 0
    ? `\n${activate ? "▶️" : "⏸️"} ${affectedSchedules} programação(ões) ${activate ? "reativada(s)" : "desativada(s)"}`
    : "";
  await sendWhatsAppText(from, `🔄 Modo automático ${status} — ${equipment.name}\nFazenda: ${farm.name}${schedSuffix}`, farm.id);

  // ── Notifica TODOS operadores da fazenda (inclusive quem executou) ─────────
  // A mensagem formatada serve também como confirmação visual para o autor.
  try {
    const notifyUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/whatsapp-automation-notify`;
    const payload = {
      type: "mode_change",
      equipment_id: equipment.id,
      equipment_name: equipment.name,
      farm_id: farm.id,
      farm_name: farm.name,
      new_mode: activate ? "on" : "off",
      changed_by: operatorName,
      source: `${operatorName}|whatsapp`,
      via: "whatsapp",
      immediate: true,
    };
    console.log("[auto_mode] dispatching mode_change notify", { equipment_id: equipment.id, farm_id: farm.id, payload });
    // fire-and-forget
    fetch(notifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify(payload),
    }).then(async (r) => {
      const txt = await r.text().catch(() => "");
      console.log("[auto_mode] notify response", r.status, txt.slice(0, 400));
    }).catch((e) => {
      console.error("[auto_mode] notify dispatch failed", (e as Error).message);
    });
  } catch (e) {
    console.error("[auto_mode] notify dispatch threw", (e as Error).message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// dispatchMaintenanceNotify — fire-and-forget call to whatsapp-automation-notify
// notifying ALL active operators of the farm + super_admins (except the actor)
// that an equipment entered or left maintenance via WhatsApp.
// ─────────────────────────────────────────────────────────────────────────────
async function dispatchMaintenanceNotify(args: {
  equipments: { id: string; name: string }[];
  farmId: string;
  farmName?: string | null;
  action: "block" | "release";
  changedBy: string;
  actorPhone: string;
}) {
  if (!args.equipments?.length || !args.farmId) return;
  try {
    const notifyUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/whatsapp-automation-notify`;
    const excludeDigits = normalizePhone(args.actorPhone).replace(/\D/g, "");
    const results = await Promise.all(args.equipments.map(async (eq) => {
      const payload = {
        immediate: true,
        type: "maintenance_change",
        action: args.action,
        equipment_id: eq.id,
        equipment_name: eq.name,
        farm_id: args.farmId,
        farm_name: args.farmName ?? null,
        changed_by: args.changedBy,
        via: "whatsapp",
        exclude_phone: excludeDigits,
      };
      console.log("[maintenance] dispatching maintenance_change notify (immediate)", { equipment_id: eq.id, farm_id: args.farmId, action: args.action, exclude_phone: excludeDigits });
      try {
        const r = await fetch(notifyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify(payload),
        });
        const txt = await r.text().catch(() => "");
        console.log("[maintenance] notify response", r.status, txt.slice(0, 400));
        return { ok: r.ok, status: r.status, body: txt.slice(0, 400) };
      } catch (e) {
        console.error("[maintenance] notify dispatch failed", (e as Error).message);
        return { ok: false, error: (e as Error).message };
      }
    }));
    console.log("[maintenance] notify dispatch finished", JSON.stringify({ count: results.length, results }));
  } catch (e) {
    console.error("[maintenance] notify dispatch threw", (e as Error).message);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// handleMaintenanceCompleted — NOVA INTENÇÃO "manutencao_concluida"
// Disparada quando um super_admin/admin informa que a manutenção foi resolvida.
// Diferenças vs liberação simples:
//  1. Restrito a super_admin e admin.
//  2. Faz broadcast para TODOS os operadores ativos do sistema (não só fazenda).
//  3. Usa template `alerta_equipamento` com mensagem específica.
//  4. Quem enviou o comando NÃO recebe o broadcast.
// ─────────────────────────────────────────────────────────────────────────────
function isMaintenanceCompletedText(text: string): boolean {
  if (!text) return false;
  const s = stripAccents(text.toLowerCase()).replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  const COMPLETED_WORD = /(concluida|conclu[ií]da|finalizada|resolvida|terminada|feita|pronta|pronto|ok)/;
  // "manutencao concluida X" / "manutencao resolvida X" / etc.
  if (/^(?:manuten[;cç]?[aã]o|reparo)\s+(?:concluida|conclu[ií]da|finalizada|resolvida|terminada|feita|pronta|pronto|ok)(?:\s+|$)/.test(s)) return true;
  // "liberar X manutencao concluida"
  if (/(?:^|\s)(?:manuten[;cç]?[aã]o|reparo)\s+(?:concluida|conclu[ií]da|finalizada|resolvida|terminada|feita|pronta|pronto|ok)(?:\s|$)/.test(s) && /^(?:liberar|libera)\b/.test(s)) return true;
  // "X manutencao concluida" (no início qualquer outra palavra)
  if (/\s(?:manuten[;cç]?[aã]o|reparo)\s+(?:concluida|conclu[ií]da|finalizada|resolvida|terminada|feita|pronta|pronto|ok)\s*$/.test(s)) return true;
  // "X pronto/pronta/liberado/liberada"
  if (/\s(?:pronto|pronta|liberado|liberada)\s*$/.test(s) && !/^(?:liga|liga[r]?|desliga|desliga[r]?)\b/.test(s)) return true;
  // "equipamento pronto para operar"
  if (/\b(?:pronto|pronta)\s+(?:para|pra)\s+(?:operar|funcionar|trabalhar|usar|acionar)\b/.test(s)) return true;
  return false;
}

function extractEquipmentTargetFromCompleted(text: string): string {
  let s = stripAccents(text.toLowerCase()).replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  // Remove verbos/palavras de "concluída"
  s = s.replace(/\b(?:liberar|libera|manuten[;cç]?[aã]o|reparo|concluida|conclu[ií]da|finalizada|resolvida|terminada|feita|pronta|pronto|ok|para|pra|operar|funcionar|trabalhar|usar|acionar|equipamento)\b/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

async function handleMaintenanceCompleted(
  from: string,
  phone: string,
  op: any,
  text: string,
  farmIdHint: string | null,
): Promise<boolean> {
  const role = String(op?.role ?? "").toLowerCase();
  const allowed = role === "super_admin" || role === "admin" || op?.is_super_admin === true;
  if (!allowed) {
    await sendWhatsAppText(from, "🚫 Apenas administradores podem marcar manutenção como concluída.", farmIdHint);
    return true;
  }

  const target = extractEquipmentTargetFromCompleted(text);
  const { equipment, farm } = await resolveEquipmentFromText(target || text, farmIdHint || "");

  console.log("[maintenance_completed] resolve", {
    raw_text: text,
    target,
    resolved_equipment_id: equipment?.id ?? null,
    resolved_equipment_name: equipment?.name ?? null,
    resolved_farm_id: farm?.id ?? null,
    resolved_farm_name: farm?.name ?? null,
  });

  if (!farm) {
    await sendWhatsAppText(from, "❓ Não identifiquei a fazenda. Envie: 'manutenção concluída [poço/bomba] [número] [fazenda]'.", farmIdHint);
    return true;
  }
  if (!equipment) {
    await sendWhatsAppText(from, `❓ Não identifiquei o equipamento em ${farm.name}. Ex.: 'manutenção concluída poço 03 ${farm.name.toLowerCase()}'.`, farm.id);
    return true;
  }

  // Refetch maintenance_mode — resolveEquipmentsForBase só seleciona id/name/farm_id.
  const { data: eqFull } = await supabase
    .from("equipments")
    .select("id, name, maintenance_mode, farm_id")
    .eq("id", equipment.id)
    .maybeSingle();
  const currentMaintenance = (eqFull as any)?.maintenance_mode === true;
  console.log("[maintenance_completed] db state", {
    equipment_id: equipment.id,
    name: equipment.name,
    maintenance_mode: currentMaintenance,
    farm_id: (eqFull as any)?.farm_id ?? null,
  });

  if (!currentMaintenance) {
    await sendWhatsAppText(from, `ℹ️ ${equipment.name} não está em manutenção.`, farm.id);
    return true;
  }

  const actorName = op?.name ?? phone;
  const { error: upErr } = await supabase
    .from("equipments")
    .update({
      maintenance_mode: false,
      maintenance_reason: null,
      maintenance_started_at: null,
      maintenance_started_by: null,
      maintenance_started_via: null,
      last_changed_by: actorName,
      last_actuation_origin: "whatsapp",
    })
    .eq("id", equipment.id);
  if (upErr) {
    await sendWhatsAppText(from, `❌ Falha ao liberar manutenção: ${upErr.message}`, farm.id);
    return true;
  }

  try {
    await auditLog({
      event_type: "maintenance_completed",
      actor_phone: phone,
      actor_name: actorName,
      farm_id: farm.id,
      details: { equipment_id: equipment.id, equipment_name: equipment.name, via: "whatsapp", intent: "manutencao_concluida" },
    });
  } catch (_e) { /* noop */ }

  // Broadcast para TODOS os operadores ativos do sistema (exceto o autor)
  let broadcastSent = 0;
  let broadcastFailed = 0;
  let broadcastTotal = 0;
  try {
    const actorTail8 = normalizePhone(phone).replace(/\D/g, "").slice(-8);
    const { data: opsRows } = await supabase
      .from("whatsapp_operators")
      .select("id, phone, name, role, is_active, default_farm_id, farm_id, receive_alerts, notification_preference")
      .eq("is_active", true);

    const bodyMsg = [
      `✅ ${equipment.name} — Manutenção concluída`,
      farm.name,
      "",
      "Equipamento habilitado para acionamento remoto.",
      `Coloque a chave da bomba no AUTOMÁTICO e envie 'ligar ${equipment.name.toLowerCase()}' para acionar.`,
      "",
      `Liberado por: ${actorName}`,
    ].join("\n");

    const seenTails = new Set<string>();
    const recipients: { phone: string; farmIdForCreds: string | null }[] = [];
    const actorFarmId = farm.id;
    let sent = 0;
    let failed = 0;
    for (const row of ((opsRows ?? []) as any[])) {
      const ph = normalizePhone(row.phone ?? "");
      const digits = ph.replace(/\D/g, "");
      const tail8 = digits.slice(-8);
      if (!tail8 || tail8 === actorTail8) continue;
      const isSuper = String(row.role ?? "").toLowerCase() === "super_admin";
      const belongsToFarm = row.farm_id === actorFarmId || row.default_farm_id === actorFarmId;
      if (!isSuper && !belongsToFarm) continue;
      const pref = String(row.notification_preference ?? "default").toLowerCase();
      if (pref === "mute" || pref === "mudo") continue;
      if (!isSuper && row.receive_alerts === false) continue;
      if (seenTails.has(tail8)) continue;
      seenTails.add(tail8);
      recipients.push({ phone: digits, farmIdForCreds: row.default_farm_id ?? row.farm_id ?? farm.id });
    }
    console.log("[broadcast] Destinatários:", recipients.map((r) => r.phone));
    console.log("[broadcast] Template/texto:", bodyMsg);
    broadcastTotal = recipients.length;
    for (const recipient of recipients) {
      const dest = recipient.phone;
      const farmIdForCreds = recipient.farmIdForCreds;
      try {
        const result = await sendProactiveMessage(
          dest,
          "alerta_equipamento",
          [bodyMsg],
          bodyMsg,
          farmIdForCreds,
        );
        if (result?.ok || metaSendOk(result)) sent++;
        else failed++;
        console.log("[broadcast] Enviando para:", dest, "resultado:", result?.status ?? JSON.stringify(result));
      } catch (e) {
        failed++;
        console.error("[maintenance_completed] broadcast failed", dest, (e as Error).message);
      }
    }
    broadcastSent = sent;
    broadcastFailed = failed;
    console.log(`[maintenance_completed] broadcast finished sent=${sent} failed=${failed} operators=${recipients.length} (excl. actor)`);
  } catch (e) {
    broadcastFailed = Math.max(broadcastFailed, broadcastTotal - broadcastSent);
    console.error("[maintenance_completed] broadcast threw", (e as Error).message);
  }

  const broadcastLine = broadcastSent > 0
    ? `Broadcast enviado para ${broadcastSent} operador(es).${broadcastFailed > 0 ? ` Falhou para ${broadcastFailed}.` : ""}`
    : `⚠️ Broadcast não foi entregue. Verifique logs [broadcast]/[template].`;
  await sendWhatsAppText(
    from,
    `✅ ${equipment.name} — Manutenção concluída.\n${farm.name}\n\n${broadcastLine}`,
    farm.id,
  );

  return true;
}



async function handleDefaultFarmCommand(from: string, phone: string, op: any, text: string): Promise<boolean> {
  if (!isSuperAdmin(op)) return false;
  const raw = (text || "").trim();
  const norm = stripAccents(raw.toLowerCase()).replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  const match = norm.match(/^(?:mudar|alterar|trocar|definir|setar)\s+(?:a\s+)?fazenda\s+padrao\s+(?:para|pra)\s+(.+)$/)
    ?? norm.match(/^fazenda\s+padrao\s*[:=]\s*(.+)$/)
    ?? norm.match(/^fazenda\s+padrao\s+(?:para|pra)\s+(.+)$/);
  if (!match) return false;

  const query = match[1]?.trim();
  if (!query) {
    await sendWhatsAppText(from, "Me diga qual fazenda deve ficar como padrão.", op.farm_id ?? null);
    return true;
  }

  const { data: farmRows } = await supabase
    .from("farms")
    .select("id, name")
    .order("name", { ascending: true });
  const farms = ((farmRows ?? []) as any[]).filter((f) => f?.id && f?.name);
  const picked = matchFarmFromText(query, farms);
  if (!picked) {
    await sendWhatsAppText(from, `Não encontrei fazenda com "${query}".`, op.farm_id ?? null);
    return true;
  }

  const incomingTail8 = normalizePhone(phone).slice(-8);
  const { data: superRows } = await supabase
    .from("whatsapp_operators")
    .select("id, phone, role, is_active")
    .eq("role", "super_admin")
    .eq("is_active", true);
  const ids = ((superRows ?? []) as any[])
    .filter((row) => normalizePhone(row.phone ?? "").slice(-8) === incomingTail8)
    .map((row) => row.id)
    .filter(Boolean);
  const targetIds = ids.length ? ids : [op.id].filter(Boolean);
  if (targetIds.length === 0) {
    await sendWhatsAppText(from, "Não consegui localizar seu cadastro para salvar a fazenda padrão.", op.farm_id ?? null);
    return true;
  }

  const { error } = await supabase
    .from("whatsapp_operators")
    .update({ default_farm_id: picked.id })
    .in("id", targetIds);
  if (error) {
    await sendWhatsAppText(from, `Não consegui salvar a fazenda padrão: ${error.message}`, op.farm_id ?? null);
    return true;
  }

  op.default_farm_id = picked.id;
  await sendWhatsAppText(from, `✅ Fazenda padrão definida como *${picked.name}*. Agora "Status" vai abrir essa fazenda direto.`, picked.id);
  return true;
}


// ─────────────────────────────────────────────────────────────────────────────
// REGISTRATION FLOW (self-signup with approval)
// ─────────────────────────────────────────────────────────────────────────────
const APPROVER_ROLES = new Set(["super_admin", "manager", "approver"]);
const MANAGER_ROLES = new Set(["super_admin", "manager"]);

// ─── Super admin bypass: dono do sistema tem TODAS permissões, sempre ──
function isSuperAdmin(op: any): boolean {
  if (!op) return false;
  return op.role === "super_admin" || op.is_super_admin === true;
}
function getEffectivePermissions(op: any) {
  if (isSuperAdmin(op)) {
    return {
      audio_enabled: true,
      ai_enabled: true,
      can_control: true,
      can_schedule: true,
      alerts_enabled: true,
      receive_alerts: true,
    };
  }
  return {
    audio_enabled: op?.audio_enabled ?? false,
    ai_enabled: op?.ai_enabled ?? false,
    can_control: op?.can_control !== false,
    can_schedule: op?.can_schedule !== false,
    alerts_enabled: op?.alerts_enabled !== false,
    receive_alerts: op?.receive_alerts !== false,
  };
}

async function auditLog(args: {
  event_type: string;
  actor_phone?: string | null;
  actor_name?: string | null;
  target_phone?: string | null;
  target_name?: string | null;
  farm_id?: string | null;
  details?: Record<string, unknown> | null;
}) {
  try {
    await supabase.from("whatsapp_audit_log").insert({
      event_type: args.event_type,
      actor_phone: args.actor_phone ?? null,
      actor_name: args.actor_name ?? null,
      target_phone: args.target_phone ?? null,
      target_name: args.target_name ?? null,
      farm_id: args.farm_id ?? null,
      details: args.details ?? null,
    });
  } catch (e) {
    console.error("audit log err", e);
  }
}

async function countRecentFailedAttempts(phone: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("whatsapp_failed_attempts")
    .select("id", { count: "exact", head: true })
    .eq("phone", phone)
    .gte("created_at", since);
  return count ?? 0;
}

async function handleRegistrationFlow(
  from: string,
  phone: string,
  text: string,
  location: WaLocation,
) {
  const msg = (text || "").trim();

  // Find existing request (most recent)
  const { data: reqRows } = await supabase
    .from("whatsapp_registration_requests")
    .select("*")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(1);
  const req: any | null = (reqRows ?? [])[0] ?? null;

  // pending_approval / rejected → respond status
  if (req?.status === "pending_approval") {
    await sendWhatsAppText(from, "⏳ Sua solicitação está em análise. Você será notificado quando for aprovada.");
    return;
  }
  if (req?.status === "rejected") {
    await sendWhatsAppText(from, "❌ Sua solicitação não foi aprovada. Entre em contato com o gestor da sua fazenda para mais informações.");
    return;
  }

  // approved is unreachable here (would be active operator), but be safe
  if (req?.status === "approved") return;

  // No request → first contact
  if (!req) {
    const fails = await countRecentFailedAttempts(phone);
    if (fails >= 3) {
      await sendWhatsAppText(from, "🚫 Número temporariamente bloqueado. Tente novamente em 24 horas.");
      return;
    }
    // Se já existe um código ativo direcionado a este número, NÃO envie saudação
    // (o código já foi entregue com instruções completas). Apenas inicia o estado
    // silenciosamente para aguardar o código/dados.
    const reqTail8 = normalizePhone(phone).slice(-8);
    const { data: activeForPhone } = await supabase
      .from("registration_codes")
      .select("target_phone, expires_at, status")
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString());
    const hasActiveForMe = (activeForPhone ?? []).some((r: any) =>
      String(r.target_phone ?? "").replace(/\D/g, "").slice(-8) === reqTail8
    );

    await supabase.from("whatsapp_registration_requests").insert({
      phone, step: 0, status: "pending_info",
    });

    if (hasActiveForMe) {
      // Silencioso: o código já foi enviado com o passo a passo completo.
      return;
    }

    await sendWhatsAppText(
      from,
      `${getBrazilGreeting()}! 👋 Eu sou o assistente virtual do *Gestor de Bombas* — Renov Tecnologia Agrícola.\n\n` +
      "Através de mim você pode controlar e monitorar os equipamentos da sua fazenda diretamente pelo WhatsApp.\n\n" +
      "🔐 Para liberar seu acesso, informe o *código de convite* da sua fazenda.\n" +
      "_(Solicite o código ao gestor responsável)_\n\n" +
      "━━━━━━━━━━━━━━━\n" +
      "📞 Se você está buscando atendimento sobre *outros assuntos*, entre em contato com nosso Administrativo:\n" +
      "📱 (77) 98150-3951\n" +
      "━━━━━━━━━━━━━━━\n\n" +
      "_Este canal é exclusivo para operação remota de equipamentos._",
    );
    return;
  }

  // step=0 → waiting for invite code
  if (req.step === 0 && req.status === "pending_info") {
    if (!msg) {
      await sendWhatsAppText(from, "Por favor, envie o *código de convite* da sua fazenda.");
      return;
    }
    // Detect non-system inquiries (wrong number / commercial / support)
    const lowered = stripAccents(msg.toLowerCase());
    const nonSystemKeywords = ["nota", "boleto", "orcamento", "preco", "valor", "comprar", "visita", "tecnico", "manutencao", "problema", "defeito", "quebrou", "conserto"];
    const looksNonSystem = msg.length > 20 && nonSystemKeywords.some((k) => lowered.includes(k));
    if (looksNonSystem) {
      await sendWhatsAppText(
        from,
        "Esse canal é exclusivo para *operação remota de equipamentos*.\n\n" +
        "Para assuntos administrativos, comerciais ou suporte técnico, entre em contato com:\n\n" +
        "📱 *Renov Administrativo*\n\n" +
        "(77) 98150-3951\n\n" +
        "Se você tem um código de convite para acesso ao sistema, envie-o aqui.",
      );
      return;
    }
    const codeTry = msg.toUpperCase().replace(/\s+/g, "");
    const { data: codeRow } = await supabase
      .from("whatsapp_invite_codes")
      .select("*, farms:farm_id(id, name)")
      .eq("code", codeTry)
      .eq("is_active", true)
      .maybeSingle();
    const expired = codeRow?.expires_at && new Date(codeRow.expires_at).getTime() < Date.now();
    const exhausted = codeRow && (codeRow.current_uses ?? 0) >= (codeRow.max_uses ?? 0);
    if (!codeRow || expired || exhausted) {
      await supabase.from("whatsapp_failed_attempts").insert({
        phone, attempt_type: "invite_code", attempted_value: codeTry.slice(0, 32),
      });
      await auditLog({ event_type: "failed_code_attempt", actor_phone: phone, details: { code: codeTry.slice(0, 32) } });
      const fails = await countRecentFailedAttempts(phone);
      if (fails >= 3) {
        await sendWhatsAppText(from, "🚫 Número bloqueado por 24h por tentativas inválidas.");
      } else {
        await sendWhatsAppText(from, "❌ Código inválido. Verifique com o gestor da sua fazenda e tente novamente.");
      }
      return;
    }
    const farmId = codeRow.farm_id as string;
    const farmName = (codeRow as any).farms?.name ?? "sua fazenda";
    await supabase.from("whatsapp_registration_requests").update({
      farm_id: farmId,
      invite_code_used: codeTry,
      step: 1,
    }).eq("id", req.id);
    await supabase.from("whatsapp_invite_codes")
      .update({ current_uses: (codeRow.current_uses ?? 0) + 1 })
      .eq("id", codeRow.id);
    await auditLog({
      event_type: "registration_started",
      actor_phone: phone,
      farm_id: farmId,
      details: { code: codeTry },
    });
    await sendWhatsAppText(from, `✅ Código válido! Fazenda: *${farmName}*\n\nQual seu *nome completo*?`);
    return;
  }

  // step=1 → waiting for name
  if (req.step === 1) {
    if (!msg || msg.length < 2) {
      await sendWhatsAppText(from, "Por favor, informe seu *nome completo*.");
      return;
    }
    await supabase.from("whatsapp_registration_requests").update({
      name: msg.slice(0, 120), step: 2,
    }).eq("id", req.id);
    await sendWhatsAppText(from, "Qual sua *função*? (Ex: Operador, Gerente, Técnico, Eletricista)");
    return;
  }

  // step=2 → waiting for role
  if (req.step === 2) {
    if (!msg) {
      await sendWhatsAppText(from, "Por favor, informe sua *função*.");
      return;
    }
    await supabase.from("whatsapp_registration_requests").update({
      role_provided: msg.slice(0, 60), step: 3,
    }).eq("id", req.id);
    await sendWhatsAppText(
      from,
      "📍 Para segurança do sistema e da fazenda, precisamos registrar sua localização no momento do cadastro.\n\n" +
      "Isso é usado *apenas* para auditoria de acesso conforme LGPD (Lei 13.709/2018).\n\n" +
      "*Compartilhe sua localização* usando o botão de anexo 📎 → Localização → Enviar localização atual.\n\n" +
      "(Se preferir não compartilhar, digite PULAR)",
    );
    return;
  }

  // step=3 → waiting for location
  if (req.step === 3) {
    let updated = false;
    if (location) {
      const locText = [location.name, location.address].filter(Boolean).join(" · ") || null;
      await supabase.from("whatsapp_registration_requests").update({
        registration_lat: location.lat,
        registration_lng: location.lng,
        registration_location_text: locText,
        location_skipped: false,
        consent_given: true,
        step: 4,
      }).eq("id", req.id);
      updated = true;
    } else if (msg && /^pular$/i.test(msg.trim())) {
      await supabase.from("whatsapp_registration_requests").update({
        location_skipped: true,
        consent_given: true,
        step: 4,
      }).eq("id", req.id);
      updated = true;
    } else {
      await sendWhatsAppText(from, "Por favor, compartilhe sua localização pelo botão 📎 → Localização, ou digite PULAR.");
      return;
    }
    if (updated) {
      await finalizeRegistration(from, phone, req.id);
    }
    return;
  }

  // step=4 (shouldn't normally hit — finalize would have moved to pending_approval)
  if (req.step >= 4 && req.status === "pending_info") {
    await finalizeRegistration(from, phone, req.id);
    return;
  }
}

async function finalizeRegistration(from: string, phone: string, reqId: string) {
  // Reload row with latest data
  const { data: req } = await supabase
    .from("whatsapp_registration_requests")
    .select("*, farms:farm_id(id, name)")
    .eq("id", reqId)
    .maybeSingle();
  if (!req) return;

  await supabase.from("whatsapp_registration_requests")
    .update({ status: "pending_approval" })
    .eq("id", reqId);

  const farmName = (req as any).farms?.name ?? "—";
  const locStr = req.registration_lat != null && req.registration_lng != null
    ? `${Number(req.registration_lat).toFixed(5)}, ${Number(req.registration_lng).toFixed(5)}`
    : (req.location_skipped ? "Não informada" : "Não informada");

  await sendWhatsAppText(
    from,
    [
      "✅ Solicitação enviada com sucesso!",
      "",
      "*Resumo:*",
      `• Nome: ${req.name ?? "—"}`,
      `• Fazenda: ${farmName}`,
      `• Função: ${req.role_provided ?? "—"}`,
      `• Localização: ${req.registration_lat != null ? "registrada" : "não informada"}`,
      "",
      "Você receberá uma mensagem quando seu acesso for liberado. ⏳",
    ].join("\n"),
  );

  // Notify approvers
  const { data: approvers } = await supabase
    .from("whatsapp_operators")
    .select("phone, role, is_approver, farm_id, name")
    .eq("is_active", true);
  const targets = (approvers ?? []).filter((a: any) => {
    if (!APPROVER_ROLES.has(a.role) && !a.is_approver) return false;
    if (a.role === "super_admin") return true;
    return a.farm_id === req.farm_id;
  });

  const dateStr = new Date().toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "America/Bahia",
  }).replace(",", "");

  const notifyBody = [
    "🔔 *NOVA SOLICITAÇÃO DE ACESSO*",
    "",
    `• Nome: ${req.name ?? "—"}`,
    `• Telefone: +${phone}`,
    `• Fazenda: ${farmName}`,
    `• Função: ${req.role_provided ?? "—"}`,
    `• Localização: ${locStr}`,
    `• Data: ${dateStr}`,
    "",
    "Responda *aprovar* ou *rejeitar*.",
  ].join("\n");

  for (const a of targets) {
    const aPhone = normalizePhone(a.phone ?? "");
    if (!aPhone) continue;
    const approvalContext = {
      target_phone: phone,
      operator_phone: phone,
      request_id: req.id,
      full_name: req.name ?? `Operador ${phone.slice(-4)}`,
      operator_name: req.name ?? `Operador ${phone.slice(-4)}`,
      location: req.registration_location_text ?? null,
      farm_id: req.farm_id,
      farm_name: farmName,
      code: req.invite_code_used ?? null,
    };
    await saveConvState(aPhone, "awaiting_approval", approvalContext);
    await sendWhatsAppText(aPhone, notifyBody, req.farm_id ?? undefined);
  }

  await auditLog({
    event_type: "registration_completed",
    actor_phone: phone,
    actor_name: req.name,
    farm_id: req.farm_id,
    details: {
      role_provided: req.role_provided,
      invite_code_used: req.invite_code_used,
      has_location: req.registration_lat != null,
      approvers_notified: targets.length,
    },
  });
}

function genInviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 8; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

async function handleApproverCommands(
  from: string,
  phone: string,
  op: any,
  text: string,
): Promise<boolean> {
  const raw = (text || "").trim();
  if (!raw) return false;
  const lower = stripAccents(raw.toLowerCase());

  const isApprover = APPROVER_ROLES.has(op.role) || op.is_approver === true;
  const isManager = MANAGER_ROLES.has(op.role);
  const isSuper = op.role === "super_admin";

  // APROVAR / REJEITAR <digits>
  const mApprove = lower.match(/^(aprovar|aprova|aprovado)\s+(\d{6,15})$/);
  const mReject = lower.match(/^(rejeitar|rejeita|negar|nega)\s+(\d{6,15})$/);
  if (mApprove || mReject) {
    const approve = !!mApprove;
    const digits = (mApprove ?? mReject)![2];
    const tail = digits.slice(-8);

    if (!isApprover) {
      await sendWhatsAppText(from, "⚠️ Você não tem permissão para aprovar acessos.", op.farm_id);
      return true;
    }

    // Find pending request by phone tail
    const { data: reqs } = await supabase
      .from("whatsapp_registration_requests")
      .select("*, farms:farm_id(id, name)")
      .eq("status", "pending_approval")
      .order("created_at", { ascending: false })
      .limit(50);
    const req: any = (reqs ?? []).find((r: any) => normalizePhone(r.phone).slice(-8) === tail);
    if (!req) {
      await sendWhatsAppText(from, "Nenhuma solicitação pendente para esse número.", op.farm_id);
      return true;
    }

    if (!isSuper && req.farm_id && op.farm_id && req.farm_id !== op.farm_id) {
      await sendWhatsAppText(from, "⚠️ Essa solicitação é de outra fazenda.", op.farm_id);
      return true;
    }

    const reqPhone = normalizePhone(req.phone);

    if (approve) {
      // Re-activate previously revoked operator (same phone tail) instead of duplicating
      const tail8 = reqPhone.slice(-8);
      const { data: existingOps } = await supabase
        .from("whatsapp_operators")
        .select("id, phone, is_active");
      const existing = (existingOps ?? []).find((o: any) => normalizePhone(o.phone ?? "").slice(-8) === tail8);

      const opPayload: Record<string, unknown> = {
        phone: req.phone.startsWith("+") ? req.phone : `+${reqPhone}`,
        name: req.name ?? `Operador ${reqPhone.slice(-4)}`,
        farm_id: req.farm_id,
        role: "operator",
        is_active: true,
        approval_status: "approved",
        can_turn_on: true,
        can_turn_off: true,
        can_check_status: true,
        receive_alerts: true,
        approved_by_phone: phone,
        approved_at: new Date().toISOString(),
        registration_lat: req.registration_lat,
        registration_lng: req.registration_lng,
        registration_location_text: req.registration_location_text,
      };

      const { error: insErr } = existing
        ? await supabase.from("whatsapp_operators").update(opPayload).eq("id", existing.id)
        : await supabase.from("whatsapp_operators").insert(opPayload);
      if (insErr) {
        console.error("WA approve insert err", insErr);
        await sendWhatsAppText(from, `❌ Falha ao liberar acesso. Tente novamente.`, op.farm_id);
        return true;
      }
      await supabase.from("whatsapp_registration_requests").update({
        status: "approved",
        reviewed_by: phone,
        reviewed_at: new Date().toISOString(),
      }).eq("id", req.id);

      await auditLog({
        event_type: "registration_approved",
        actor_phone: phone,
        actor_name: op.name,
        target_phone: reqPhone,
        target_name: req.name,
        farm_id: req.farm_id,
        details: { role_provided: req.role_provided },
      });

      await sendWhatsAppText(
        reqPhone,
        "✅ Seu acesso ao *Gestor de Bombas* foi liberado! Se precisar de algo, é só me chamar — pode falar naturalmente.",
        req.farm_id,
      );
      await sendWhatsAppText(from, `✅ Acesso liberado para ${req.name ?? reqPhone} (+${reqPhone}).`, op.farm_id);
      return true;
    } else {
      await supabase.from("whatsapp_registration_requests").update({
        status: "rejected",
        reviewed_by: phone,
        reviewed_at: new Date().toISOString(),
      }).eq("id", req.id);

      await auditLog({
        event_type: "registration_rejected",
        actor_phone: phone,
        actor_name: op.name,
        target_phone: reqPhone,
        target_name: req.name,
        farm_id: req.farm_id,
      });

      await sendWhatsAppText(
        reqPhone,
        "Infelizmente sua solicitação de acesso não foi aprovada no momento. Entre em contato com o gestor da fazenda para mais informações.",
        req.farm_id,
      );
      await sendWhatsAppText(from, `❌ Acesso negado para ${req.name ?? reqPhone}.`, op.farm_id);
      return true;
    }
  }

  // REVOGAR <digits>
  const mRevoke = lower.match(/^(revogar|revoga|desativar|desativa)\s+(\d{6,15})$/);
  if (mRevoke) {
    if (!isManager) {
      await sendWhatsAppText(from, "⚠️ Apenas gestores podem revogar acessos.", op.farm_id);
      return true;
    }
    const tail = mRevoke[2].slice(-8);
    const { data: ops } = await supabase
      .from("whatsapp_operators").select("*").eq("is_active", true);
    const target: any = (ops ?? []).find((o: any) => normalizePhone(o.phone).slice(-8) === tail);
    if (!target) {
      await sendWhatsAppText(from, "Operador não encontrado.", op.farm_id);
      return true;
    }
    if (!isSuper && target.farm_id !== op.farm_id) {
      await sendWhatsAppText(from, "⚠️ Operador é de outra fazenda.", op.farm_id);
      return true;
    }
    await supabase.from("whatsapp_operators").update({
      is_active: false,
      deactivated_at: new Date().toISOString(),
      deactivated_by: phone,
    }).eq("id", target.id);
    await auditLog({
      event_type: "access_revoked",
      actor_phone: phone,
      actor_name: op.name,
      target_phone: normalizePhone(target.phone),
      target_name: target.name,
      farm_id: target.farm_id,
    });
    await sendWhatsAppText(from, `🚫 Acesso revogado para ${target.name}. Efeito imediato.`, op.farm_id);
    return true;
  }

  // GERAR CODIGO
  if (/^(codigo|gerar\s+codigo|novo\s+codigo)$/.test(lower)) {
    if (!isManager) {
      await sendWhatsAppText(from, "⚠️ Apenas gestores podem gerar códigos de convite.", op.farm_id);
      return true;
    }
    if (!op.farm_id) {
      await sendWhatsAppText(from, "⚠️ Operador sem fazenda vinculada.", null);
      return true;
    }
    const code = genInviteCode();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase.from("whatsapp_invite_codes").insert({
      farm_id: op.farm_id, code, created_by: phone,
      expires_at: expiresAt, max_uses: 50, current_uses: 0, is_active: true,
    });
    if (error) {
      await sendWhatsAppText(from, `❌ Falha ao gerar código: ${error.message}`, op.farm_id);
      return true;
    }
    await auditLog({
      event_type: "invite_code_created",
      actor_phone: phone, actor_name: op.name,
      farm_id: op.farm_id, details: { code, expires_at: expiresAt },
    });
    await sendWhatsAppText(
      from,
      `🔑 Novo código de convite gerado:\n\n*${code}*\n\nVálido por 30 dias. Compartilhe apenas com pessoas autorizadas.`,
      op.farm_id,
    );
    return true;
  }

  // LISTAR CODIGOS
  if (/^codigos$/.test(lower)) {
    if (!isManager) {
      await sendWhatsAppText(from, "⚠️ Apenas gestores podem ver códigos de convite.", op.farm_id);
      return true;
    }
    if (!op.farm_id) return true;
    const { data: codes } = await supabase
      .from("whatsapp_invite_codes")
      .select("*")
      .eq("farm_id", op.farm_id)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(20);
    if (!codes || codes.length === 0) {
      await sendWhatsAppText(from, "Nenhum código ativo. Envie *codigo* para gerar um novo.", op.farm_id);
      return true;
    }
    const lines = ["🔑 Códigos de convite ativos:", ""];
    for (const c of codes) {
      const exp = c.expires_at
        ? new Date(c.expires_at).toLocaleDateString("pt-BR", { timeZone: "America/Bahia" })
        : "—";
      lines.push(`• *${c.code}* — ${c.current_uses}/${c.max_uses} usos — expira ${exp}`);
    }
    await sendWhatsAppText(from, lines.join("\n"), op.farm_id);
    return true;
  }

  // (removido: "registrar grupo" — WhatsApp Cloud API não suporta grupos)


  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// MASTER MANAGERS (Gestores Master) — comandos exclusivos do super_admin
// ═════════════════════════════════════════════════════════════════════════════
const MM_PERM_ALIASES: Array<{ re: RegExp; col: string; label: string }> = [
  { re: /\bdashboard\b/,                          col: "can_view_dashboard",             label: "Dashboard" },
  { re: /\bindicador(es)?\b/,                     col: "can_view_indicators",            label: "Indicadores" },
  { re: /\brelator(ios?|io)\b/,                   col: "can_view_reports",               label: "Relatórios" },
  { re: /\b(comando|comandos)( remoto| remotos)?\b/, col: "can_command_pumps",           label: "Comando Remoto" },
  { re: /\b(controle|controlar)\b/,               col: "can_command_pumps",              label: "Comando Remoto" },
  { re: /\bprogramac(ao|oes|ão|ões)\b/,           col: "can_edit_schedules",             label: "Programação" },
  { re: /\bagenda(s)?\b/,                         col: "can_edit_schedules",             label: "Programação" },
  { re: /\bmanutenc(ao|ão)\b/,                    col: "can_manage_maintenance",         label: "Manutenção" },
  { re: /\bfinanceiro\b/,                         col: "can_view_financial",             label: "Financeiro" },
  { re: /\b(cadastr(ar|o)|gerenciar)\s+usuari(os|o)\b/, col: "can_manage_operational_users", label: "Cadastrar Usuários" },
  { re: /\busuari(os|o)\b/,                       col: "can_manage_operational_users",   label: "Cadastrar Usuários" },
];

const MM_PERM_COLS = [
  "can_view_dashboard","can_view_indicators","can_view_reports","can_command_pumps",
  "can_edit_schedules","can_manage_maintenance","can_view_financial","can_manage_operational_users",
];
const MM_PERM_LABELS: Record<string,string> = {
  can_view_dashboard: "Dashboard",
  can_view_indicators: "Indicadores",
  can_view_reports: "Relatórios",
  can_command_pumps: "Comando Remoto",
  can_edit_schedules: "Programação",
  can_manage_maintenance: "Manutenção",
  can_view_financial: "Financeiro",
  can_manage_operational_users: "Cadastrar Usuários",
};

function mmResolvePerm(text: string): { col: string; label: string } | null {
  const t = stripAccents((text || "").toLowerCase());
  for (const a of MM_PERM_ALIASES) if (a.re.test(t)) return { col: a.col, label: a.label };
  return null;
}

async function mmAudit(op: any, phone: string, action: string, target: { id?: string|null; name?: string|null }, details: any) {
  await auditLog({
    event_type: `master_manager.${action}`,
    actor_phone: phone,
    actor_name: (op as any)?.name ?? (op as any)?.full_name ?? null,
    target_name: target?.name ?? null,
    farm_id: op?.farm_id ?? null,
    details: { target_id: target?.id ?? null, ...details },
  });
}

async function mmFindManagers(term: string) {
  const t = (term || "").trim().replace(/[%_]/g, "");
  if (!t) return [] as any[];
  const { data } = await supabase
    .from("master_managers")
    .select("id, full_name, cpf, email, whatsapp, status, created_at")
    .ilike("full_name", `%${t}%`)
    .order("full_name", { ascending: true })
    .limit(10);
  return (data ?? []) as any[];
}

async function mmFindFarms(term: string) {
  const t = (term || "").trim().replace(/[%_]/g, "");
  if (!t) return [] as any[];
  const { data } = await supabase.from("farms").select("id, name").ilike("name", `%${t}%`).limit(10);
  return (data ?? []) as any[];
}

async function mmListFarms() {
  const { data } = await supabase.from("farms").select("id, name").order("name", { ascending: true });
  return (data ?? []) as any[];
}

function mmDetectIntent(lower: string): string | null {
  const l = lower;
  if (/\b(cadastr(ar|o)|criar|registrar|adicionar|nov[oa])\s+(um\s+|uma\s+)?gestor(es)?\s+master\b/.test(l)) return "create";
  if (/\blistar\s+gestor(es)?\s+master\b/.test(l) || /^gestor(es)?\s+master$/.test(l)) return "list";
  if (/^permiss(o|õ)es\s+(do\s+|da\s+|de\s+)?gestor\s+/.test(l) || /^permiss(o|õ)es\s+(do\s+|da\s+|de\s+)?/.test(l)) return "perms";
  if (/^(vincular)\b/.test(l)) return "link";
  if (/^(desvincular)\b/.test(l)) return "unlink";
  if (/^(desativar|inativar|bloquear|suspender)\s+gestor\b/.test(l)) return "deactivate";
  if (/^(ativar|reativar|habilitar)\s+gestor\b/.test(l)) return "activate";
  // permission toggling (natural)
  if (/(ativar|habilitar|libera(r|)|da(r|)\s+acesso)\b.+\b(para|ao|pra|do|da|de)\b/.test(l) && mmResolvePerm(l)) return "perm_on";
  if (/(desativar|desabilitar|tira(r|)|remove(r|)|bloquear|revogar|negar)\b.+\b(de|do|da|para|ao|pra)\b/.test(l) && mmResolvePerm(l)) return "perm_off";

  return null;
}

function mmExtractNameAfter(lower: string, raw: string, keywords: string[]): string {
  // Take substring after last keyword occurrence.
  let pos = -1;
  for (const k of keywords) {
    const p = lower.lastIndexOf(k);
    if (p > pos) pos = p + k.length;
  }
  if (pos < 0) return raw.trim();
  return raw.slice(pos).trim().replace(/^[:\-\s]+/, "").replace(/[.!?]+$/, "").trim();
}

async function mmPickManagerByFuzzyName(from: string, phone: string, op: any, name: string): Promise<any | null> {
  const list = await mmFindManagers(name);
  if (list.length === 0) {
    await sendWhatsAppText(from, `❌ Nenhum Gestor Master encontrado com nome contendo "${name}".`, op?.farm_id ?? null);
    return null;
  }
  if (list.length === 1) return list[0];
  const menu = list.map((m: any, i: number) => `${i + 1}. ${m.full_name} (${m.status})`).join("\n");
  await sendWhatsAppText(from, `Encontrei mais de um gestor. Refine o nome:\n${menu}`, op?.farm_id ?? null);
  return null;
}

// ── CREATE FLOW ─────────────────────────────────────────────────────────────
async function mmStartCreate(from: string, phone: string, op: any): Promise<boolean> {
  await saveConvState(phone, "mm_create_name", { step: "name", data: {} });
  await sendWhatsAppText(from,
    "📝 *Cadastro de Gestor Master*\n\nQual o *nome completo* do gestor?\n(Digite *cancelar* para sair)",
    op?.farm_id ?? null);
  return true;
}

async function mmCreateStep(from: string, phone: string, op: any, raw: string, conv: { awaiting: string; context: any }): Promise<boolean> {
  const ctx = conv.context ?? { data: {} };
  const data = ctx.data ?? {};
  const lowerRaw = stripAccents((raw || "").toLowerCase()).trim();

  if (/^(cancelar|sair|abortar)$/i.test(lowerRaw)) {
    await clearConvState(phone);
    await sendWhatsAppText(from, "❌ Cadastro de Gestor Master cancelado.", op?.farm_id ?? null);
    return true;
  }

  switch (conv.awaiting) {
    case "mm_create_name": {
      const name = raw.trim();
      if (name.length < 3) { await sendWhatsAppText(from, "Nome muito curto. Envie o *nome completo*.", op?.farm_id ?? null); return true; }
      data.full_name = name;
      await saveConvState(phone, "mm_create_cpf", { ...ctx, data });
      await sendWhatsAppText(from, `Nome: *${name}*\n\nAgora envie o *CPF* (apenas números ou formatado).`, op?.farm_id ?? null);
      return true;
    }
    case "mm_create_cpf": {
      if (!isValidCPF(raw)) { await sendWhatsAppText(from, "❌ CPF inválido. Envie novamente.", op?.farm_id ?? null); return true; }
      data.cpf = raw.replace(/[^\d]/g, "");
      await saveConvState(phone, "mm_create_email", { ...ctx, data });
      await sendWhatsAppText(from, `CPF: *${formatCPF(data.cpf)}*\n\nAgora envie o *email*.`, op?.farm_id ?? null);
      return true;
    }
    case "mm_create_email": {
      const email = raw.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { await sendWhatsAppText(from, "❌ Email inválido. Envie novamente.", op?.farm_id ?? null); return true; }
      data.email = email.toLowerCase();
      await saveConvState(phone, "mm_create_whatsapp", { ...ctx, data });
      await sendWhatsAppText(from, `Email: *${data.email}*\n\nAgora envie o *WhatsApp* (DDD + número).`, op?.farm_id ?? null);
      return true;
    }
    case "mm_create_whatsapp": {
      const normalized = normalizePhone(raw);
      const local = normalized.startsWith("55") && normalized.length >= 12 ? normalized.slice(2) : normalized;
      if (!normalized || local.length < 10 || local.length > 11) {
        await sendWhatsAppText(from, "❌ Número inválido. Formato: 77991234567.", op?.farm_id ?? null); return true;
      }
      data.whatsapp = normalized.startsWith("55") ? normalized : `55${local}`;
      const farms = await mmListFarms();
      if (farms.length === 0) {
        await sendWhatsAppText(from, "❌ Nenhuma fazenda cadastrada. Cadastre uma fazenda antes.", op?.farm_id ?? null);
        await clearConvState(phone);
        return true;
      }
      ctx.farms_options = farms.map((f: any) => ({ id: f.id, name: f.name }));
      await saveConvState(phone, "mm_create_farms", { ...ctx, data });
      const list = farms.map((f: any, i: number) => `${i + 1}. ${f.name}`).join("\n");
      await sendWhatsAppText(from,
        `WhatsApp: *${formatPhoneBR(data.whatsapp)}*\n\n🏡 *Quais fazendas vincular?*\n${list}\n\nResponda com os números separados por vírgula (ex: 1,3) ou *todas*.`,
        op?.farm_id ?? null);
      return true;
    }
    case "mm_create_farms": {
      const options: any[] = ctx.farms_options ?? [];
      let picked: any[] = [];
      if (/^todas?$/i.test(lowerRaw)) picked = options;
      else {
        const nums = raw.split(/[,;\s]+/).map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n >= 1 && n <= options.length);
        picked = Array.from(new Set(nums)).map((n) => options[n - 1]);
      }
      if (picked.length === 0) { await sendWhatsAppText(from, "❌ Seleção inválida. Envie números (ex: 1,2) ou *todas*.", op?.farm_id ?? null); return true; }
      data.farm_ids = picked.map((p) => p.id);
      data.farm_names = picked.map((p) => p.name);
      const permList = MM_PERM_COLS.map((c, i) => `${i + 1}. ${MM_PERM_LABELS[c]}`).join("\n");
      await saveConvState(phone, "mm_create_perms", { ...ctx, data });
      await sendWhatsAppText(from,
        `Fazendas: ${data.farm_names.join(", ")}\n\n🔐 *Quais permissões ativar?*\n${permList}\n\nResponda com números (ex: 1,3,5), *todas* ou *nenhuma*.`,
        op?.farm_id ?? null);
      return true;
    }
    case "mm_create_perms": {
      const perms: Record<string, boolean> = {};
      for (const c of MM_PERM_COLS) perms[c] = false;
      if (/^todas?$/i.test(lowerRaw)) for (const c of MM_PERM_COLS) perms[c] = true;
      else if (/^nenhuma?$/i.test(lowerRaw)) { /* keep all false */ }
      else {
        const nums = raw.split(/[,;\s]+/).map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n >= 1 && n <= MM_PERM_COLS.length);
        if (nums.length === 0) { await sendWhatsAppText(from, "❌ Seleção inválida. Envie números, *todas* ou *nenhuma*.", op?.farm_id ?? null); return true; }
        for (const n of nums) perms[MM_PERM_COLS[n - 1]] = true;
      }
      data.permissions = perms;
      await saveConvState(phone, "mm_create_confirm", { ...ctx, data });
      const permSummary = MM_PERM_COLS.filter((c) => perms[c]).map((c) => MM_PERM_LABELS[c]).join(", ") || "nenhuma";
      const summary = [
        "📋 *Confirmar cadastro?*",
        `Nome: ${data.full_name}`,
        `CPF: ${formatCPF(data.cpf)}`,
        `Email: ${data.email}`,
        `WhatsApp: ${formatPhoneBR(data.whatsapp)}`,
        `Fazendas: ${data.farm_names.join(", ")}`,
        `Permissões: ${permSummary}`,
        "",
        "Responda *sim* para confirmar ou *não* para cancelar.",
      ].join("\n");
      await sendWhatsAppText(from, summary, op?.farm_id ?? null);
      return true;
    }
    case "mm_create_confirm": {
      if (!/^(sim|s|confirmar|ok|yes)$/i.test(lowerRaw)) {
        await clearConvState(phone);
        await sendWhatsAppText(from, "❌ Cadastro cancelado.", op?.farm_id ?? null);
        return true;
      }
      // Insert master_manager + farms + permissions
      const { data: mmRow, error: mmErr } = await supabase
        .from("master_managers")
        .insert({
          full_name: data.full_name,
          cpf: data.cpf,
          email: data.email,
          whatsapp: data.whatsapp,
          status: "active",
        })
        .select("id")
        .single();
      if (mmErr || !mmRow) {
        await clearConvState(phone);
        await sendWhatsAppText(from, `❌ Erro ao cadastrar: ${mmErr?.message ?? "desconhecido"}`, op?.farm_id ?? null);
        return true;
      }
      const managerId = (mmRow as any).id;
      const farmRows = (data.farm_ids as string[]).map((fid) => ({ manager_id: managerId, farm_id: fid }));
      if (farmRows.length) await supabase.from("master_manager_farms").insert(farmRows);
      await supabase.from("master_manager_permissions").insert({ manager_id: managerId, ...data.permissions });
      await mmAudit(op, phone, "created", { id: managerId, name: data.full_name }, {
        cpf: data.cpf, email: data.email, whatsapp: data.whatsapp,
        farm_ids: data.farm_ids, permissions: data.permissions,
      });
      await clearConvState(phone);
      const enabled = MM_PERM_COLS.filter((c) => (data.permissions as any)[c]).map((c) => MM_PERM_LABELS[c]).join(", ") || "nenhuma";
      await sendWhatsAppText(from,
        `✅ *Gestor Master cadastrado*\n\n${data.full_name}\nFazendas: ${data.farm_names.join(", ")}\nPermissões: ${enabled}`,
        op?.farm_id ?? null);
      return true;
    }
  }
  return false;
}

// ── LIST ────────────────────────────────────────────────────────────────────
async function mmList(from: string, phone: string, op: any): Promise<boolean> {
  const { data } = await supabase
    .from("master_managers")
    .select("id, full_name, status, created_at, master_manager_farms(farm_id)")
    .order("full_name", { ascending: true });
  const rows = (data ?? []) as any[];
  if (rows.length === 0) { await sendWhatsAppText(from, "Nenhum Gestor Master cadastrado.", op?.farm_id ?? null); return true; }
  const lines = rows.map((r) => {
    const qty = Array.isArray(r.master_manager_farms) ? r.master_manager_farms.length : 0;
    const dt = r.created_at ? new Date(r.created_at).toLocaleDateString("pt-BR") : "—";
    return `• ${r.full_name} | ${r.status} | ${qty} fazenda(s) | cad: ${dt}`;
  });
  await sendWhatsAppText(from, `👥 *Gestores Master (${rows.length})*\n${lines.join("\n")}`, op?.farm_id ?? null);
  return true;
}

// ── SHOW PERMS ──────────────────────────────────────────────────────────────
async function mmShowPerms(from: string, phone: string, op: any, raw: string): Promise<boolean> {
  const lower = stripAccents(raw.toLowerCase());
  const name = mmExtractNameAfter(lower, raw, ["permissoes do gestor", "permissoes da gestora", "permissoes do", "permissoes da", "permissoes de", "permissoes"]);
  const mgr = await mmPickManagerByFuzzyName(from, phone, op, name);
  if (!mgr) return true;
  const { data: perms } = await supabase.from("master_manager_permissions").select("*").eq("manager_id", mgr.id).maybeSingle();
  const p: any = perms ?? {};
  const lines = MM_PERM_COLS.map((c) => `${p[c] ? "✅" : "⛔"} ${MM_PERM_LABELS[c]}`);
  await sendWhatsAppText(from, `🔐 *Permissões — ${mgr.full_name}* (${mgr.status})\n${lines.join("\n")}`, op?.farm_id ?? null);
  return true;
}

// ── TOGGLE PERM ─────────────────────────────────────────────────────────────
async function mmTogglePerm(from: string, phone: string, op: any, raw: string, lower: string, enable: boolean): Promise<boolean> {
  const perm = mmResolvePerm(lower);
  if (!perm) { await sendWhatsAppText(from, "❓ Não identifiquei qual permissão. Use: dashboard, indicadores, relatórios, comando remoto, programação, manutenção, financeiro ou cadastrar usuários.", op?.farm_id ?? null); return true; }
  // Extract name after "para|do|da|de"
  const m = raw.match(/\b(?:para|pra|ao|do|da|de)\s+(.+)$/i);
  const name = (m?.[1] ?? "").trim();
  if (!name) { await sendWhatsAppText(from, "❓ Informe o nome do gestor. Ex: *ativar indicadores para João*.", op?.farm_id ?? null); return true; }
  const mgr = await mmPickManagerByFuzzyName(from, phone, op, name);
  if (!mgr) return true;
  // Upsert (row may not exist yet)
  const { data: existing } = await supabase.from("master_manager_permissions").select("manager_id").eq("manager_id", mgr.id).maybeSingle();
  if (!existing) {
    await supabase.from("master_manager_permissions").insert({ manager_id: mgr.id, [perm.col]: enable });
  } else {
    await supabase.from("master_manager_permissions").update({ [perm.col]: enable, updated_at: new Date().toISOString() }).eq("manager_id", mgr.id);
  }
  await mmAudit(op, phone, enable ? "permission_enabled" : "permission_disabled", { id: mgr.id, name: mgr.full_name }, { permission: perm.col });
  await sendWhatsAppText(from, `${enable ? "✅ Ativado" : "⛔ Desativado"}: *${perm.label}* para *${mgr.full_name}*.`, op?.farm_id ?? null);
  return true;
}

// ── LINK / UNLINK ───────────────────────────────────────────────────────────
async function mmLinkFarm(from: string, phone: string, op: any, raw: string, lower: string, unlink: boolean): Promise<boolean> {
  // Format: "vincular <nome> <fazenda>" — but names may have spaces. Ask by two-phase disambiguation.
  // Strategy: take remaining text, try to find a farm at the tail that matches; the rest is name.
  const stripped = raw.replace(/^\s*(des)?vincular\s+/i, "").trim();
  if (!stripped) { await sendWhatsAppText(from, `❓ Uso: *${unlink ? "desvincular" : "vincular"} <nome do gestor> <fazenda>*`, op?.farm_id ?? null); return true; }
  // Try splitting by last farm match: iterate splits from the end
  const words = stripped.split(/\s+/);
  let mgr: any = null;
  let farm: any = null;
  for (let i = 1; i < words.length; i++) {
    const nameCandidate = words.slice(0, i).join(" ");
    const farmCandidate = words.slice(i).join(" ").replace(/^(a\s+|na\s+|no\s+|da\s+|do\s+|fazenda\s+)+/i, "");
    if (!farmCandidate) continue;
    const farms = await mmFindFarms(farmCandidate);
    if (farms.length === 0) continue;
    const mgrs = await mmFindManagers(nameCandidate);
    if (mgrs.length === 0) continue;
    // pick best (exact/unique)
    mgr = mgrs.length === 1 ? mgrs[0] : mgrs.find((m: any) => m.full_name.toLowerCase() === nameCandidate.toLowerCase()) ?? mgrs[0];
    farm = farms.length === 1 ? farms[0] : farms.find((f: any) => f.name.toLowerCase() === farmCandidate.toLowerCase()) ?? farms[0];
    break;
  }
  if (!mgr || !farm) {
    await sendWhatsAppText(from, `❌ Não consegui identificar gestor e fazenda em "${stripped}". Tente: *${unlink ? "desvincular" : "vincular"} João Silva Fazenda Sossego*.`, op?.farm_id ?? null);
    return true;
  }
  // Confirmation for destructive (unlink)
  if (unlink) {
    await saveConvState(phone, "mm_confirm_action", { action: "unlink", manager_id: mgr.id, manager_name: mgr.full_name, farm_id: farm.id, farm_name: farm.name });
    await sendWhatsAppText(from, `⚠️ Confirmar *desvincular* ${mgr.full_name} da fazenda ${farm.name}?\nResponda *sim* ou *não*.`, op?.farm_id ?? null);
    return true;
  }
  await supabase.from("master_manager_farms").upsert({ manager_id: mgr.id, farm_id: farm.id }, { onConflict: "manager_id,farm_id" });
  await mmAudit(op, phone, "farm_linked", { id: mgr.id, name: mgr.full_name }, { farm_id: farm.id, farm_name: farm.name });
  await sendWhatsAppText(from, `✅ *${mgr.full_name}* vinculado à fazenda *${farm.name}*.`, op?.farm_id ?? null);
  return true;
}

// ── STATUS (ativar/desativar) ───────────────────────────────────────────────
async function mmChangeStatus(from: string, phone: string, op: any, raw: string, lower: string, newStatus: "active" | "inactive", requireConfirm: boolean): Promise<boolean> {
  const name = mmExtractNameAfter(lower, raw, ["desativar gestor", "inativar gestor", "bloquear gestor", "suspender gestor", "ativar gestor", "reativar gestor", "habilitar gestor"]);
  if (!name) { await sendWhatsAppText(from, "❓ Informe o nome do gestor.", op?.farm_id ?? null); return true; }
  const mgr = await mmPickManagerByFuzzyName(from, phone, op, name);
  if (!mgr) return true;
  if (requireConfirm) {
    await saveConvState(phone, "mm_confirm_action", { action: "status", manager_id: mgr.id, manager_name: mgr.full_name, new_status: newStatus });
    await sendWhatsAppText(from, `⚠️ Confirmar *desativar* Gestor Master *${mgr.full_name}*?\nEle perderá acesso imediatamente.\nResponda *sim* ou *não*.`, op?.farm_id ?? null);
    return true;
  }
  await supabase.from("master_managers").update({ status: newStatus, updated_at: new Date().toISOString() }).eq("id", mgr.id);
  await mmAudit(op, phone, newStatus === "active" ? "activated" : "deactivated", { id: mgr.id, name: mgr.full_name }, { new_status: newStatus });
  await sendWhatsAppText(from, `✅ Gestor *${mgr.full_name}* agora está *${newStatus === "active" ? "ATIVO" : "INATIVO"}*.`, op?.farm_id ?? null);
  return true;
}

// ── Confirmation resolver for destructive actions ───────────────────────────
async function mmResolveConfirm(from: string, phone: string, op: any, raw: string, conv: { awaiting: string; context: any }): Promise<boolean> {
  const ans = stripAccents((raw || "").toLowerCase()).trim();
  const yes = /^(sim|s|confirmar|ok|yes)$/i.test(ans);
  const no = /^(nao|n|cancelar|cancela|no|abortar)$/i.test(ans);
  if (!yes && !no) {
    await sendWhatsAppText(from, "Responda *sim* ou *não*.", op?.farm_id ?? null);
    return true;
  }
  const ctx = conv.context ?? {};
  await clearConvState(phone);
  if (no) { await sendWhatsAppText(from, "❌ Ação cancelada.", op?.farm_id ?? null); return true; }
  if (ctx.action === "unlink") {
    await supabase.from("master_manager_farms").delete().eq("manager_id", ctx.manager_id).eq("farm_id", ctx.farm_id);
    await mmAudit(op, phone, "farm_unlinked", { id: ctx.manager_id, name: ctx.manager_name }, { farm_id: ctx.farm_id, farm_name: ctx.farm_name });
    await sendWhatsAppText(from, `✅ *${ctx.manager_name}* desvinculado da fazenda *${ctx.farm_name}*.`, op?.farm_id ?? null);
    return true;
  }
  if (ctx.action === "status") {
    await supabase.from("master_managers").update({ status: ctx.new_status, updated_at: new Date().toISOString() }).eq("id", ctx.manager_id);
    await mmAudit(op, phone, ctx.new_status === "active" ? "activated" : "deactivated", { id: ctx.manager_id, name: ctx.manager_name }, { new_status: ctx.new_status });
    await sendWhatsAppText(from, `✅ Gestor *${ctx.manager_name}* agora está *${ctx.new_status === "active" ? "ATIVO" : "INATIVO"}*.`, op?.farm_id ?? null);
    return true;
  }
  return true;
}

// ── Main entrypoint ─────────────────────────────────────────────────────────
async function handleMasterManagerCommands(from: string, phone: string, op: any, text: string): Promise<boolean> {
  const raw = (text || "").trim();
  if (!raw) return false;
  const lower = stripAccents(raw.toLowerCase());
  const isSuper = op?.role === "super_admin" || (op as any)?.is_super_admin === true;

  // Continue ongoing MM flow (only super_admin has these states, but we still enforce)
  const conv = await getConvState(phone);
  if (conv && typeof conv.awaiting === "string" && conv.awaiting.startsWith("mm_")) {
    if (!isSuper) { await clearConvState(phone); return false; }
    if (conv.awaiting === "mm_confirm_action") return await mmResolveConfirm(from, phone, op, raw, conv);
    if (conv.awaiting.startsWith("mm_create_")) return await mmCreateStep(from, phone, op, raw, conv);
  }

  const intent = mmDetectIntent(lower);
  if (!intent) return false;

  if (!isSuper) {
    await sendWhatsAppText(from, "🚫 Você não tem permissão para gerenciar Gestores Master.", op?.farm_id ?? null);
    return true;
  }

  if (intent === "create") return await mmStartCreate(from, phone, op);
  if (intent === "list") return await mmList(from, phone, op);
  if (intent === "perms") return await mmShowPerms(from, phone, op, raw);
  if (intent === "perm_on") return await mmTogglePerm(from, phone, op, raw, lower, true);
  if (intent === "perm_off") return await mmTogglePerm(from, phone, op, raw, lower, false);
  if (intent === "link") return await mmLinkFarm(from, phone, op, raw, lower, false);
  if (intent === "unlink") return await mmLinkFarm(from, phone, op, raw, lower, true);
  if (intent === "deactivate") return await mmChangeStatus(from, phone, op, raw, lower, "inactive", true);
  if (intent === "activate") return await mmChangeStatus(from, phone, op, raw, lower, "active", false);
  return false;
}


// ─────────────────────────────────────────────────────────────────────────────
// MANAGER REGISTRATION FLOW (super_admin only)
// Simplified flow: ask only for the new manager WhatsApp number, generate a
// registration code, send it to that number, then finish. No name/CPF/location
// collection happens in the super_admin flow.
// State stored in whatsapp_manager_registration_state.
// ─────────────────────────────────────────────────────────────────────────────
function isValidCPF(input: string): boolean {
  const cpf = (input || "").replace(/[^\d]/g, "");
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf.charAt(i), 10) * (10 - i);
  let check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  if (check !== parseInt(cpf.charAt(9), 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf.charAt(i), 10) * (11 - i);
  check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  if (check !== parseInt(cpf.charAt(10), 10)) return false;
  return true;
}

function formatCPF(input: string): string {
  const d = (input || "").replace(/[^\d]/g, "");
  if (d.length !== 11) return input;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

function formatPhoneBR(input: string): string {
  const d = normalizePhone(input);
  if (!d) return input;
  // remove country code 55 if present
  const local = d.startsWith("55") && d.length >= 12 ? d.slice(2) : d;
  if (local.length === 11) {
    return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  }
  if (local.length === 10) {
    return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  }
  return `+${d}`;
}

async function getManagerRegState(phone: string) {
  const { data } = await supabase
    .from("whatsapp_manager_registration_state")
    .select("*")
    .eq("super_admin_phone", phone)
    .maybeSingle();
  return data as any | null;
}

async function clearManagerRegState(phone: string) {
  await supabase.from("whatsapp_manager_registration_state").delete().eq("super_admin_phone", phone);
}

async function handleManagerRegistrationFlow(
  from: string,
  phone: string,
  op: any,
  text: string,
  _location: WaLocation,
): Promise<boolean> {
  if (op.role !== "super_admin") return false;
  const raw = (text || "").trim();
  const lower = stripAccents(raw.toLowerCase());

  const state = await getManagerRegState(phone);

  // Helper: normaliza e valida um número BR (retorna targetPhone com 55 + DDD).
  const tryNormalizeTarget = (candidate: string): string | null => {
    const normalized = normalizePhone(candidate);
    const local = normalized.startsWith("55") && normalized.length >= 12 ? normalized.slice(2) : normalized;
    if (!normalized || local.length < 10 || local.length > 11) return null;
    return normalized.startsWith("55") ? normalized : `55${local}`;
  };

  // Entrypoint command: super_admin asks to register a new manager.
  const ENTRY_RE = /^(cadastrar|registrar|criar|adicionar|novo|nova)\s+(um\s+|uma\s+|novo\s+|nova\s+)?(gestor|gerente|manager|administrador|admin)\b/i;
  if (!state && ENTRY_RE.test(lower)) {
    // Tenta extrair o número da própria mensagem (ex.: "cadastrar gestor +55 77 8111-3960")
    const extracted = extractInitialTargetPhone(raw, phone);
    const targetPhone = extracted ? tryNormalizeTarget(extracted) : null;

    // Lista fazendas acessíveis pelo super_admin. Se >1 → precisa perguntar.
    const farms = await mmListFarms();
    if (targetPhone && farms.length > 1) {
      const list = farms.map((f: any, i: number) => `${i + 1}. ${f.name}`).join("\n");
      await supabase.from("whatsapp_manager_registration_state").upsert({
        super_admin_phone: phone,
        step: 2,
        data: { target_phone: targetPhone, farms_options: farms.map((f: any) => ({ id: f.id, name: f.name })) },
        farm_id: null,
        updated_at: new Date().toISOString(),
      });
      await sendWhatsAppText(
        from,
        `📱 Cadastrar gestor *${targetPhone}*.\n\n🏡 *Em qual fazenda?*\n${list}\n\nResponda com o número (ex: 1) ou o nome da fazenda.`,
        op.farm_id,
      );
      return true;
    }
    if (targetPhone && farms.length === 1) {
      // Só uma fazenda acessível → cadastra direto
      await clearManagerRegState(phone);
      return await finalizeCodeGeneration(from, phone, op, farms[0].id, farms[0].name, targetPhone);
    }
    if (targetPhone && farms.length === 0) {
      // Fallback: sem fazendas listáveis → usa a do op
      const farmId = op.farm_id ?? null;
      let farmName = "—";
      if (farmId) {
        const { data: farm } = await supabase.from("farms").select("name").eq("id", farmId).maybeSingle();
        farmName = (farm as any)?.name ?? "—";
      }
      await clearManagerRegState(phone);
      return await finalizeCodeGeneration(from, phone, op, farmId ?? "", farmName, targetPhone);
    }

    // Sem número na mensagem → pergunta o telefone (fluxo antigo)
    await supabase.from("whatsapp_manager_registration_state").upsert({
      super_admin_phone: phone,
      step: 1,
      data: {},
      farm_id: op.farm_id ?? null,
      updated_at: new Date().toISOString(),
    });
    await sendWhatsAppText(from, "Qual o WhatsApp do novo gestor?", op.farm_id);
    return true;
  }

  if (!state) return false;

  // Cancel
  if (/^(cancelar|sair|abortar)$/i.test(lower)) {
    await clearManagerRegState(phone);
    await sendWhatsAppText(from, "❌ Cadastro de gestor cancelado.", op.farm_id);
    return true;
  }

  // Step 1: recebe telefone → decide se pergunta fazenda ou finaliza direto
  if (state.step === 1) {
    const extracted = extractInitialTargetPhone(raw, phone);
    const targetPhone = tryNormalizeTarget(extracted ?? raw);
    if (!targetPhone) {
      await sendWhatsAppText(
        from,
        "❌ Número inválido. Envie no formato 77991234567 (DDD + número). Digite *cancelar* para sair.",
        op.farm_id,
      );
      return true;
    }
    const farms = await mmListFarms();
    if (farms.length > 1) {
      const list = farms.map((f: any, i: number) => `${i + 1}. ${f.name}`).join("\n");
      await supabase.from("whatsapp_manager_registration_state").upsert({
        super_admin_phone: phone,
        step: 2,
        data: { target_phone: targetPhone, farms_options: farms.map((f: any) => ({ id: f.id, name: f.name })) },
        farm_id: null,
        updated_at: new Date().toISOString(),
      });
      await sendWhatsAppText(from, `📱 Cadastrar gestor *${targetPhone}*.\n\n🏡 *Em qual fazenda?*\n${list}\n\nResponda com o número (ex: 1) ou o nome da fazenda.`, op.farm_id);
      return true;
    }
    const singleFarm = farms[0];
    const farmId = singleFarm?.id ?? state.farm_id ?? op.farm_id ?? null;
    let farmName = singleFarm?.name ?? "—";
    if (!singleFarm && farmId) {
      const { data: farm } = await supabase.from("farms").select("name").eq("id", farmId).maybeSingle();
      farmName = (farm as any)?.name ?? "—";
    }
    await clearManagerRegState(phone);
    return await finalizeCodeGeneration(from, phone, op, farmId ?? "", farmName, targetPhone);
  }

  // Step 2: super_admin escolhe fazenda (por número ou nome)
  if (state.step === 2) {
    const data: any = state.data ?? {};
    const options: any[] = data.farms_options ?? [];
    const targetPhone: string | undefined = data.target_phone;
    if (!targetPhone || options.length === 0) {
      await clearManagerRegState(phone);
      await sendWhatsAppText(from, "❌ Cadastro perdido. Envie novamente: *cadastrar gestor <telefone>*.", op.farm_id);
      return true;
    }
    let picked: any = null;
    const idx = parseInt(raw.trim(), 10);
    if (Number.isFinite(idx) && idx >= 1 && idx <= options.length) {
      picked = options[idx - 1];
    } else {
      const norm = stripAccents(raw.toLowerCase()).replace(/^fazenda\s+/, "").trim();
      if (norm.length >= 2) {
        picked = options.find((f: any) => {
          const fn = stripAccents(String(f.name ?? "").toLowerCase()).replace(/^fazenda\s+/, "");
          return fn === norm || fn.includes(norm) || norm.includes(fn);
        }) ?? null;
      }
    }
    if (!picked) {
      const list = options.map((f: any, i: number) => `${i + 1}. ${f.name}`).join("\n");
      await sendWhatsAppText(from, `❌ Não identifiquei a fazenda. Escolha uma:\n${list}\n\nResponda com o número ou o nome.`, op.farm_id);
      return true;
    }
    await clearManagerRegState(phone);
    return await finalizeCodeGeneration(from, phone, op, picked.id, picked.name, targetPhone);
  }

  return false;
}

type WaLocation = { lat: number; lng: number; name?: string | null; address?: string | null } | null;



/**
 * Broadcast commands (super_admin only, with manager scoped to own farm):
 *   "broadcast: <msg>"          → all active operators across all farms (super_admin)
 *   "broadcast fazenda: <msg>"  → all operators of the sender's farm (manager+)
 *   "broadcast teste: <msg>"    → sends only to the sender (preview)
 */
async function handleBroadcastCommand(
  from: string,
  phone: string,
  op: any,
  text: string,
): Promise<boolean> {
  const raw = (text || "").trim();
  const m = raw.match(/^broadcast(?:\s+(teste|fazenda|geral))?\s*:\s*([\s\S]+)$/i);
  if (!m) return false;

  const scope = (m[1] ?? "geral").toLowerCase();
  const message = m[2].trim();
  if (!message) {
    await sendWhatsAppText(from, "⚠️ Mensagem vazia. Use: *broadcast: sua mensagem*", op.farm_id);
    return true;
  }
  if (message.length > 4000) {
    await sendWhatsAppText(from, "⚠️ Mensagem muito longa (máx 4000 caracteres).", op.farm_id);
    return true;
  }

  const isSuper = op.role === "super_admin";
  const isManager = op.role === "manager" || isSuper;

  if (scope === "geral" && !isSuper) {
    await sendWhatsAppText(from, "🚫 Apenas super_admin pode enviar broadcast geral. Use *broadcast fazenda: ...* para sua fazenda.", op.farm_id);
    return true;
  }
  if (scope === "fazenda" && !isManager) {
    await sendWhatsAppText(from, "🚫 Apenas gestores podem enviar broadcast da fazenda.", op.farm_id);
    return true;
  }

  // Test → only sender
  if (scope === "teste") {
    await sendWhatsAppText(from, `📢 *Prévia broadcast*\n\n${message}`, op.farm_id);
    await supabase.from("whatsapp_broadcasts").insert({
      message, target: "test", farm_id: op.farm_id ?? null, sent_by: phone,
      status: "sent", sent_count: 1, sent_at: new Date().toISOString(),
    });
    return true;
  }

  // Build recipients list
  let q = supabase
    .from("whatsapp_operators")
    .select("phone, notification_preference, farm_id")
    .eq("is_active", true);
  if (scope === "fazenda") {
    if (!op.farm_id) {
      await sendWhatsAppText(from, "⚠️ Você não está vinculado a uma fazenda.", null);
      return true;
    }
    q = q.eq("farm_id", op.farm_id);
  }
  const { data: ops } = await q;
  const phones = Array.from(new Set(
    (ops ?? [])
      .filter((o: any) => (o.notification_preference ?? "default") !== "mute")
      .map((o: any) => o.phone)
      .filter(Boolean)
  ));

  if (phones.length === 0) {
    await sendWhatsAppText(from, "Nenhum destinatário ativo encontrado.", op.farm_id);
    return true;
  }

  // Insert broadcast row
  const targetLabel = scope === "fazenda" ? `farm:${op.farm_id}` : "all";
  const { data: bRow } = await supabase.from("whatsapp_broadcasts").insert({
    message, target: targetLabel,
    farm_id: scope === "fazenda" ? op.farm_id : null,
    sent_by: phone, status: "sending",
  }).select().single();

  // Header for clarity
  const fullBody = `📢 *Comunicado Renov Tecnologia*\n\n${message}`;
  let sent = 0;
  for (const to of phones) {
    if (to === phone) { sent += 1; continue; } // avoid self for big batches we still send below — kept for parity
  }
  sent = 0;
  for (const to of phones) {
    try {
      await sendWhatsAppText(to, fullBody, scope === "fazenda" ? op.farm_id : null,
        { command_parsed: "broadcast", command_result: "sent" });
      sent += 1;
    } catch (e) {
      console.error("broadcast send err", to, e);
    }
  }

  if (bRow?.id) {
    await supabase.from("whatsapp_broadcasts").update({
      status: sent > 0 ? "sent" : "failed",
      sent_count: sent,
      sent_at: new Date().toISOString(),
    }).eq("id", bRow.id);
  }

  await sendWhatsAppText(from, `📢 Broadcast enviado para ${sent} operador${sent === 1 ? "" : "es"}.`, op.farm_id);
  return true;
}


// ──────────────────────────────────────────────────────────────────────────────
// Compound commands: split natural-language messages that combine multiple
// actions joined by " e ", ". ", or "; " into separately-executable parts.
// Returns a single-element array when no split is safe (i.e. at least one
// candidate part fails to parse as a recognized command).
// ──────────────────────────────────────────────────────────────────────────────
function splitCompoundParts(text: string): string[] {
  const t = (text || "").trim();
  if (!t) return [t];
  // Tentativa de split: " e " (case-insens), ". ", "; "
  const raw = t
    .split(/\s+e\s+|\s*[.;]\s+/i)
    .map((s) => s.trim().replace(/[.;,]+$/, ""))
    .filter(Boolean);
  if (raw.length < 2) return [t];
  // Whitelist permissiva: aceita parts que parseCommand reconhece OU que
  // começam com keywords tratadas no preâmbulo (alerts/notif/etc.).
  const PRE_PARSE_KW = /^(alertas?|notificac\w*|silenciar)\b/i;
  for (const part of raw) {
    const partNoAcc = stripAccents(part.toLowerCase());
    if (PRE_PARSE_KW.test(partNoAcc)) continue;
    if (parseCommand(part) != null) continue;
    return [t]; // qualquer parte irreconhecível → não trata como composto
  }
  return raw;
}


// ════════════════════════════════════════════════════════════════════════════
// CODE-BASED REGISTRATION SYSTEM (8-digit numeric, 30 min, CPF + nome + localização)
// ════════════════════════════════════════════════════════════════════════════

const REG_CODE_RE = /^\d{8}$/;
const REG_CODE_TTL_MS = 30 * 60 * 1000;

function isRegistrationCodeAdmin(op: any): boolean {
  const role = String(op?.role ?? "").toLowerCase();
  if (role === "super_admin" || role === "admin") return true;
  if (op?.is_super_admin === true || op?.is_admin === true) return true;
  // Delegated permission: any operator with can_register=true can generate codes.
  if (op?.can_register === true) return true;
  return false;
}

function isApprovalAdmin(op: any): boolean {
  const role = String(op?.role ?? "").toLowerCase();
  if (role === "super_admin" || op?.is_super_admin === true) return true;
  if (op?.can_approve === true) return true;
  return false;
}

function logRegistrationAdminDenied(phone: string, op: any) {
  const role = String(op?.role ?? "").toLowerCase();
  const checks = {
    role_super_admin: role === "super_admin",
    role_admin: role === "admin",
    is_super_admin: op?.is_super_admin === true,
    is_admin: op?.is_admin === true,
  };
  console.warn("registration-code admin denied", {
    phone,
    operator: op,
    checks,
    failed_condition: "role must be super_admin/admin OR is_super_admin/is_admin must be true",
  });
}

function isRegistrationCodeAdminCommand(text: string): boolean {
  const raw = (text || "").trim();
  const t = stripAccents(raw.toLowerCase()).replace(/[.!?]+$/g, "");
  return /^(gerar|criar|novo)\s+(codigo|convite|acesso)\b/.test(t)
    || /^gerar\s+codigo\s+para\s+cadastro\b/.test(t)
    || /^novo\s+acesso\b/.test(t)
    || /^criar\s+convite\b/.test(t)
    // Listagem
    || /^(codigos?\s+ativos?|listar?\s+codigos?|codigos?\s+abertos?|ver\s+codigos?|quais\s+codigos?(\s+est[aã]o\s+ativos?)?)$/.test(t)
    // Cancelar específico
    || /^cancelar?\s+c[oó]digo\s+\d{6,10}$/i.test(raw)
    // Cancelar todos / múltiplos / variantes
    || /^(cancele?|cancelar?|invalidar?|invalida|apagar?|apaga|excluir?|excluir|remover?|remove)\s+(todos?\s+)?(os?\s+)?(\w+\s+)?c[oó]digos?(\s+ativos?)?$/i.test(raw);
}


function formatCpf(cpf: string): string {
  const d = (cpf || "").replace(/\D/g, "");
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
function maskCpf(cpf: string): string {
  const d = (cpf || "").replace(/\D/g, "");
  if (d.length !== 11) return cpf;
  return `***.***.${d.slice(6, 9)}-${d.slice(9)}`;
}

const VERIFY_BASE_URL = "https://gestor.renovtecnologia.com.br/verify";

async function createVerificationToken(code: string, targetPhone: string): Promise<string | null> {
  try {
    const token = (crypto as any).randomUUID
      ? (crypto as any).randomUUID().replace(/-/g, "")
      : Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, "0")).join("");
    const { error } = await supabase.from("registration_verifications").insert({
      token,
      registration_code: code,
      target_phone: normalizePhone(targetPhone),
    });
    if (error) { console.error("verification token insert err", error); return null; }
    return token;
  } catch (e) { console.error("createVerificationToken err", e); return null; }
}

function buildCodeDeliveryMessage(code: string, verifyUrl: string | null): string {
  const link = verifyUrl
    ? `📍 Antes de usar o código, clique no link abaixo para verificação de segurança:\n${verifyUrl}\n\n`
    : "";
  return (
    "Você recebeu um código de acesso ao sistema *Renov Tecnologia Agrícola*.\n\n" +
    `🔐 Seu código: *${code}*\n\n` +
    "⏱️ Válido por 30 minutos.\n\n" +
    link +
    "*Como fazer seu cadastro:*\n\n" +
    "1️⃣ Clique no link acima e permita a localização\n\n" +
    "2️⃣ Volte aqui e envie o código\n\n" +
    "3️⃣ Informe seu nome completo\n\n" +
    "4️⃣ Informe seu CPF\n\n" +
    "5️⃣ Informe sua localização\n\n" +
    "6️⃣ Aguarde aprovação do administrador\n\n" +
    "Após aprovação, você poderá operar as bombas e programações da fazenda por aqui."
  );
}


async function generateRegistrationCode(): Promise<string> {
  // Auto-cleanup: marca códigos antigos como expirados
  await supabase.from("registration_codes")
    .update({ status: "expired" })
    .eq("status", "active")
    .lt("expires_at", new Date().toISOString());

  for (let attempt = 0; attempt < 12; attempt++) {
    const code = Math.floor(10000000 + Math.random() * 90000000).toString();
    const { data } = await supabase
      .from("registration_codes").select("id").eq("code", code).eq("status", "active").maybeSingle();
    if (!data) return code;
  }
  throw new Error("código");
}


/**
 * Extract a Brazilian phone number (10-13 digits) from an arbitrary text.
 * Returns the digits-only string, or null if no plausible phone is found.
 * Ignores the actor's own number to avoid self-referencing.
 */
function extractInitialTargetPhone(raw: string, actorPhone?: string): string | null {
  if (!raw) return null;
  const actor = (actorPhone || "").replace(/\D/g, "");
  const re = /(?:\+?\d[\d\s().\-]{8,16}\d)/g;
  const matches = raw.match(re) ?? [];
  for (const m of matches) {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 13) continue;
    if (actor && digits.slice(-8) === actor.slice(-8)) continue;
    return digits;
  }
  return null;
}


async function finalizeCodeGeneration(
  from: string, phone: string, op: any,
  farmId: string, farmName: string, targetPhone: string,
): Promise<boolean> {
  // Duplicate check
  const tail8 = targetPhone.slice(-8);
  const { data: existingOps } = await supabase
    .from("whatsapp_operators").select("phone, name, is_active");
  const dup = (existingOps ?? []).find((o: any) =>
    normalizePhone(o.phone ?? "").slice(-8) === tail8
  );
  if (dup && dup.is_active) {
    await supabase.from("registration_flow_state").delete().eq("phone", phone);
    await sendWhatsAppText(from, `Esse número já está cadastrado como *${dup.name}*.`, op.farm_id);
    return true;
  }

  // Active code already exists? → ask confirmation to regenerate
  const { data: activeExisting } = await supabase
    .from("registration_codes")
    .select("code, expires_at")
    .eq("status", "active")
    .eq("target_phone", targetPhone)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle();

  if (activeExisting) {
    const exp = new Date((activeExisting as any).expires_at);
    const hh = String(exp.getHours()).padStart(2, "0");
    const mm = String(exp.getMinutes()).padStart(2, "0");
    await supabase.from("registration_flow_state").upsert({
      phone, step: "admin_confirm_regen", farm_id: farmId,
      data: { target_phone: targetPhone, farm_id: farmId, farm_name: farmName, existing_code: (activeExisting as any).code, existing_expires_at: (activeExisting as any).expires_at },
      updated_at: new Date().toISOString(),
    }, { onConflict: "phone" });
    await sendWhatsAppText(
      from,
      `⚠️ Já existe um código ativo para *${targetPhone}*. Válido até *${hh}:${mm}*.\n\nQuer *cancelar e gerar um novo*? Responda *sim* ou *não*.`,
      op.farm_id,
    );
    return true;
  }

  let code: string;
  try { code = await generateRegistrationCode(); }
  catch { await sendWhatsAppText(from, "❌ Não consegui gerar código agora.", op.farm_id); return true; }

  const expiresAt = new Date(Date.now() + REG_CODE_TTL_MS).toISOString();
  const { error } = await supabase.from("registration_codes").insert({
    code, farm_id: farmId, created_by_phone: phone, generated_by: phone,
    target_phone: targetPhone, expires_at: expiresAt,
  });
  if (error) {
    console.error("registration_codes insert err", error);
    await sendWhatsAppText(from, "❌ Falha ao salvar código.", op.farm_id);
    return true;
  }

  await supabase.from("registration_flow_state").delete().eq("phone", phone);
  await auditLog({
    event_type: "code_generated", actor_phone: phone, actor_name: op.name,
    farm_id: farmId, details: { code, target_phone: targetPhone, expires_at: expiresAt },
  });

  try {
    const dialTarget = toE164BR(targetPhone);
    console.log("=== SENDING REGISTRATION CODE ===", JSON.stringify({
      target_raw: targetPhone, target_e164: dialTarget, farmId, code_len: code.length,
    }));
    const vTok = await createVerificationToken(code, targetPhone);
    const vUrl = vTok ? `${VERIFY_BASE_URL}/${vTok}` : null;
    // Step 1: Marketing template with verification link (ALWAYS template — first contact)
    let inviteResult: any = null;
    if (vUrl) {
      inviteResult = await sendTemplateMessage(dialTarget, "codigo_acesso", [{
        type: "body",
        parameters: [
          { type: "text", text: "Renov Tecnologia Agrícola" },
          { type: "text", text: vUrl },
        ],
      }], farmId);
      console.log("[reg-code] invite template result:", JSON.stringify(inviteResult));
    }
    // Step 2: Auth template with the 8-digit code (ALWAYS template)
    const codeResult = await sendAuthTemplate(dialTarget, code, farmId);
    console.log("[reg-code] auth template result:", JSON.stringify(codeResult));

    const inviteErr = (inviteResult as any)?.error;
    const codeErr = (codeResult as any)?.error;
    if (inviteErr || codeErr) {
      const errMsg = inviteErr?.message || codeErr?.message || "erro desconhecido";
      await sendWhatsAppText(
        from,
        `⚠️ Código gerado (*${code}*), mas a Meta rejeitou o envio para *${dialTarget}*.\nMotivo: ${errMsg}\n\nConfira se o número tem WhatsApp ativo e se está no formato com DDD.`,
        op.farm_id,
      );
      return true;
    }
  } catch (e) {
    console.error("send to target failed", e);
    await sendWhatsAppText(from, `⚠️ Código gerado (*${code}*) mas não consegui enviar para *${targetPhone}*. Verifique o número.`, op.farm_id);
    return true;
  }

  await sendWhatsAppText(from, `✅ Código enviado para *${targetPhone}* (fazenda *${farmName}*). Válido por 30 minutos.`, op.farm_id);
  return true;
}

// ─── PERMISSION PARSING (used during approval + later changes) ──────────────
type OperatorPerms = {
  can_control: boolean;
  audio_enabled: boolean;
  ai_enabled: boolean;
  can_schedule: boolean;
  role: "operator" | "admin" | "super_admin";
  /** Texto livre informado pelo aprovador (ex.: "semear", "terra norte"). Resolvido em finalizeApproval para sobrescrever d.farm_id. */
  farm_query?: string | null;
};

const DEFAULT_PERMS: OperatorPerms = {
  can_control: true,
  audio_enabled: false,
  ai_enabled: false,
  can_schedule: false,
  role: "operator",
  farm_query: null,
};

function isFastApproveText(raw: string): boolean {
  const t = stripAccents((raw || "").toLowerCase()).trim();
  return /\b(rapid|padrao|padr|default|simples|basic|comum|normal)\b/.test(t)
    && /\b(aprov|libera|ok)\b/.test(t);
}

function parsePermissionsResponse(raw: string): OperatorPerms {
  const t = " " + stripAccents((raw || "").toLowerCase()) + " ";
  const out: OperatorPerms = { ...DEFAULT_PERMS };

  const parts = raw.split(/[,;|]/).map((p) => stripAccents(p.toLowerCase()).trim()).filter(Boolean);
  if (parts.length >= 5) {
    const yn = (s: string) => /\b(s|sim|on|ativ|libera|pode|tudo|positivo|true)\b/i.test(s) && !/\b(nao|não|n|off|desativ|sem)\b/i.test(s);
    out.can_control = yn(parts[0]);
    out.audio_enabled = /\b(audio|ambos|tudo|todos|both|voz)\b/.test(parts[1]) && !/\b(so texto|somente texto|apenas texto|sem audio)\b/.test(parts[1]);
    out.ai_enabled = /\b(ia|ai|ativ|natural|inteligente)\b/.test(parts[2]) && !/\b(simples|bot|exato|regex|sem|desativ)\b/.test(parts[2]);
    out.can_schedule = yn(parts[3]);
    if (/\bsuper/.test(parts[4])) out.role = "super_admin";
    else if (/\badmin\b|\bgerente\b/.test(parts[4])) out.role = "admin";
    else out.role = "operator";
    if (parts.length >= 6 && parts[5]) out.farm_query = parts[5];
    return out;
  }

  // Numbered format: "1 sim 2 ambos 3 ia 4 sim 5 operador 6 semear"
  const numbered = raw.match(/1\D+(\S+(?:\s+\S+)?)\s+2\D+(\S+(?:\s+\S+)?)\s+3\D+(\S+(?:\s+\S+)?)\s+4\D+(\S+(?:\s+\S+)?)\s+5\D+(\S+(?:\s+\S+)?)(?:\s+6\D+(\S+(?:\s+\S+)?))?/i);
  if (numbered) {
    const [_, p1, p2, p3, p4, p5, p6] = numbered;
    const yn = (s: string) => /\b(s|sim|on|ativ|libera|pode|tudo|positivo|true)\b/i.test(stripAccents(s.toLowerCase())) && !/\bnao\b|\bn\b|\boff\b|\bdesativ\b/i.test(stripAccents(s.toLowerCase()));
    out.can_control = yn(p1);
    const mode = stripAccents(p2.toLowerCase());
    out.audio_enabled = /\b(audio|ambos|tudo|todos|both|voz)\b/.test(mode);
    const aiMode = stripAccents(p3.toLowerCase());
    out.ai_enabled = /\b(ia|ai|ativ|natural|com\s*ia|inteligente)\b/.test(aiMode) && !/\b(simples|bot|exato|regex|sem)\b/.test(aiMode);
    out.can_schedule = yn(p4);
    const role = stripAccents(p5.toLowerCase());
    if (/\bsuper/.test(role)) out.role = "super_admin";
    else if (/\badmin\b/.test(role)) out.role = "admin";
    else out.role = "operator";
    if (p6) out.farm_query = stripAccents(p6.toLowerCase()).trim();
    return out;
  }

  // ── Free-form parsing ──
  // 1) can_control
  if (/\b(nao\s+controla|sem\s+controle|nao\s+pode\s+ligar|sem\s+permissao\s+para\s+controlar|nao\s+controle)\b/.test(t)) {
    out.can_control = false;
  } else if (/\b(pode\s+controlar|controlar|liga[\s\/-]?desliga|controle\s+total|libera\s+tudo|libera\s+geral|tudo\s+liberado|sim\s+pode)\b/.test(t) || /\bsim\b/.test(t)) {
    out.can_control = true;
  }

  // 2) audio_enabled (modo de interação)
  const audioMatch = /\b(audio|voz)\b/.test(t);
  const textMatch = /\b(texto|escrito|escrita)\b/.test(t);
  const both = /\b(ambos|tudo|os\s+dois|todos|both)\b/.test(t) || (audioMatch && textMatch);
  if (both || /\b(audio\s+e\s+texto|texto\s+e\s+audio)\b/.test(t)) out.audio_enabled = true;
  else if (audioMatch && !textMatch) out.audio_enabled = true;
  else if (textMatch && !audioMatch) out.audio_enabled = false;
  if (/\b(so\s+texto|somente\s+texto|apenas\s+texto|sem\s+audio)\b/.test(t)) out.audio_enabled = false;

  // 3) ai_enabled
  if (/\b(bot\s+simples|sem\s+ia|sem\s+inteligencia|regex|exato|comandos\s+exatos|simples)\b/.test(t)) {
    out.ai_enabled = false;
  } else if (/\b(ia\s+ativ|com\s+ia|ia\s+natural|com\s+inteligencia|inteligencia\s+artificial|ai\s+ativ|natural|usar\s+ia)\b/.test(t) || /\bia\b/.test(t)) {
    out.ai_enabled = true;
  }

  // 4) can_schedule
  if (/\b(nao\s+pode\s+program|sem\s+program|nao\s+programa|nao\s+cria\s+program)\b/.test(t)) {
    out.can_schedule = false;
  } else if (/\b(pode\s+program|program|cria.*program|edita.*program|sim\s+program)\b/.test(t)) {
    out.can_schedule = true;
  }

  // 5) role
  if (/\bsuper[_\s-]?admin\b/.test(t) || /\bsuperadmin\b/.test(t)) out.role = "super_admin";
  else if (/\badmin\b/.test(t) || /\bgerente\b/.test(t)) out.role = "admin";
  else if (/\b(operador|operadora|comum|usuario)\b/.test(t)) out.role = "operator";

  return out;
}

function formatPermsSummary(name: string, p: OperatorPerms): string {
  const interacao = p.audio_enabled ? "Texto e Áudio" : "Texto";
  const role = p.role === "super_admin" ? "Super Admin" : p.role === "admin" ? "Admin" : "Operador";
  return (
    `✅ *${name}* aprovado com as seguintes permissões:\n\n` +
    `• Controle de equipamentos: *${p.can_control ? "Sim" : "Não"}*\n` +
    `• Interação: *${interacao}*\n` +
    `• IA: *${p.ai_enabled ? "Ativa" : "Bot simples"}*\n` +
    `• Programações: *${p.can_schedule ? "Sim" : "Não"}*\n` +
    `• Papel: *${role}*\n\n` +
    `Permissões salvas. O operador já foi notificado.`
  );
}

function formatPermsChangedSummary(name: string, p: OperatorPerms): string {
  const interacao = p.audio_enabled ? "Texto e Áudio" : "Texto";
  const role = p.role === "super_admin" ? "Super Admin" : p.role === "admin" ? "Admin" : "Operador";
  return (
    `✅ Permissões de *${name}* atualizadas:\n\n` +
    `• Controle de equipamentos: *${p.can_control ? "Sim" : "Não"}*\n` +
    `• Interação: *${interacao}*\n` +
    `• IA: *${p.ai_enabled ? "Ativa" : "Bot simples"}*\n` +
    `• Programações: *${p.can_schedule ? "Sim" : "Não"}*\n` +
    `• Papel: *${role}*`
  );
}

function formatCurrentPerms(target: any): string {
  const role = target.role === "super_admin" ? "Super Admin" : target.role === "admin" ? "Admin" : "Operador";
  return (
    `Permissões atuais de *${target.full_name ?? target.name}*:\n\n` +
    `• Controle: *${target.can_control ? "Sim" : "Não"}*\n` +
    `• Interação: *${target.audio_enabled ? "Texto e Áudio" : "Texto"}*\n` +
    `• IA: *${target.ai_enabled ? "Ativa" : "Bot simples"}*\n` +
    `• Programações: *${target.can_schedule ? "Sim" : "Não"}*\n` +
    `• Papel: *${role}*`
  );
}

const PERMS_EDIT_INSTRUCTIONS =
  `Envie as novas permissões em uma única mensagem, nesta ordem:\n` +
  `controle, interação, ia, programações, papel\n\n` +
  `Ex: *sim, ambos, ia ativa, sim, admin*`;

function permsPatchFromParsed(perms: OperatorPerms): Record<string, unknown> {
  return {
    can_control: perms.can_control,
    can_turn_on: perms.can_control,
    can_turn_off: perms.can_control,
    audio_enabled: perms.audio_enabled,
    ai_enabled: perms.ai_enabled,
    can_schedule: perms.can_schedule,
    role: perms.role,
  };
}

const PERMS_QUESTION = (firstName: string) =>
  `Certo. Defina as permissões para *${firstName}*:\n\n` +
  `1️⃣ *Controle de equipamentos* (liga/desliga): Sim ou Não?\n` +
  `2️⃣ *Modo de interação*: Texto, Áudio, ou Ambos?\n` +
  `3️⃣ *Inteligência artificial*: IA ativa (entende linguagem natural) ou Bot simples (só comandos exatos)?\n` +
  `4️⃣ *Programações*: Pode criar/editar programações? Sim ou Não?\n` +
  `5️⃣ *Papel*: Operador, Admin, ou Super Admin?\n` +
  `6️⃣ *Fazenda*: Terra Norte, Semear, Sossego ou Sykue?\n\n` +
  `Pode responder tudo de uma vez. Ex: *sim, ambos, ia ativa, sim, operador, semear*\n\n` +
  `Ou envie *aprovar rápido* para usar o padrão básico (controle sim, texto, sem IA, sem programações, operador, fazenda informada no cadastro).`;

async function insertApprovedOperator(d: any, perms: OperatorPerms, approverPhone: string) {
  const targetPhone = String(d.target_phone || "");
  const phoneCol = targetPhone.startsWith("+") ? targetPhone : `+${normalizePhone(targetPhone)}`;

  // Try reactivating an existing revoked record first.
  const { data: existing } = await supabase
    .from("whatsapp_operators")
    .select("id")
    .eq("phone", phoneCol)
    .maybeSingle();

  const payload: any = {
    name: d.full_name,
    full_name: d.full_name,
    cpf: d.cpf,
    location: d.location,
    farm_id: d.farm_id,
    default_farm_id: d.farm_id,
    role: perms.role,
    can_control: perms.can_control,
    can_schedule: perms.can_schedule,
    ai_enabled: perms.ai_enabled,
    audio_enabled: perms.audio_enabled,
    can_turn_on: perms.can_control,
    can_turn_off: perms.can_control,
    can_check_status: true,
    receive_alerts: true,
    is_active: true,
    approval_status: "approved",
    approved_by_phone: approverPhone,
    approved_at: new Date().toISOString(),
    registered_via_code: d.code,
    registered_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { error } = await supabase.from("whatsapp_operators").update(payload).eq("id", existing.id);
    if (!error) {
      const { data: saved } = await supabase
        .from("whatsapp_operators")
        .select("*")
        .eq("id", existing.id)
        .maybeSingle();
      console.log("[APPROVAL] permissões salvas", {
        phone: normalizePhone(saved?.phone ?? phoneCol),
        role: saved?.role,
        audio_enabled: saved?.audio_enabled,
        ai_enabled: saved?.ai_enabled,
        can_control: saved?.can_control,
        can_schedule: saved?.can_schedule,
      });
    }
    return { error };
  }
  const { error } = await supabase.from("whatsapp_operators").insert({ phone: phoneCol, ...payload });
  if (!error) {
    const { data: savedRows } = await supabase
      .from("whatsapp_operators")
      .select("*")
      .eq("is_active", true);
    const saved = (savedRows ?? []).find((o: any) => normalizePhone(o.phone ?? "").slice(-8) === normalizePhone(phoneCol).slice(-8));
    console.log("[APPROVAL] permissões salvas", {
      phone: normalizePhone(saved?.phone ?? phoneCol),
      role: saved?.role,
      audio_enabled: saved?.audio_enabled,
      ai_enabled: saved?.ai_enabled,
      can_control: saved?.can_control,
      can_schedule: saved?.can_schedule,
    });
  }
  return { error };
}

// Limpa o estado "admin_await_review" para TODOS os aprovadores que receberam
// a notificação sobre este cadastro, evitando que outro aprovador continue
// recebendo o prompt após a decisão.
async function clearAllApproverStatesForTarget(targetPhone: string) {
  const tp = normalizePhone(targetPhone);
  try {
    await supabase.from("registration_flow_state")
      .delete()
      .eq("step", "admin_await_review")
      .filter("data->>target_phone", "in", `(${tp},${targetPhone})`);
    await supabase.from("registration_flow_state")
      .delete()
      .eq("step", "admin_await_permissions")
      .filter("data->>target_phone", "in", `(${tp},${targetPhone})`);
    await supabase.from("whatsapp_conversation_state")
      .delete()
      .eq("awaiting", "awaiting_approval")
      .filter("context->>target_phone", "in", `(${tp},${targetPhone})`);
    await supabase.from("whatsapp_conversation_state")
      .delete()
      .eq("awaiting", "awaiting_approval")
      .filter("context->>operator_phone", "in", `(${tp},${targetPhone})`);
  } catch (e) { console.error("clearAllApproverStates err", e); }
}

function canApproveRegistrationForFarm(op: any, farmId?: string | null): boolean {
  if (!isApprovalAdmin(op)) return false;
  if (isSuperAdmin(op)) return true;
  if (!farmId) return true;
  return op?.farm_id === farmId || op?.default_farm_id === farmId;
}

function normalizeApprovalContext(input: any): any {
  const d = input ?? {};
  const targetPhone = normalizePhone(d.target_phone ?? d.operator_phone ?? d.phone ?? "");
  return {
    target_phone: targetPhone,
    full_name: d.full_name ?? d.operator_name ?? d.name ?? "Operador",
    cpf: d.cpf ?? null,
    location: d.location ?? d.registration_location_text ?? null,
    farm_id: d.farm_id ?? null,
    farm_name: d.farm_name ?? d.farm_name_provided ?? null,
    code: d.code ?? d.invite_code_used ?? null,
    request_id: d.request_id ?? d.id ?? null,
    generator_phone: d.generator_phone ?? null,
  };
}

async function findPendingApprovalContext(phone: string, op: any): Promise<any | null> {
  const convState = await getConvState(phone);
  if (convState?.awaiting === "awaiting_approval") {
    const d = normalizeApprovalContext(convState.context ?? {});
    if (d.target_phone && canApproveRegistrationForFarm(op, d.farm_id)) return d;
  }

  const { data: flowState } = await supabase
    .from("registration_flow_state")
    .select("*")
    .eq("phone", phone)
    .in("step", ["admin_await_review", "admin_await_permissions"])
    .maybeSingle();
  if (flowState) {
    const d = normalizeApprovalContext((flowState as any).data ?? {});
    if (d.target_phone && canApproveRegistrationForFarm(op, d.farm_id ?? (flowState as any).farm_id)) return d;
  }

  const { data: reqs } = await supabase
    .from("whatsapp_registration_requests")
    .select("*, farms:farm_id(id, name)")
    .eq("status", "pending_approval")
    .order("created_at", { ascending: false })
    .limit(20);
  const req = (reqs ?? []).find((r: any) => canApproveRegistrationForFarm(op, r.farm_id));
  if (!req) return null;
  return normalizeApprovalContext({
    ...req,
    request_id: req.id,
    target_phone: req.phone,
    full_name: req.name,
    farm_name: (req as any).farms?.name ?? req.farm_name_provided,
    code: req.invite_code_used,
    location: req.registration_location_text,
  });
}

// Finaliza a aprovação (cria/reativa operador, notifica e audita).
async function finalizeApproval(
  from: string, phone: string, op: any, d: any, perms: OperatorPerms, source: string,
): Promise<boolean> {
  const targetPhone = d.target_phone;

  // Se o aprovador informou a fazenda no item 6, resolve e sobrescreve d.farm_id.
  if (perms.farm_query) {
    try {
      const q = String(perms.farm_query).trim();
      const { data: farms } = await supabase.from("farms").select("id, name");
      const norm = (s: string) => stripAccents(String(s ?? "").toLowerCase()).replace(/^fazenda\s+/, "").trim();
      const qn = norm(q);
      const picked = (farms ?? []).find((f: any) => norm(f.name) === qn)
        ?? (farms ?? []).find((f: any) => norm(f.name).includes(qn) || qn.includes(norm(f.name)));
      if (picked) {
        d = { ...d, farm_id: (picked as any).id, farm_name: (picked as any).name };
      } else {
        await sendWhatsAppText(from, `⚠️ Não encontrei fazenda com "${q}". Usando a fazenda informada no cadastro.`, op.farm_id);
      }
    } catch (e) { console.error("finalizeApproval farm resolve err", e); }
  }

  const { error: insErr } = await insertApprovedOperator(d, perms, phone);
  if (insErr) {
    console.error("finalizeApproval insert err", insErr);
    await sendWhatsAppText(from, `❌ Falha ao ativar operador: ${insErr.message}`, op.farm_id);
    return true;
  }
  if (d.request_id) {
    await supabase.from("whatsapp_registration_requests").update({
      status: "approved", reviewed_by: phone, reviewed_at: new Date().toISOString(),
    }).eq("id", d.request_id);
  }
  await clearAllApproverStatesForTarget(targetPhone);
  await supabase.from("registration_flow_state").delete().eq("phone", phone);
  await supabase.from("registration_flow_state").delete().eq("phone", normalizePhone(targetPhone));
  await clearConvState(phone);
  await auditLog({
    event_type: "registration_approved", actor_phone: phone, actor_name: op.name,
    target_phone: normalizePhone(targetPhone), target_name: d.full_name,
    farm_id: d.farm_id, details: { code: d.code, perms, source },
  });
  const firstName = String(d.full_name || "").split(/\s+/)[0] || "";
  await sendProactiveMessage(
    targetPhone,
    "notificacao_geral",
    ["Renov Tecnologia Agrícola", `Bem-vindo, ${firstName}! Seu cadastro foi aprovado. Você já pode operar pelo WhatsApp. Se precisar de algo, é só enviar uma mensagem.`],
    `✅ Cadastro aprovado! Bem-vindo, *${firstName}*. Você já pode operar pelo WhatsApp. Se precisar de algo, é só me chamar.`,
    d.farm_id,
  );
  await sendWhatsAppText(from, formatPermsSummary(d.full_name ?? "Operador", perms), op.farm_id);
  await notifyCodeGenerator(phone, targetPhone, true, d.full_name ?? "Operador", d.farm_id ?? null);
  return true;
}

// "aprovar" → entra em estado awaiting_permissions e pergunta as permissões.
// "aprovar rapido" → aprova imediatamente com DEFAULT_PERMS.
async function approvePendingRegistration(
  from: string, phone: string, op: any, dRaw: any, opts?: { fast?: boolean },
): Promise<boolean> {
  const d = normalizeApprovalContext(dRaw);
  const targetPhone = d.target_phone;
  if (!targetPhone) {
    await sendWhatsAppText(from, "❌ Dados do cadastro pendente não encontrados.", op.farm_id);
    return true;
  }

  // Fast path: aprovar rápido OU código gerado por admin (não super_admin) → usa padrão.
  let generatorWasAdmin = false;
  try {
    const { data: gen } = await supabase.from("whatsapp_operators")
      .select("role").eq("phone", `+${normalizePhone(d.generator_phone ?? "")}`).maybeSingle();
    if (gen && String((gen as any).role).toLowerCase() === "admin") generatorWasAdmin = true;
  } catch (_e) { /* ignore */ }

  if (opts?.fast || generatorWasAdmin) {
    return await finalizeApproval(from, phone, op, d, { ...DEFAULT_PERMS }, opts?.fast ? "reserved_fast" : "generator_admin");
  }

  // Caso contrário: persiste o contexto e PERGUNTA as permissões ANTES de aprovar.
  await supabase.from("registration_flow_state").upsert({
    phone, step: "admin_await_permissions", farm_id: d.farm_id,
    data: d, updated_at: new Date().toISOString(),
  }, { onConflict: "phone" });
  await saveConvState(phone, "awaiting_approval", { ...d, stage: "permissions" });
  const firstNameQ = String(d.full_name || "Operador").split(/\s+/)[0] || "Operador";
  await sendWhatsAppText(from, PERMS_QUESTION(firstNameQ), op.farm_id);
  return true;
}

async function rejectPendingRegistration(from: string, phone: string, op: any, dRaw: any): Promise<boolean> {
  const d = normalizeApprovalContext(dRaw);
  const targetPhone = d.target_phone;
  if (!targetPhone) {
    await sendWhatsAppText(from, "❌ Dados do cadastro pendente não encontrados.", op.farm_id);
    return true;
  }
  if (d.request_id) {
    await supabase.from("whatsapp_registration_requests").update({
      status: "rejected", reviewed_by: phone, reviewed_at: new Date().toISOString(),
    }).eq("id", d.request_id);
  }
  await clearAllApproverStatesForTarget(targetPhone);
  await supabase.from("registration_flow_state").delete().eq("phone", phone);
  await supabase.from("registration_flow_state").delete().eq("phone", normalizePhone(targetPhone));
  await clearConvState(phone);
  await auditLog({
    event_type: "registration_rejected", actor_phone: phone, actor_name: op.name,
    target_phone: normalizePhone(targetPhone), target_name: d.full_name,
    farm_id: d.farm_id, details: { code: d.code, reserved_keyword: true },
  });
  await sendWhatsAppText(targetPhone, "❌ Seu cadastro não foi aprovado. Entre em contato com o gestor da fazenda.", d.farm_id);
  await sendWhatsAppText(from, `❌ ${d.full_name ?? "Operador"} foi rejeitado.`, op.farm_id);
  await notifyCodeGenerator(phone, targetPhone, false, d.full_name ?? "Operador", d.farm_id ?? null);
  return true;
}

async function handleReservedApprovalKeyword(from: string, phone: string, op: any, text: string): Promise<boolean> {
  const keyword = stripAccents((text || "").trim().toLowerCase()).replace(/[.!?]+$/g, "");
  const isApprove = /^aprov(ar|a|ado|ada)?(\s+rapido)?$/.test(keyword);
  const isReject = /^rejeit(ar|a|ado|ada)?$/.test(keyword);
  if (!isApprove && !isReject) return false;

  if (!isApprovalAdmin(op)) {
    await sendWhatsAppText(from, "⚠️ Você não tem permissão para aprovar ou rejeitar cadastros.", op?.farm_id ?? null);
    return true;
  }

  const pending = await findPendingApprovalContext(phone, op);
  if (!pending) {
    await clearConvState(phone);
    await sendWhatsAppText(from, "Não há cadastros pendentes de aprovação no momento.", op?.farm_id ?? null);
    return true;
  }

  if (isReject) return await rejectPendingRegistration(from, phone, op, pending);
  const fast = /\brapido\b/.test(keyword);
  return await approvePendingRegistration(from, phone, op, pending, { fast });
}

// ─────────────────────────────────────────────────────────────────────────────
// AI ROUTER DISPATCHER — gestão de operadores e comandos de equipamento.
// Roda DEPOIS dos interceptadores críticos (cadastro/programação/manutenção)
// e ANTES dos parsers regex de gestão. Em caso de unknown/erro, retorna false
// e o fluxo regex antigo continua (fallback transparente).
// ─────────────────────────────────────────────────────────────────────────────
async function buildAiRouterContext(op: any, phone: string): Promise<RouterContext> {
  const farmFilter = isSuperAdmin(op) || !op.farm_id ? null : op.farm_id;

  // Operadores ativos (até 25)
  let opsQ = supabase.from("whatsapp_operators")
    .select("id, name, full_name, phone, role, is_active")
    .eq("is_active", true)
    .order("name", { ascending: true })
    .limit(25);
  if (farmFilter) opsQ = opsQ.eq("farm_id", farmFilter);
  const { data: opsRows } = await opsQ;
  const active_operators = (opsRows ?? []).map((o: any) => ({
    id: String(o.id),
    name: o.full_name ?? o.name ?? "—",
    phone_last4: String(o.phone ?? "").replace(/\D/g, "").slice(-4) || "—",
    role: String(o.role ?? "operator"),
  }));

  // Cadastros pendentes (até 10)
  const pendQ = supabase.from("whatsapp_registration_requests")
    .select("id, name, phone, farm_id")
    .eq("status", "pending_approval")
    .order("created_at", { ascending: false })
    .limit(10);
  const { data: pendRows } = await pendQ;
  const pending_registrations = (pendRows ?? [])
    .filter((p: any) => canApproveRegistrationForFarm(op, p.farm_id))
    .map((p: any) => ({
      id: String(p.id),
      name: p.name ?? "—",
      phone_last4: String(p.phone ?? "").replace(/\D/g, "").slice(-4) || "—",
    }));

  // Tópico anterior (estado leve)
  const convState = await getConvState(phone);
  const last_topic = convState?.context?.topic ?? convState?.awaiting ?? undefined;

  // Histórico recente
  const { data: hist } = await supabase
    .from("whatsapp_message_log")
    .select("content, direction")
    .eq("operator_phone", phone)
    .order("created_at", { ascending: false })
    .limit(6);
  const recent_messages = (hist ?? []).reverse().map((h: any) => ({
    role: h.direction === "outbound" ? ("assistant" as const) : ("user" as const),
    content: String(h.content ?? "").slice(0, 400),
  }));

  return {
    current_operator: {
      name: op.name ?? op.full_name ?? "Operador",
      role: String(op.role ?? "operator"),
      can_control: !!op.can_control,
      can_approve: isApprovalAdmin(op),
    },
    active_operators,
    pending_registrations,
    last_topic,
    recent_messages,
  };
}

async function saveTopicHint(phone: string, topic?: string) {
  if (!topic) return;
  try {
    await saveConvState(phone, "ai_topic", { topic });
  } catch (_e) { /* noop */ }
}

function hasExplicitNamedExclusion(text: string): boolean {
  const parsed = parseOperatorMgmtIntent(text || "");
  return parsed?.action === "exclude" && !!parsed.name && parsed.name.trim().length >= 2;
}

async function hasActiveAdminOrConversationState(phone: string): Promise<boolean> {
  const [{ data: flow }, conv, { data: mgrReg }] = await Promise.all([
    supabase
      .from("registration_flow_state")
      .select("step")
      .eq("phone", phone)
      .in("step", ["admin_await_farm", "admin_await_phone", "admin_confirm_regen", "admin_await_review", "admin_await_permissions", "admin_confirm_op_action"])
      .maybeSingle(),
    getConvState(phone),
    supabase
      .from("whatsapp_manager_registration_state")
      .select("step")
      .eq("super_admin_phone", phone)
      .maybeSingle(),
  ]);
  if (flow) return true;
  if (mgrReg) return true;
  const awaiting = conv?.awaiting;
  return awaiting === "awaiting_approval"
    || awaiting === "awaiting_new_permissions"
    || awaiting === "operator_action_selection"
    || awaiting === "selecting_operator"
    || awaiting === "awaiting_visit_date"
    || awaiting === "farm_selection";
}

async function dispatchAiAction(
  from: string,
  phone: string,
  op: any,
  text: string,
  result: RouterResult,
): Promise<boolean> {
  const { action, params } = result;
  // Confiança mínima — chat com resposta natural pode ser aceito com limiar menor
  // para saudações/conversa curta não caírem no fallback rígido.
  const minConfidence = action === "chat" && params.reply?.trim() ? 0.35 : 0.55;
  if (result.confidence < minConfidence) return false;

  try {
    await supabase.from("ai_classification_log").insert({
      operator_phone: phone,
      raw_message: text,
      intent: action,
      confidence: result.confidence,
      tokens_input: result.tokens_input ?? null,
      tokens_output: result.tokens_output ?? null,
      ai_response: params.reply ?? null,
      canonical_command: null,
    }).select().maybeSingle();
  } catch (_e) { /* logging opcional */ }

  switch (action) {
    case "approve_operator": {
      if (!isApprovalAdmin(op)) {
        await sendWhatsAppText(from, "⚠️ Você não tem permissão para aprovar cadastros.", op.farm_id);
        return true;
      }
      const pending = await findPendingApprovalContext(phone, op);
      if (!pending) {
        await sendWhatsAppText(from, "Não há cadastros pendentes de aprovação no momento.", op.farm_id);
        return true;
      }
      // Se o usuário forneceu permissões explícitas, aplica direto. Senão pede.
      const hasExplicitPerms = params.can_control !== undefined
        || params.audio_enabled !== undefined
        || params.ai_enabled !== undefined
        || params.can_schedule !== undefined
        || params.role !== undefined;
      if (hasExplicitPerms) {
        const perms = {
          can_control: params.can_control ?? DEFAULT_PERMS.can_control,
          audio_enabled: params.audio_enabled ?? DEFAULT_PERMS.audio_enabled,
          ai_enabled: params.ai_enabled ?? DEFAULT_PERMS.ai_enabled,
          can_schedule: params.can_schedule ?? DEFAULT_PERMS.can_schedule,
          role: (params.role ?? DEFAULT_PERMS.role) as OperatorPerms["role"],
        };
        return await finalizeApproval(from, phone, op, pending, perms, "ai_router");
      }
      return await approvePendingRegistration(from, phone, op, pending, { fast: false });
    }

    case "reject_operator": {
      if (!isApprovalAdmin(op)) {
        await sendWhatsAppText(from, "⚠️ Você não tem permissão para rejeitar cadastros.", op.farm_id);
        return true;
      }
      const pending = await findPendingApprovalContext(phone, op);
      if (!pending) {
        await sendWhatsAppText(from, "Não há cadastros pendentes de aprovação no momento.", op.farm_id);
        return true;
      }
      return await rejectPendingRegistration(from, phone, op, pending);
    }

    case "change_permissions": {
      if (!isRegistrationCodeAdmin(op)) {
        await sendWhatsAppText(from, "⚠️ Apenas administradores podem alterar permissões.", op.farm_id);
        return true;
      }
      if (!params.operator_id) {
        await saveTopicHint(phone, "selecting_op_for_perms_change");
        await sendWhatsAppText(from, "Qual operador você quer editar? Me diga o nome.", op.farm_id);
        return true;
      }
      const { data: target } = await supabase.from("whatsapp_operators")
        .select("*").eq("id", params.operator_id).maybeSingle();
      if (!target) {
        await sendWhatsAppText(from, "Operador não encontrado.", op.farm_id);
        return true;
      }
      // Se vieram flags explícitas, aplica. Senão pede em formato livre.
      const hasFlags = params.can_control !== undefined
        || params.audio_enabled !== undefined
        || params.ai_enabled !== undefined
        || params.can_schedule !== undefined
        || params.role !== undefined;
      if (!hasFlags) {
        await saveConvState(phone, "awaiting_new_permissions", {
          action: "change_permissions",
          operator_id: target.id,
          operator_phone: target.phone,
          operator_name: target.full_name ?? target.name,
          farm_id: target.farm_id,
        });
        await sendWhatsAppText(from, `${formatCurrentPerms(target)}\n\n${PERMS_EDIT_INSTRUCTIONS}`, op.farm_id);
        return true;
      }
      const perms: OperatorPerms = {
        can_control: params.can_control ?? !!target.can_control,
        audio_enabled: params.audio_enabled ?? !!target.audio_enabled,
        ai_enabled: params.ai_enabled ?? !!target.ai_enabled,
        can_schedule: params.can_schedule ?? !!target.can_schedule,
        role: (params.role ?? target.role ?? "operator") as OperatorPerms["role"],
      };
      const { error } = await supabase.from("whatsapp_operators")
        .update(permsPatchFromParsed(perms)).eq("id", target.id);
      if (error) {
        await sendWhatsAppText(from, `❌ Falha ao atualizar permissões: ${error.message}`, op.farm_id);
        return true;
      }
      await clearConvState(phone);
      await auditLog({
        event_type: "operator_perms_changed", actor_phone: phone, actor_name: op.name,
        target_phone: (target as any).phone ?? null,
        target_name: (target as any).full_name ?? (target as any).name ?? "Operador",
        farm_id: (target as any).farm_id ?? null,
        details: { patch: permsPatchFromParsed(perms), source: "ai_router" },
      });
      await sendWhatsAppText(from, formatPermsChangedSummary((target as any).full_name ?? (target as any).name ?? "Operador", perms), op.farm_id);
      return true;
    }

    case "exclude_operator": {
      if (!isRegistrationCodeAdmin(op)) {
        await sendWhatsAppText(from, "⚠️ Apenas administradores podem excluir operadores.", op.farm_id);
        return true;
      }
      if (!hasExplicitNamedExclusion(text)) {
        await saveTopicHint(phone, "selecting_op_for_exclude");
        await sendWhatsAppText(from, "Quem você quer remover? Envie o nome junto com o pedido de exclusão.", op.farm_id);
        return true;
      }
      const parsedExclusion = parseOperatorMgmtIntent(text);
      const explicitName = parsedExclusion?.action === "exclude" ? parsedExclusion.name ?? "" : "";
      const matches = await findOperatorMatchesForAdmin(op, explicitName);
      if (matches.length === 0) {
        await sendWhatsAppText(from, `Não encontrei operador com "*${explicitName}*".`, op.farm_id);
        return true;
      }
      if (matches.length > 1) {
        const options = matches.slice(0, 8).map((m: any) => ({ id: m.id, name: m.full_name ?? m.name, phone: m.phone, farm_id: m.farm_id }));
        const list = options.map((m: any, i: number) => `${i + 1}. ${m.name} — ${m.phone ?? "—"}`).join("\n");
        await saveConvState(phone, "selecting_operator", { action: "exclude", options, operatorQuery: explicitName });
        await sendWhatsAppText(from, `Encontrei mais de um operador:\n${list}\n\nEnvie o número correto.`, op.farm_id);
        return true;
      }
      const target = matches[0];
      if (!target) {
        await sendWhatsAppText(from, "Operador não encontrado.", op.farm_id);
        return true;
      }
      // Protege o administrador principal (não pode ser excluído por ninguém)
      if (isProtectedMainAdmin(target as any)) {
        await sendWhatsAppText(from, "Não é possível excluir o administrador principal.", op.farm_id);
        return true;
      }
      const targetName = (target as any).full_name ?? (target as any).name ?? "Operador";

      // super_admin / skip_confirmation: executa imediatamente, sem prompt de confirmação
      const skipConfirm = op.role === "super_admin" || op.skip_confirmation === true;
      if (skipConfirm) {
        await applyOperatorAction(from, phone, op, {
          action: "exclude",
          operator_id: (target as any).id,
          operator_name: targetName,
          operator_phone: (target as any).phone,
          farm_id: (target as any).farm_id ?? null,
        });
        return true;
      }

      // Demais usuários: pede confirmação explícita
      await supabase.from("registration_flow_state").upsert({
        phone, step: "admin_confirm_op_action", farm_id: (target as any).farm_id,
        data: {
          action: "exclude",
          operator_id: (target as any).id,
          operator_name: targetName,
          operator_phone: (target as any).phone,
          farm_id: (target as any).farm_id,
        },
        updated_at: new Date().toISOString(),
      }, { onConflict: "phone" });
      const farmName = (target as any).farm_id
        ? ((await supabase.from("farms").select("name").eq("id", (target as any).farm_id).maybeSingle()).data as any)?.name ?? "—"
        : "—";
      await sendWhatsAppText(
        from,
        `Confirma *exclusão* do operador?\n\nNome: ${targetName}\nFazenda: ${farmName}\nTelefone: ${(target as any).phone ?? "—"}\n\nResponda *confirmar* ou *cancelar*.`,
        op.farm_id,
      );
      return true;
    }

    case "turn_on_equipment":
    case "turn_off_equipment": {
      if (!op.can_control) {
        await sendWhatsAppText(from, "⚠️ Você não tem permissão para controlar equipamentos.", op.farm_id);
        return true;
      }
      const nums = (params.equipment_numbers ?? []).filter((n) => Number.isFinite(n) && n > 0);
      if (nums.length === 0) return false; // fallback regex
      const turnOn = action === "turn_on_equipment";
      // Reusa o parser de regex via "canonical": reescreve text e deixa
      // os parsers existentes resolverem (suporta múltiplos números, bases
      // como POÇO/BOMBA, lookup por farm, etc.). Mais simples e robusto
      // que duplicar a lógica de resolveEquipmentsForBase aqui.
      return false;
    }

    case "request_status": {
      const statusFilter = (result.params.status_filter ?? "") as "" | "online" | "offline" | "ligado" | "desligado";
      if (!statusFilter) {
        // Sem filtro → deixa parser regex existente cuidar (status geral).
        return false;
      }

      // ---- Resolve fazenda(s) acessíveis ----
      let farms: Array<{ id: string; name: string }> = [];
      if (isSuperAdmin(op)) {
        const { data } = await supabase.from("farms").select("id, name").order("name", { ascending: true });
        farms = ((data ?? []) as any[]).filter((f) => f?.id);
      } else if (op.farm_id) {
        const { data: f } = await supabase.from("farms").select("id, name").eq("id", op.farm_id).maybeSingle();
        if (f?.id) farms = [f as any];
      }
      if (farms.length === 0) {
        await sendWhatsAppText(from, "Nenhuma fazenda disponível para consulta.", op.farm_id ?? null);
        return true;
      }

      let target: { id: string; name: string } | null = null;
      const hint = (result.params.farm_hint ?? "").trim();
      if (farms.length === 1) {
        target = farms[0];
      } else if (hint) {
        const norm = (s: string) => stripAccents(String(s ?? "").toLowerCase()).replace(/[^a-z0-9]+/g, "");
        const h = norm(hint);
        target = farms.find((f) => norm(f.name).includes(h) || h.includes(norm(f.name))) ?? null;
        if (!target) {
          await sendWhatsAppText(from, `Não achei fazenda "${hint}". Fazendas disponíveis:\n${farms.map((f) => `• ${f.name}`).join("\n")}`, op.farm_id ?? null);
          return true;
        }
      } else {
        await saveTopicHint(phone, "awaiting_farm_for_status");
        await sendWhatsAppText(from, `Você tem acesso a ${farms.length} fazendas. Qual você quer consultar?\n${farms.map((f) => `• ${f.name}`).join("\n")}`, op.farm_id ?? null);
        return true;
      }

      const { data: eqs, error } = await supabase
        .from("equipments")
        .select("name, desired_running, communication_status, last_communication, maintenance_mode")
        .eq("farm_id", target.id)
        .order("name", { ascending: true });
      if (error) {
        console.error(`[request_status filtered] db err:`, error.message);
        await sendWhatsAppText(from, "Não consegui consultar agora. Tenta de novo em instantes.", target.id);
        return true;
      }
      const list = (eqs ?? []) as any[];
      if (list.length === 0) {
        await sendWhatsAppText(from, `Não há equipamentos cadastrados em ${target.name}.`, target.id);
        return true;
      }

      const enriched = list.map((e) => ({ ...e, _s: computeEqState(e) }));
      let filtered: typeof enriched;
      let title: string;
      if (statusFilter === "offline") {
        filtered = enriched.filter((e) => e._s.isOffline);
        title = `⚫ *${target.name} — Bombas OFFLINE (${filtered.length})*`;
      } else if (statusFilter === "online") {
        filtered = enriched.filter((e) => !e._s.isOffline);
        title = `📶 *${target.name} — Bombas ONLINE (${filtered.length})*`;
      } else if (statusFilter === "ligado") {
        filtered = enriched.filter((e) => !e._s.isOffline && !e._s.inMaintenance && e.desired_running === true);
        title = `✅ *${target.name} — Bombas LIGADAS (${filtered.length})*`;
      } else {
        filtered = enriched.filter((e) => !e._s.isOffline && !e._s.inMaintenance && e.desired_running !== true);
        title = `🔴 *${target.name} — Bombas DESLIGADAS (${filtered.length})*`;
      }

      const body = filtered.length
        ? filtered.map((e) => {
            const flags: string[] = [];
            if (e._s.inMaintenance) flags.push("manutenção");
            return `• ${e.name}${flags.length ? ` _(${flags.join(", ")})_` : ""}`;
          }).join("\n")
        : "_(nenhum)_";

      await sendWhatsAppText(from, `${title}\n\n${body}`, target.id);
      try {
        await supabase.from("ai_classification_log").insert({
          operator_phone: phone,
          raw_message: text,
          intent: action,
          confidence: result.confidence,
          tokens_input: result.tokens_input ?? null,
          tokens_output: result.tokens_output ?? null,
          ai_response: `farm=${target.name}|filter=${statusFilter}|count=${filtered.length}`,
          canonical_command: null,
        }).select().maybeSingle();
      } catch (_e) { /* opcional */ }
      return true;
    }

    case "consultar_modo_automatico":
    case "consultar_modo_acionamento": {
      if (result.confidence < 0.6) return false;
      const isAcion = action === "consultar_modo_acionamento";

      // ---- Resolve fazenda(s) acessíveis (mesmo padrão do status_all) ----
      let farms: Array<{ id: string; name: string }> = [];
      if (isSuperAdmin(op)) {
        const { data } = await supabase.from("farms").select("id, name").order("name", { ascending: true });
        farms = ((data ?? []) as any[]).filter((f) => f?.id);
      } else if (op.farm_id) {
        const { data: f } = await supabase.from("farms").select("id, name").eq("id", op.farm_id).maybeSingle();
        if (f?.id) farms = [f as any];
      }
      if (farms.length === 0) {
        await sendWhatsAppText(from, "Nenhuma fazenda disponível para consulta.", op.farm_id ?? null);
        return true;
      }

      // ---- Se super_admin com múltiplas fazendas: usa farm_hint ou pergunta ----
      let target: { id: string; name: string } | null = null;
      const hint = (result.params.farm_hint ?? "").trim();
      if (farms.length === 1) {
        target = farms[0];
      } else if (hint) {
        const norm = (s: string) => stripAccents(String(s ?? "").toLowerCase()).replace(/[^a-z0-9]+/g, "");
        const h = norm(hint);
        target = farms.find((f) => norm(f.name).includes(h) || h.includes(norm(f.name))) ?? null;
        if (!target) {
          await sendWhatsAppText(from, `Não achei fazenda "${hint}". Fazendas disponíveis:\n${farms.map((f) => `• ${f.name}`).join("\n")}`, op.farm_id ?? null);
          return true;
        }
      } else {
        await saveTopicHint(phone, isAcion ? "awaiting_farm_for_acionamento" : "awaiting_farm_for_auto");
        await sendWhatsAppText(from, `Você tem acesso a ${farms.length} fazendas. Qual você quer consultar?\n${farms.map((f) => `• ${f.name}`).join("\n")}`, op.farm_id ?? null);
        return true;
      }

      // ---- Consulta equipamentos ----
      const { data: eqs, error } = await supabase
        .from("equipments")
        .select("name, auto_mode, communication_status, maintenance_mode, last_actuation_origin")
        .eq("farm_id", target.id)
        .order("name", { ascending: true });
      if (error) {
        console.error(`[${action}] db err:`, error.message);
        await sendWhatsAppText(from, "Não consegui consultar agora. Tenta de novo em instantes.", target.id);
        return true;
      }
      const list = (eqs ?? []) as Array<{
        name: string;
        auto_mode: boolean | null;
        communication_status: string | null;
        maintenance_mode: boolean | null;
        last_actuation_origin: string | null;
      }>;
      if (list.length === 0) {
        await sendWhatsAppText(from, `Não há equipamentos cadastrados em ${target.name}.`, target.id);
        return true;
      }

      const fmt = (arr: typeof list) =>
        arr.map((e) => {
          const flags: string[] = [];
          if (e.maintenance_mode) flags.push("manutenção");
          if (String(e.communication_status ?? "").toLowerCase() === "offline") flags.push("offline");
          return `• ${e.name}${flags.length ? ` _(${flags.join(", ")})_` : ""}`;
        }).join("\n") || "_(nenhum)_";

      let msg: string;
      let logSummary: string;

      if (isAcion) {
        const originFilter = (result.params.origin_filter ?? "both") as "local" | "remote" | "both";
        const local = list.filter((e) => String(e.last_actuation_origin ?? "").toLowerCase() === "local");
        const remote = list.filter((e) => String(e.last_actuation_origin ?? "").toLowerCase() === "remote");
        const nunca = list.filter((e) => !e.last_actuation_origin);
        logSummary = `local=${local.length}/remote=${remote.length}/none=${nunca.length}`;
        if (originFilter === "local") {
          msg = `📍 *${target.name} — Acionamento LOCAL (${local.length})*\n\n${fmt(local)}`;
        } else if (originFilter === "remote") {
          msg = `☁️ *${target.name} — Acionamento REMOTO (${remote.length})*\n\n${fmt(remote)}`;
        } else {
          msg =
            `⚙️ *${target.name} — Modo de acionamento (${list.length})*\n\n` +
            `📍 *LOCAL (${local.length})*\n${fmt(local)}\n\n` +
            `☁️ *REMOTO (${remote.length})*\n${fmt(remote)}` +
            (nunca.length ? `\n\n❔ *Sem histórico (${nunca.length})*\n${fmt(nunca)}` : "");
        }
      } else {
        const modeFilter = (result.params.mode_filter ?? "both") as "auto" | "manual" | "both";
        const auto = list.filter((e) => e.auto_mode === true);
        const manual = list.filter((e) => e.auto_mode !== true);
        logSummary = `auto=${auto.length}/manual=${manual.length}`;
        if (modeFilter === "auto") {
          msg = `🤖 *${target.name} — Em AUTO (${auto.length})*\n\n${fmt(auto)}`;
        } else if (modeFilter === "manual") {
          msg = `🔧 *${target.name} — Em MANUAL (${manual.length})*\n\n${fmt(manual)}`;
        } else {
          msg =
            `🤖 *${target.name} — Modo automático (${list.length})*\n\n` +
            `*AUTO (${auto.length})*\n${fmt(auto)}\n\n` +
            `*MANUAL (${manual.length})*\n${fmt(manual)}`;
        }
      }

      await sendWhatsAppText(from, msg, target.id);
      try {
        await supabase.from("ai_classification_log").insert({
          operator_phone: phone,
          raw_message: text,
          intent: action,
          confidence: result.confidence,
          tokens_input: result.tokens_input ?? null,
          tokens_output: result.tokens_output ?? null,
          ai_response: `farm=${target.name}|${logSummary}`,
          canonical_command: null,
        }).select().maybeSingle();
      } catch (_e) { /* opcional */ }
      return true;
    }



    case "notificar_equipe": {
      const escalationType = (result.params.escalation_type ?? "lead") as "lead" | "support" | "technical";
      const escalationPriority = (result.params.escalation_priority ?? "medium") as "low" | "medium" | "high";
      const leadName = (result.params.lead_name ?? "").trim() || (op?.name ?? "").trim() || "(não informado)";
      const leadSummary = (result.params.lead_summary ?? "").trim() || text.trim().slice(0, 400) || "(sem detalhes)";
      const rawPhone = normalizePhone(phone);
      const nowStr = new Date().toLocaleString("pt-BR", {
        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
        timeZone: "America/Bahia",
      }).replace(",", "");

      const header = escalationType === "lead"
        ? "🔔 *LEAD COMERCIAL*"
        : escalationType === "technical"
          ? `🚨 *SUPORTE TÉCNICO* (${escalationPriority.toUpperCase()})`
          : `🛟 *PEDIDO DE SUPORTE* (${escalationPriority.toUpperCase()})`;

      const farmLine = op?.farm_id ? `Fazenda: ${(op as { farm_name?: string }).farm_name ?? op.farm_id}\n` : "";

      const notifyMsg =
        `${header}\n` +
        `Cliente: ${leadName}\n` +
        `Número: ${rawPhone || "(desconhecido)"}\n` +
        farmLine +
        `Solicitação: ${leadSummary}\n` +
        `Horário: ${nowStr}`;

      // Destinatários fixos: Gabriel (super_admin) + Administrativo.
      const REQUIRED_TARGETS = ["5577999608294", "5577981503951"];
      const targets = Array.from(new Set(
        REQUIRED_TARGETS
          .map((p) => normalizePhone(p))
          .filter((p) => p && p !== rawPhone),
      ));

      const sentTo: string[] = [];
      const failedTo: string[] = [];
      for (const to of targets) {
        try {
          const ok = await sendWhatsAppDirect(to, notifyMsg, op?.farm_id ?? null);
          if (ok) sentTo.push(to); else failedTo.push(to);
        } catch (e) {
          failedTo.push(to);
          console.error("[notificar_equipe] send fail:", to, (e as Error).message);
        }
      }
      const allSent = targets.length > 0 && failedTo.length === 0;

      try {
        await supabase.from("ai_classification_log").insert({
          operator_phone: phone,
          raw_message: text,
          intent: action,
          confidence: result.confidence,
          tokens_input: result.tokens_input ?? null,
          tokens_output: result.tokens_output ?? null,
          ai_response: `type=${escalationType}|prio=${escalationPriority}|lead=${leadName}|targets=${targets.length}|sent=${sentTo.length}|failed=${failedTo.length}`,
          canonical_command: null,
        }).select().maybeSingle();
      } catch (_e) { /* opcional */ }

      if (allSent) {
        const successMsg = escalationType === "lead"
          ? "✅ Pronto, nossa equipe comercial foi avisada e entra em contato em breve. Obrigado!"
          : "✅ Registrei seu chamado e avisei a equipe de suporte da RENOV. Alguém entra em contato assim que possível.";
        await sendWhatsAppText(from, successMsg, op?.farm_id ?? null);
      } else {
        await sendWhatsAppText(
          from,
          "⚠️ Não consegui avisar a equipe automaticamente agora. Por favor, entre em contato direto pelo (77) 99960-8294 (Gabriel).",
          op?.farm_id ?? null,
        );
      }
      return true;
    }


    case "chat": {
      if (params.reply && params.reply.trim()) {
        await sendWhatsAppText(from, params.reply.trim(), op.farm_id ?? null);
        await saveTopicHint(phone, params.topic);
        return true;
      }
      return false;
    }

    case "unknown":
    default:
      return false;
  }
}

async function tryAiRouter(from: string, phone: string, op: any, text: string): Promise<boolean | { canonical: string; followUp?: string }> {
  if (!text || !text.trim()) return false;
  // IA só atua para operadores com ai_enabled (ou super_admin sempre)
  const allowed = isSuperAdmin(op) || op.ai_enabled === true;
  if (!allowed) return false;
  try {
    const result = await Promise.race<RouterResult | null | { timeout: true }>([
      (async () => {
        const ctx = await buildAiRouterContext(op, phone);
        return await routeWithAi(text, ctx);
      })(),
      new Promise<{ timeout: true }>((resolve) => {
        setTimeout(() => resolve({ timeout: true }), AI_ROUTER_TIMEOUT_MS);
      }),
    ]);
    if (result && "timeout" in result) {
      console.error(`[AI ROUTER] Timeout after ${AI_ROUTER_TIMEOUT_MS / 1000}s, falling back to regex`);
      return false;
    }
    if (!result) return false;
    console.log("[ai-router]", { action: result.action, conf: result.confidence, params: result.params });

    // Canonical rewrite: para turn_on/turn_off com alta confiança, reescreve
    // para comando canônico e deixa o parser determinístico executar (mantém
    // permissões, pré-checks, confirmação, auditoria, fila).
    if (
      (result.action === "turn_on_equipment" || result.action === "turn_off_equipment") &&
      result.confidence >= 0.85 &&
      Array.isArray(result.params.equipment_numbers) &&
      result.params.equipment_numbers.length > 0
    ) {
      const verb = result.action === "turn_on_equipment" ? "ligar" : "desligar";
      const base = result.params.equipment_base === "bomba" ? "bomba" : "poço";
      const nums = result.params.equipment_numbers.filter((n) => Number.isFinite(n) && n > 0);
      if (nums.length > 0) {
        const numsStr = nums.length === 1 ? String(nums[0]) : nums.join(" e ");
        const farmSuffix = result.params.farm_hint?.trim() ? ` fazenda ${result.params.farm_hint.trim()}` : "";
        const canonical = `${verb} ${base} ${numsStr}${farmSuffix}`;
        console.log("[ai-router] CANONICAL REWRITE", { orig: text.slice(0, 80), canonical });
        try {
          await supabase.from("ai_classification_log").insert({
            operator_phone: phone,
            raw_message: text,
            intent: result.action,
            confidence: result.confidence,
            tokens_input: result.tokens_input ?? null,
            tokens_output: result.tokens_output ?? null,
            ai_response: null,
            canonical_command: canonical,
          }).select().maybeSingle();
        } catch (_e) { /* opcional */ }
        return { canonical };
      }
    }



    // Canonical rewrite: request_levels → "níveis" (ou "níveis fazenda X").
    // Deixa o parser determinístico executar (kind:"level") e renderizar a
    // resposta com metros, porcentagem e barra visual.
    if (result.action === "request_levels" && result.confidence >= 0.6) {
      const farmSuffix = result.params.farm_hint?.trim()
        ? ` fazenda ${result.params.farm_hint.trim()}` : "";
      const canonical = `níveis${farmSuffix}`;
      console.log("[ai-router] CANONICAL REWRITE (levels)", { orig: text.slice(0, 80), canonical });
      try {
        await supabase.from("ai_classification_log").insert({
          operator_phone: phone,
          raw_message: text,
          intent: result.action,
          confidence: result.confidence,
          tokens_input: result.tokens_input ?? null,
          tokens_output: result.tokens_output ?? null,
          ai_response: null,
          canonical_command: canonical,
        }).select().maybeSingle();
      } catch (_e) { /* opcional */ }
      return { canonical };
    }

    // Canonical rewrite: request_overview → executa "níveis" primeiro (canonical
    // principal) e depois "status geral" (followUp). Ambos são determinísticos,
    // então não haverá recursão via AI router.
    if (result.action === "request_overview" && result.confidence >= 0.6) {
      const farmSuffix = result.params.farm_hint?.trim()
        ? ` fazenda ${result.params.farm_hint.trim()}` : "";
      const canonical = `níveis${farmSuffix}`;
      const followUp = `status geral${farmSuffix}`;
      console.log("[ai-router] CANONICAL REWRITE (overview)", { orig: text.slice(0, 80), canonical, followUp });
      try {
        await supabase.from("ai_classification_log").insert({
          operator_phone: phone,
          raw_message: text,
          intent: result.action,
          confidence: result.confidence,
          tokens_input: result.tokens_input ?? null,
          tokens_output: result.tokens_output ?? null,
          ai_response: null,
          canonical_command: `${canonical} ; ${followUp}`,
        }).select().maybeSingle();
      } catch (_e) { /* opcional */ }
      return { canonical, followUp };
    }

    return await dispatchAiAction(from, phone, op, text, result);
  } catch (e) {
    console.error("[ai-router] dispatch err:", (e as Error).message);
    return false;
  }
}




// Trata resposta livre de permissões quando o aprovador está em awaiting_permissions
// (acionado via reserved keyword path, sem registration_flow_state).
async function handleAwaitingPermissionsInput(from: string, phone: string, op: any, text: string): Promise<boolean> {
  const conv = await getConvState(phone);
  if (!conv || conv.awaiting !== "awaiting_approval") return false;
  const ctx = conv.context ?? {};
  if (ctx.stage !== "permissions") return false;
  if (!isApprovalAdmin(op)) return false;

  const raw = (text || "").trim();
  const lower = stripAccents(raw.toLowerCase());

  if (/^(cancelar|sair|cancel)\b/.test(lower)) {
    await clearConvState(phone);
    await supabase.from("registration_flow_state").delete().eq("phone", phone);
    await sendWhatsAppText(from, "Aprovação cancelada. O cadastro permanece pendente.", op.farm_id);
    return true;
  }

  const d = normalizeApprovalContext(ctx);
  if (!d.target_phone) {
    await clearConvState(phone);
    await sendWhatsAppText(from, "❌ Dados do cadastro pendente não encontrados.", op.farm_id);
    return true;
  }
  const perms = isFastApproveText(raw) || /^(padrao|padr|rapido|default)$/i.test(lower)
    ? { ...DEFAULT_PERMS }
    : parsePermissionsResponse(raw);
  return await finalizeApproval(from, phone, op, d, perms, "reserved_keyword");
}


// Notifica o admin/super_admin que GEROU o código, caso seja diferente do
// aprovador que tomou a decisão.
async function notifyCodeGenerator(
  approverPhone: string,
  targetPhone: string,
  approved: boolean,
  fullName: string,
  farmId: string | null,
) {
  try {
    const { data: codeRow } = await supabase
      .from("registration_codes")
      .select("generated_by, created_by_phone, farm_id")
      .eq("target_phone", targetPhone)
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();
    const gen = normalizePhone((codeRow as any)?.generated_by ?? (codeRow as any)?.created_by_phone ?? "");
    if (!gen || gen === normalizePhone(approverPhone)) return;
    const msg = approved
      ? `✅ O cadastro de *${fullName}* foi aprovado.`
      : `❌ O cadastro de *${fullName}* foi rejeitado.`;
    await sendWhatsAppText(gen, msg, farmId ?? (codeRow as any)?.farm_id ?? null);
  } catch (e) { console.error("notifyCodeGenerator err", e); }
}




async function handleRegistrationCodeAdminCommands(
  from: string, phone: string, op: any, text: string,
): Promise<boolean> {
  // ── Pending admin state: aguardando seleção de fazenda ou telefone ─────────
  if (isRegistrationCodeAdmin(op)) {
    const { data: pending } = await supabase
      .from("registration_flow_state")
      .select("*").eq("phone", phone)
      .in("step", ["admin_await_farm", "admin_await_phone", "admin_confirm_regen", "admin_await_review", "admin_await_permissions", "admin_confirm_op_action"]).maybeSingle();

    if (pending) {
      const rawIn = (text || "").trim();
      const lower = stripAccents(rawIn.toLowerCase());

      // ── Flow interruption: if user sends a NEW unrelated admin command,
      //    cancel the current pending step and process the new command.
      const isNewAdminCmd = isRegistrationCodeAdminCommand(rawIn) || isOperatorManagementCommand(rawIn);
      const isYesNo = /^(s|sim|n|nao|não|ok|cancelar|sair|confirmar|confirmo|aprovar|rejeitar|rejeita|aprova)\b/i.test(lower);
      const isJustDigits = /^\d{2,}$/.test(rawIn.replace(/\D/g, "")) && rawIn.replace(/\D/g, "").length >= 2;
      if (isNewAdminCmd && !isYesNo && !isJustDigits) {
        await supabase.from("registration_flow_state").delete().eq("phone", phone);
        // Recurse: re-process with state cleared so the new command is handled.
        return await handleRegistrationCodeAdminCommands(from, phone, op, text);
      }

      // Se havia uma confirmação administrativa pendente, mas o usuário mandou
      // um comando novo claro (ex: "status poço"), cancela a pendência e deixa
      // o pipeline normal responder imediatamente.
      const isNewNonAdminCommand = /^(status|st|sts|resumo|situacao|situação|leitura|ligar|desligar|programar|nivel|nível|niveis|níveis)\b/i.test(rawIn);
      if ((pending as any).step === "admin_confirm_op_action" && isNewNonAdminCommand && !isYesNo) {
        await supabase.from("registration_flow_state").delete().eq("phone", phone);
        return false;
      }

      // ── Step: aguardando confirmação de ação sobre operador ─────────────
      if ((pending as any).step === "admin_confirm_op_action") {
        const d = (pending as any).data ?? {};
        const yes = /^(s|sim|confirmar|confirmo|ok|pode|positivo)\b/i.test(lower);
        const no = /^(n|nao|não|cancelar|sair|negativo)\b/i.test(lower);
        if (!yes && !no) {
          await sendWhatsAppText(from, "Responda *confirmar* ou *cancelar*.", op.farm_id);
          return true;
        }
        await supabase.from("registration_flow_state").delete().eq("phone", phone);
        if (no) {
          await sendWhatsAppText(from, "Operação cancelada.", op.farm_id);
          return true;
        }
        return await applyOperatorAction(from, phone, op, d);
      }

      // ── Step: aguardando decisão de aprovação de cadastro ────────────────
      if ((pending as any).step === "admin_await_review") {
        const d = (pending as any).data ?? {};
        // Gate: somente quem tem permissão de aprovação (super_admin ou
        // delegado com can_approve=true) pode decidir.
        if (!isApprovalAdmin(op)) {
          await sendWhatsAppText(from, "⚠️ Você não tem permissão para aprovar este cadastro. Apenas o administrador da fazenda pode decidir.", op.farm_id);
          return true;
        }
        const isApprove = /^(aprovar|aprova|aprovado|aprovada|sim|s|ok|libera|liberar|liberado|pode|positivo|confirmo|confirmar)\b/i.test(lower);
        const isReject = /^(rejeitar|rejeita|rejeitado|negar|nega|negado|recusar|recusa|recusado|nao|não|n|cancelar)\b/i.test(lower);
        if (!isApprove && !isReject) {
          await sendWhatsAppText(from, `Cadastro pendente de *${d.full_name ?? "—"}* (${d.target_phone ?? "—"}). Responda *aprovar* ou *rejeitar*.`, op.farm_id);
          return true;
        }
        const targetPhone = String(d.target_phone || "");
        if (!targetPhone) {
          await supabase.from("registration_flow_state").delete().eq("phone", phone);
          await sendWhatsAppText(from, "❌ Dados do cadastro pendente não encontrados.", op.farm_id);
          return true;
        }
        if (isApprove) {
          // Se o código foi gerado por um admin (não super_admin), o aprovador
          // não deve precisar configurar permissões — usa o padrão básico
          // diretamente (papel = operator).
          let generatorWasAdmin = false;
          try {
            const { data: gen } = await supabase.from("whatsapp_operators")
              .select("role").eq("phone", `+${normalizePhone(d.generator_phone ?? "")}`).maybeSingle();
            if (gen && String((gen as any).role).toLowerCase() === "admin") generatorWasAdmin = true;
          } catch (_e) { /* ignore */ }

          const fast = isFastApproveText(rawIn) || generatorWasAdmin;
          if (fast) {
            const perms = { ...DEFAULT_PERMS };
            const { error: insErr } = await insertApprovedOperator(d, perms, phone);
            if (insErr) {
              console.error("approve insert err", insErr);
              await sendWhatsAppText(from, `❌ Falha ao ativar operador: ${insErr.message}`, op.farm_id);
              return true;
            }
            if (d.request_id) {
              await supabase.from("whatsapp_registration_requests").update({
                status: "approved", reviewed_by: phone, reviewed_at: new Date().toISOString(),
              }).eq("id", d.request_id);
            }
            await clearAllApproverStatesForTarget(targetPhone);
            await supabase.from("registration_flow_state").delete().eq("phone", phone);
            await supabase.from("registration_flow_state").delete().eq("phone", normalizePhone(targetPhone));
            await auditLog({
              event_type: "registration_approved", actor_phone: phone, actor_name: op.name,
              target_phone: normalizePhone(targetPhone), target_name: d.full_name,
              farm_id: d.farm_id, details: { code: d.code, perms, fast: true, generator_was_admin: generatorWasAdmin },
            });
            const firstName = String(d.full_name || "").split(/\s+/)[0] || "";
            await sendProactiveMessage(
              targetPhone,
              "notificacao_geral",
              ["Renov Tecnologia Agrícola", `Bem-vindo, ${firstName}! Seu cadastro foi aprovado. Você já pode operar pelo WhatsApp. Se precisar de algo, é só enviar uma mensagem.`],
              `✅ Cadastro aprovado! Bem-vindo, *${firstName}*. Você já pode operar pelo WhatsApp. Se precisar de algo, é só me chamar.`,
              d.farm_id,
            );
            await sendWhatsAppText(from, formatPermsSummary(d.full_name ?? "Operador", perms), op.farm_id);
            await notifyCodeGenerator(phone, targetPhone, true, d.full_name ?? "Operador", d.farm_id ?? null);
            return true;
          }

          // Normal path: transition to permissions step and ask the question.
          await supabase.from("registration_flow_state").upsert({
            phone, step: "admin_await_permissions", farm_id: d.farm_id,
            data: d, updated_at: new Date().toISOString(),
          }, { onConflict: "phone" });
          const firstNameQ = String(d.full_name || "Operador").split(/\s+/)[0] || "Operador";
          await sendWhatsAppText(from, PERMS_QUESTION(firstNameQ), op.farm_id);
          return true;
        }
        // reject
        if (d.request_id) {
          await supabase.from("whatsapp_registration_requests").update({
            status: "rejected", reviewed_by: phone, reviewed_at: new Date().toISOString(),
          }).eq("id", d.request_id);
        }
        await clearAllApproverStatesForTarget(targetPhone);
        await supabase.from("registration_flow_state").delete().eq("phone", phone);
        await supabase.from("registration_flow_state").delete().eq("phone", normalizePhone(targetPhone));
        await auditLog({
          event_type: "registration_rejected", actor_phone: phone, actor_name: op.name,
          target_phone: normalizePhone(targetPhone), target_name: d.full_name,
          farm_id: d.farm_id, details: { code: d.code },
        });
        await sendWhatsAppText(targetPhone, "❌ Seu cadastro não foi aprovado. Entre em contato com o gestor da fazenda.", d.farm_id);
        await sendWhatsAppText(from, `❌ Cadastro de *${d.full_name}* (${targetPhone}) rejeitado.`, op.farm_id);
        await notifyCodeGenerator(phone, targetPhone, false, d.full_name ?? "Operador", d.farm_id ?? null);
        return true;
      }

      // ── Step: aguardando definição de permissões pós-aprovação ────────────
      if ((pending as any).step === "admin_await_permissions") {
        const d = (pending as any).data ?? {};
        if (!isApprovalAdmin(op)) {
          await sendWhatsAppText(from, "⚠️ Você não tem permissão para definir permissões deste cadastro.", op.farm_id);
          return true;
        }
        const targetPhone = String(d.target_phone || "");
        if (!targetPhone) {
          await supabase.from("registration_flow_state").delete().eq("phone", phone);
          await sendWhatsAppText(from, "❌ Dados do cadastro pendente não encontrados.", op.farm_id);
          return true;
        }
        const perms = isFastApproveText(rawIn) || /^(padrao|padr|rapido|default)$/i.test(stripAccents(lower))
          ? { ...DEFAULT_PERMS }
          : parsePermissionsResponse(rawIn);
        const { error: insErr } = await insertApprovedOperator(d, perms, phone);
        if (insErr) {
          console.error("approve perms insert err", insErr);
          await sendWhatsAppText(from, `❌ Falha ao ativar operador: ${insErr.message}`, op.farm_id);
          return true;
        }
        if (d.request_id) {
          await supabase.from("whatsapp_registration_requests").update({
            status: "approved", reviewed_by: phone, reviewed_at: new Date().toISOString(),
          }).eq("id", d.request_id);
        }
        await clearAllApproverStatesForTarget(targetPhone);
        await supabase.from("registration_flow_state").delete().eq("phone", phone);
        await supabase.from("registration_flow_state").delete().eq("phone", normalizePhone(targetPhone));
        await auditLog({
          event_type: "registration_approved", actor_phone: phone, actor_name: op.name,
          target_phone: normalizePhone(targetPhone), target_name: d.full_name,
          farm_id: d.farm_id, details: { code: d.code, perms },
        });
        const firstName = String(d.full_name || "").split(/\s+/)[0] || "";
        await sendProactiveMessage(
          targetPhone,
          "notificacao_geral",
          ["Renov Tecnologia Agrícola", `Bem-vindo, ${firstName}! Seu cadastro foi aprovado. Você já pode operar pelo WhatsApp. Se precisar de algo, é só enviar uma mensagem.`],
          `✅ Cadastro aprovado! Bem-vindo, *${firstName}*. Você já pode operar pelo WhatsApp. Se precisar de algo, é só me chamar.`,
          d.farm_id,
        );
        await sendWhatsAppText(from, formatPermsSummary(d.full_name ?? "Operador", perms), op.farm_id);
        await notifyCodeGenerator(phone, targetPhone, true, d.full_name ?? "Operador", d.farm_id ?? null);
        return true;
      }



      if (lower === "cancelar" || lower === "sair") {
        await supabase.from("registration_flow_state").delete().eq("phone", phone);
        await sendWhatsAppText(from, "Operação cancelada.", op.farm_id);
        return true;
      }


      // ── Step: awaiting farm selection ────────────────────────────────────
      if ((pending as any).step === "admin_await_farm") {
        const farms: Array<{ id: string; name: string }> = (pending as any).data?.farms ?? [];
        let chosen: { id: string; name: string } | null = null;
        const asNum = parseInt(rawIn, 10);
        if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= farms.length) {
          chosen = farms[asNum - 1];
        } else {
          const q = stripAccents(rawIn.toLowerCase());
          const matches = farms.filter((f) => stripAccents(f.name.toLowerCase()).includes(q));
          if (matches.length === 1) chosen = matches[0];
          else if (matches.length > 1) {
            await sendWhatsAppText(from, `Mais de uma fazenda combina com "*${rawIn}*". Envie o *número*.`, op.farm_id);
            return true;
          }
        }
        if (!chosen) {
          const list = farms.map((f, i) => `${i + 1}. ${f.name}`).join("\n");
          await sendWhatsAppText(from, `Não entendi. Para qual fazenda?\n\n${list}\n\nEnvie o *número*. Ou *cancelar*.`, op.farm_id);
          return true;
        }
        // If a target phone was already provided in the initial command, skip
        // asking for it and proceed directly with finalization.
        const preTarget: string | null = (pending as any).data?.target_phone ?? null;
        await supabase.from("registration_flow_state").upsert({
          phone, step: "admin_await_phone", farm_id: chosen.id,
          data: { farm_name: chosen.name }, updated_at: new Date().toISOString(),
        }, { onConflict: "phone" });
        if (preTarget) {
          return await finalizeCodeGeneration(from, phone, op, chosen.id, chosen.name, preTarget);
        }
        await sendWhatsAppText(
          from,
          `Qual o WhatsApp do novo supervisor para *${chosen.name}*?\nEnvie com DDD, ex: *61999887766*.\n\nEnvie *cancelar* para sair.`,
          op.farm_id,
        );
        return true;
      }

      // ── Step: confirm regeneration when active code already exists ─────
      if ((pending as any).step === "admin_confirm_regen") {
        const yes = /^(s|sim|confirmar|confirmo|ok|pode|sim,?\s*pode)/i.test(lower);
        const no = /^(n|nao|não|cancelar|deixa|esquece)/i.test(lower);
        const d = (pending as any).data ?? {};
        if (!yes && !no) {
          await sendWhatsAppText(from, `Já existe um código ativo para *${d.target_phone}*. Quer *cancelar e gerar um novo*? Responda *sim* ou *não*.`, op.farm_id);
          return true;
        }
        if (no) {
          await supabase.from("registration_flow_state").delete().eq("phone", phone);
          await sendWhatsAppText(from, `Ok, mantive o código atual ativo para *${d.target_phone}*.`, op.farm_id);
          return true;
        }
        // yes → cancel previous active codes for this target and proceed to generate a new one
        await supabase.from("registration_codes")
          .update({ status: "cancelled" })
          .eq("status", "active")
          .eq("target_phone", d.target_phone);
        const newCode = await generateRegistrationCode().catch(() => null);
        if (!newCode) {
          await supabase.from("registration_flow_state").delete().eq("phone", phone);
          await sendWhatsAppText(from, "❌ Não consegui gerar código agora.", op.farm_id);
          return true;
        }
        const newExpires = new Date(Date.now() + REG_CODE_TTL_MS).toISOString();
        const { error: insErr } = await supabase.from("registration_codes").insert({
          code: newCode, farm_id: d.farm_id, created_by_phone: phone, generated_by: phone,
          target_phone: d.target_phone, expires_at: newExpires,
        });
        if (insErr) {
          await supabase.from("registration_flow_state").delete().eq("phone", phone);
          await sendWhatsAppText(from, "❌ Falha ao salvar código.", op.farm_id);
          return true;
        }
        await supabase.from("registration_flow_state").delete().eq("phone", phone);
        await auditLog({
          event_type: "code_generated", actor_phone: phone, actor_name: op.name,
          farm_id: d.farm_id, details: { code: newCode, target_phone: d.target_phone, expires_at: newExpires, replaced: true },
        });
        try {
          const dialTarget = toE164BR(d.target_phone);
          console.log("=== RESENDING REGISTRATION CODE ===", JSON.stringify({
            target_raw: d.target_phone, target_e164: dialTarget, farmId: d.farm_id,
          }));
          const vTok = await createVerificationToken(newCode, d.target_phone);
          const vUrl = vTok ? `${VERIFY_BASE_URL}/${vTok}` : null;
          let inviteResult: any = null;
          if (vUrl) {
            inviteResult = await sendTemplateMessage(dialTarget, "codigo_acesso", [{
              type: "body",
              parameters: [
                { type: "text", text: "Renov Tecnologia Agrícola" },
                { type: "text", text: vUrl },
              ],
            }], d.farm_id);
            console.log("[reg-code regen] invite result:", JSON.stringify(inviteResult));
          }
          const codeResult = await sendAuthTemplate(dialTarget, newCode, d.farm_id);
          console.log("[reg-code regen] auth result:", JSON.stringify(codeResult));
          const inviteErr = (inviteResult as any)?.error;
          const codeErr = (codeResult as any)?.error;
          if (inviteErr || codeErr) {
            const errMsg = inviteErr?.message || codeErr?.message || "erro desconhecido";
            await sendWhatsAppText(
              from,
              `⚠️ Código gerado (*${newCode}*), mas a Meta rejeitou o envio para *${dialTarget}*.\nMotivo: ${errMsg}`,
              op.farm_id,
            );
            return true;
          }
        } catch (e) {
          console.error("send to target failed", e);
          await sendWhatsAppText(from, `⚠️ Código gerado (*${newCode}*) mas não consegui enviar para *${d.target_phone}*.`, op.farm_id);
          return true;
        }
        await sendWhatsAppText(from, `✅ Código anterior cancelado. Novo código enviado para *${d.target_phone}* (fazenda *${d.farm_name ?? "sua fazenda"}*).`, op.farm_id);
        return true;
      }

      // ── Step: awaiting phone ─────────────────────────────────────────────
      const cleaned = rawIn.replace(/\D/g, "");
      if (cleaned.length < 10 || cleaned.length > 13) {
        await sendWhatsAppText(from, "Número inválido. Envie com DDD, ex: *61999887766*. Ou envie *cancelar*.", op.farm_id);
        return true;
      }
      const targetPhone = cleaned;
      const farmId = (pending as any).farm_id ?? op.farm_id;
      const farmName = (pending as any).data?.farm_name ?? "sua fazenda";
      return await finalizeCodeGeneration(from, phone, op, farmId, farmName, targetPhone);
    }
  }


  if (!text || !isRegistrationCodeAdminCommand(text)) return false;
  if (!isRegistrationCodeAdmin(op)) {
    logRegistrationAdminDenied(phone, op);
    await sendWhatsAppText(from, "⚠️ Apenas administradores podem gerar, listar ou cancelar códigos de cadastro.", op?.farm_id ?? null);
    return true;
  }
  const raw = text.trim();
  const t = stripAccents(raw.toLowerCase()).replace(/[.!?]+$/g, "");

  const cancelMatch = raw.match(/cancelar?\s+c[oó]digo\s+(\d{6,10})/i);
  if (cancelMatch) {
    const code = cancelMatch[1];

    const { data } = await supabase
      .from("registration_codes")
      .update({ status: "cancelled" })
      .eq("code", code).eq("status", "active")
      .select("id, farm_id").maybeSingle();
    if (!data) {
      await sendWhatsAppText(from, `Código *${code}* não encontrado ou já foi usado/cancelado.`, op.farm_id);
    } else {
      await auditLog({ event_type: "code_cancelled", actor_phone: phone, actor_name: op.name, farm_id: (data as any).farm_id, details: { code } });
      await sendWhatsAppText(from, `✅ Código *${code}* cancelado.`, op.farm_id);
    }
    return true;
  }

  // ── Cancelar TODOS / múltiplos códigos ativos ──────────────────────────────
  const cancelAllMatch = /^(cancele?|cancelar?|invalidar?|invalida|apagar?|apaga|excluir?|remover?|remove)\s+(todos?\s+)?(os?\s+)?(\w+\s+)?c[oó]digos?(\s+ativos?)?$/i.test(raw);
  if (cancelAllMatch) {
    // Expira antigos primeiro
    await supabase.from("registration_codes")
      .update({ status: "expired" })
      .eq("status", "active").lt("expires_at", new Date().toISOString());

    const { data: cancelled } = await supabase
      .from("registration_codes")
      .update({ status: "cancelled" })
      .eq("status", "active")
      .select("code, farm_id");
    const count = cancelled?.length ?? 0;
    if (count === 0) {
      await sendWhatsAppText(from, "Nenhum código ativo para cancelar.", op.farm_id);
    } else {
      await auditLog({
        event_type: "codes_cancelled_bulk", actor_phone: phone, actor_name: op.name,
        farm_id: op.farm_id, details: { count, codes: (cancelled ?? []).map((c: any) => c.code) },
      });
      await sendWhatsAppText(from, `✅ ${count} código${count > 1 ? "s" : ""} cancelado${count > 1 ? "s" : ""}.`, op.farm_id);
    }
    return true;
  }

  if (/^(codigos?\s+ativos?|listar?\s+codigos?|codigos?\s+abertos?|ver\s+codigos?|quais\s+codigos?(\s+est[aã]o\s+ativos?)?)$/.test(t)) {
    await supabase.from("registration_codes")
      .update({ status: "expired" })
      .eq("status", "active").lt("expires_at", new Date().toISOString());
    const { data } = await supabase
      .from("registration_codes")
      .select("code, expires_at, farm_id, target_phone")
      .eq("status", "active")
      .order("created_at", { ascending: false }).limit(30);
    if (!data || data.length === 0) {
      await sendWhatsAppText(from, "Nenhum código ativo no momento.", op.farm_id);
      return true;
    }
    const farmIds = [...new Set(data.map((r: any) => r.farm_id).filter(Boolean))];
    const { data: farms } = await supabase.from("farms").select("id, name").in("id", farmIds);
    const farmMap = new Map((farms ?? []).map((f: any) => [f.id, f.name]));
    const nowMs = Date.now();
    const lines = data.map((r: any) => {
      const fn = farmMap.get(r.farm_id) ?? "?";
      const minsLeft = Math.max(0, Math.round((new Date(r.expires_at).getTime() - nowMs) / 60000));
      const tp = r.target_phone ? ` → ${r.target_phone}` : "";
      return `• *${r.code}*${tp} — ${fn} — ${minsLeft} min restantes`;
    });
    await sendWhatsAppText(from, `*Códigos ativos:*\n${lines.join("\n")}`, op.farm_id);
    return true;
  }


  const isGenerate = /^(gerar|criar|novo)\s+(codigo|convite|acesso)(\s|$)/.test(t)
    || /^gerar\s+codigo\s+para\s+cadastro\b/.test(t)
    || /^novo\s+acesso\b/.test(t)
    || /^criar\s+convite\b/.test(t);
  if (isGenerate) {
    let farmId: string | null = null;
    let farmName: string | null = null;
    // Extract a phone number already present in the initial command
    // (e.g. "gere um codigo para 557781503429"). Strip the actor's own
    // number so we don't loop back on it.
    const initialTargetPhone = extractInitialTargetPhone(raw, phone);
    // Build a "clean" raw without the captured phone digits so the farm regex
    // doesn't accidentally match digits.
    const rawForFarm = initialTargetPhone
      ? raw.replace(new RegExp(initialTargetPhone.replace(/(.)/g, "$1[\\s().\\-]*"), "g"), " ")
      : raw;
    const farmMatch = rawForFarm.match(/fazenda\s+(.+)$/i);
    if (farmMatch) {
      const q = farmMatch[1].trim();
      const { data: farms } = await supabase
        .from("farms").select("id, name").ilike("name", `%${q}%`).limit(2);
      if (farms && farms.length === 1) { farmId = farms[0].id; farmName = farms[0].name; }
      else if (farms && farms.length > 1) {
        const list = farms.map((f: any) => `• ${f.name}`).join("\n");
        await sendWhatsAppText(from, `Mais de uma fazenda com *${q}*:\n${list}\n\nSeja mais específico.`, op.farm_id);
        return true;
      } else {
        await sendWhatsAppText(from, `Não encontrei fazenda com "*${q}*".`, op.farm_id);
        return true;
      }
    }
    if (!farmId) {
      // Build list of farms the admin has access to
      const isSuper = op?.role === "super_admin" || op?.is_super_admin === true;
      let accessibleFarms: Array<{ id: string; name: string }> = [];
      if (isSuper) {
        const { data: allFarms } = await supabase
          .from("farms").select("id, name").order("name", { ascending: true });
        accessibleFarms = (allFarms ?? []) as any;
      } else if (op.farm_id) {
        const { data: f } = await supabase.from("farms").select("id, name").eq("id", op.farm_id).maybeSingle();
        if (f) accessibleFarms = [f as any];
      }

      if (accessibleFarms.length === 0) {
        await sendWhatsAppText(from, "Nenhuma fazenda disponível para gerar código.", op.farm_id);
        return true;
      }

      if (accessibleFarms.length === 1) {
        farmId = accessibleFarms[0].id;
        farmName = accessibleFarms[0].name;
      } else {
        // Ask which farm first — carry the already-provided phone forward.
        await supabase.from("registration_flow_state").upsert({
          phone, step: "admin_await_farm", farm_id: null,
          data: { farms: accessibleFarms, target_phone: initialTargetPhone ?? null },
          updated_at: new Date().toISOString(),
        }, { onConflict: "phone" });
        const list = accessibleFarms.map((f, i) => `${i + 1}. ${f.name}`).join("\n");
        const phoneHint = initialTargetPhone ? `\n\n_(Telefone informado: *${initialTargetPhone}*)_` : "";
        await sendWhatsAppText(
          from,
          `Para qual fazenda?\n\n${list}\n\nEnvie o *número*. Ou *cancelar* para sair.${phoneHint}`,
          op.farm_id,
        );
        return true;
      }
    }

    // We have a farm. If the phone was already provided, finalize now.
    if (initialTargetPhone) {
      await supabase.from("registration_flow_state").upsert({
        phone, step: "admin_await_phone", farm_id: farmId,
        data: { farm_name: farmName }, updated_at: new Date().toISOString(),
      }, { onConflict: "phone" });
      return await finalizeCodeGeneration(from, phone, op, farmId!, farmName ?? "sua fazenda", initialTargetPhone);
    }

    await supabase.from("registration_flow_state").upsert({
      phone, step: "admin_await_phone", farm_id: farmId,
      data: { farm_name: farmName }, updated_at: new Date().toISOString(),
    }, { onConflict: "phone" });

    await sendWhatsAppText(
      from,
      `Qual o WhatsApp do novo supervisor para *${farmName}*?\nEnvie com DDD, ex: *61999887766*.\n\nEnvie *cancelar* para sair.`,
      op.farm_id,
    );
    return true;
  }


  return false;
}


// ═══════════════════════════════════════════════════════════════════════════
// OPERATOR MANAGEMENT (super_admin): list / exclude / block / unblock / permissions
// ═══════════════════════════════════════════════════════════════════════════

function isOperatorManagementCommand(text: string): boolean {
  const raw = (text || "").trim();
  const t = stripAccents(raw.toLowerCase()).replace(/[.!?]+$/g, "");
  if (isMaintenanceDeterministicCommand(raw) || isAutoModeDeterministicCommand(raw)) return false;
  return (
    /^(excluir|remover|deletar|apagar|desativar|inativar|revogar)\s+(o\s+)?(acesso\s+(de|do|da)\s+)?(gestor|operador|supervisor|usuario|usuário|operadora|gestora)?\s*/i.test(raw) ||
    /^(bloquear|desbloquear|suspender|reativar|ativar)\s+(o\s+)?(gestor|operador|supervisor|usuario|usuário)?\s*/i.test(raw) ||
    /^(revogar\s+acesso\s+(de|do|da))\b/i.test(raw) ||
    /^(listar?|liste|mostrar?|mostra|ver|quais|quem)\s+(os\s+|as\s+)?(operadores?|gestores?|supervisores?|usuarios?|usuários?)/i.test(raw) ||
    /^(operadores?|gestores?|supervisores?)\s+(da\s+fazenda|ativos?|cadastrados?)/i.test(raw) ||
    /^(mudar|alterar|editar|configurar|definir)\s+(as\s+)?permiss[õo]es\b/i.test(raw) ||
    /^quem\s+tem\s+acesso\b/i.test(t)
  );
}

type OpAction = "exclude" | "block" | "unblock" | "change_permissions";

function normalizeOperatorAction(action: unknown): OpAction | null {
  const a = String(action ?? "").trim();
  if (["exclude", "block", "unblock", "change_permissions"].includes(a)) return a as OpAction;
  return null;
}

function parseOperatorMgmtIntent(raw: string): { action: OpAction | "list"; name?: string; farm?: string } | null {
  const t = stripAccents(raw.toLowerCase()).replace(/[.!?]+$/g, "").trim();
  // Listing
  if (/^(listar?|liste|mostrar?|mostra|ver|quais|quem)\s+(os\s+|as\s+)?(operadores?|gestores?|supervisores?|usuarios?|usuários?)/i.test(raw)
      || /^(operadores?|gestores?|supervisores?)\s+(da\s+fazenda|ativos?|cadastrados?)/i.test(raw)
      || /^quem\s+tem\s+acesso\b/.test(t)) {
    const farmMatch = raw.match(/fazenda\s+(.+)$/i);
    return { action: "list", farm: farmMatch ? farmMatch[1].trim() : undefined };
  }
  let action: OpAction | null = null;
  if (/^(mudar|alterar|editar|configurar|definir)\s+(as\s+)?permiss[õo]es\b/i.test(raw)) action = "change_permissions";
  else if (/^(excluir|remover|deletar|apagar|desativar|inativar|revogar)\b/i.test(raw)) action = "exclude";
  else if (/^bloquear\b/i.test(raw)) action = "block";
  else if (/^(desbloquear|reativar|ativar)\b/i.test(raw)) action = "unblock";
  if (!action) return null;
  // Strip leading verb, role words, articles, "acesso de"
  let rest = raw
    .replace(/^(mudar|alterar|editar|configurar|definir)\s+(as\s+)?permiss[õo]es\b/i, "")
    .replace(/^(excluir|remover|deletar|apagar|desativar|inativar|revogar|bloquear|desbloquear|reativar|ativar)\b/i, "")
    .replace(/^\s*(acesso\s+(de|do|da)\s+)/i, "")
    .replace(/^\s*(o|a)\s+/i, "")
    .replace(/^\s*(do|da|de)\s+/i, "")
    .replace(/^\s*(gestor|operador|supervisor|usuario|usuário|operadora|gestora)\s+/i, "")
    .trim();
  let farm: string | undefined;
  const farmMatch = rest.match(/\s+(da|do)\s+fazenda\s+(.+)$/i);
  if (farmMatch) { farm = farmMatch[2].trim(); rest = rest.slice(0, farmMatch.index!).trim(); }
  const name = rest.replace(/[.!?]+$/g, "").trim();
  if (!name) return null;
  return { action, name, farm };
}

async function findOperatorMatchesForAdmin(op: any, name: string, scopedFarmIds?: string[] | null) {
  const nameNorm = stripAccents(String(name || "").toLowerCase()).trim();
  let q = supabase.from("whatsapp_operators")
    .select("*")
    .eq("is_active", true);
  if (scopedFarmIds && scopedFarmIds.length > 0) q = q.in("farm_id", scopedFarmIds);
  else if (!isSuperAdmin(op) && op?.farm_id) q = q.eq("farm_id", op.farm_id);
  const { data } = await q.limit(100);
  const tokens = nameNorm.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [] as any[];
  return (data ?? []).filter((candidate: any) => {
    const hay = stripAccents(`${candidate.full_name ?? ""} ${candidate.name ?? ""} ${candidate.phone ?? ""}`.toLowerCase());
    return tokens.every((tk) => hay.includes(tk));
  });
}

async function sendOperatorActionPrompt(from: string, phone: string, op: any, target: any, action: OpAction | null): Promise<boolean> {
  if (action === "exclude" && isProtectedMainAdmin(target)) {
    await sendWhatsAppText(from, "Não é possível excluir o administrador principal.", op.farm_id);
    return true;
  }
  if ((action === "exclude" || action === "block" || action === "unblock") && (isSuperAdmin(op) || op.skip_confirmation === true)) {
    return await applyOperatorAction(from, phone, op, {
      action,
      operator_id: target.id,
      operator_name: target.full_name ?? target.name,
      operator_phone: target.phone,
      farm_id: target.farm_id ?? null,
    });
  }

  if (action === "change_permissions") {
    await saveConvState(phone, "awaiting_new_permissions", {
      action: "change_permissions",
      operator_id: target.id,
      operator_name: target.full_name ?? target.name,
      operator_phone: target.phone,
      farm_id: target.farm_id ?? null,
    });
    await sendWhatsAppText(from, `${formatCurrentPerms(target)}\n\n${PERMS_EDIT_INSTRUCTIONS}`, op.farm_id);
    return true;
  }

  if (action === "exclude" || action === "block" || action === "unblock") {
    const { data: farmRow } = target.farm_id
      ? await supabase.from("farms").select("name").eq("id", target.farm_id).maybeSingle()
      : { data: null as any };
    const farmName = (farmRow as any)?.name ?? "—";
    const verbMap = { exclude: "exclusão", block: "bloqueio", unblock: "desbloqueio" } as const;
    await supabase.from("registration_flow_state").upsert({
      phone, step: "admin_confirm_op_action", farm_id: target.farm_id,
      data: {
        action,
        operator_id: target.id,
        operator_name: target.full_name ?? target.name,
        operator_phone: target.phone,
        farm_id: target.farm_id,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: "phone" });
    await sendWhatsAppText(
      from,
      `Confirma *${verbMap[action]}* do operador?\n\n` +
      `Nome: ${target.full_name ?? target.name}\n` +
      (target.cpf ? `CPF: ${maskCpf(target.cpf)}\n` : "") +
      `Fazenda: ${farmName}\n` +
      `Telefone: ${target.phone ?? "—"}\n\n` +
      `Responda *confirmar* ou *cancelar*.`,
      op.farm_id,
    );
    return true;
  }

  await saveConvState(phone, "operator_action_selection", {
    operator_id: target.id,
    operator_name: target.full_name ?? target.name,
    operator_phone: target.phone,
    farm_id: target.farm_id ?? null,
  });
  await sendWhatsAppText(
    from,
    `O que deseja fazer com *${target.full_name ?? target.name}*? Responda *permissões* para alterar permissões ou *excluir* para remover o acesso.`,
    op.farm_id,
  );
  return true;
}

async function handleOperatorConversationState(
  from: string, phone: string, op: any, text: string, convState: { awaiting: string; context: any },
): Promise<boolean> {
  const raw = (text || "").trim();
  const lower = stripAccents(raw.toLowerCase()).replace(/[.!?]+$/g, "");
  const ctx = convState.context ?? {};

  if (convState.awaiting === "awaiting_new_permissions") {
    if (!isRegistrationCodeAdmin(op)) return false;
    const operatorId = String(ctx.operator_id ?? "");
    if (!operatorId) {
      await clearConvState(phone);
      await sendWhatsAppText(from, "Não encontrei o operador selecionado. Envie *mudar permissões* novamente.", op.farm_id);
      return true;
    }
    const perms = parsePermissionsResponse(raw);
    const patch = permsPatchFromParsed(perms);
    const { data: target } = await supabase.from("whatsapp_operators").select("*").eq("id", operatorId).maybeSingle();
    const { error } = await supabase.from("whatsapp_operators").update(patch).eq("id", operatorId);
    await clearConvState(phone);
    if (error) {
      console.error("[operator permissions edit]", error);
      await sendWhatsAppText(from, "❌ Falha ao atualizar permissões.", op.farm_id);
      return true;
    }
    await auditLog({
      event_type: "operator_perms_changed",
      actor_phone: phone,
      actor_name: op.name,
      target_phone: (target as any)?.phone ?? ctx.operator_phone ?? null,
      target_name: (target as any)?.full_name ?? (target as any)?.name ?? ctx.operator_name ?? "Operador",
      farm_id: (target as any)?.farm_id ?? ctx.farm_id ?? null,
      details: { patch, source: "operator_permission_flow" },
    });
    await sendWhatsAppText(from, formatPermsChangedSummary((target as any)?.full_name ?? (target as any)?.name ?? ctx.operator_name ?? "Operador", perms), op.farm_id);
    return true;
  }

  if (convState.awaiting === "operator_action_selection") {
    if (!isRegistrationCodeAdmin(op)) return false;
    const operatorId = String(ctx.operator_id ?? "");
    const { data: target } = operatorId
      ? await supabase.from("whatsapp_operators").select("*").eq("id", operatorId).maybeSingle()
      : { data: null as any };
    if (!target) {
      await clearConvState(phone);
      await sendWhatsAppText(from, "Não encontrei o operador selecionado. Envie o comando novamente.", op.farm_id);
      return true;
    }
    if (/^(permiss(?:ao|oes)|mudar|alterar|editar)/.test(lower)) {
      await clearConvState(phone);
      return await sendOperatorActionPrompt(from, phone, op, target, "change_permissions");
    }
    if (/^(excluir|remover|deletar|apagar|revogar)/.test(lower)) {
      await clearConvState(phone);
      await sendWhatsAppText(from, `Para remover alguém com segurança, envie o pedido já com o nome. Exemplo: excluir ${target.full_name ?? target.name}.`, op.farm_id);
      return true;
    }
    await sendWhatsAppText(from, `Responda *permissões* para alterar permissões de *${target.full_name ?? target.name}* ou *excluir* para remover o acesso.`, op.farm_id);
    return true;
  }

  if (convState.awaiting === "selecting_operator") {
    if (!isRegistrationCodeAdmin(op)) return false;
    const action = normalizeOperatorAction(ctx.action);
    const options = Array.isArray(ctx.options) ? ctx.options : [];

    if (/^\d+$/.test(lower) && options.length > 0) {
      const idx = parseInt(lower, 10) - 1;
      if (idx < 0 || idx >= options.length) {
        await sendWhatsAppText(from, `Escolha um número de 1 a ${options.length}, ou envie *cancelar*.`, op.farm_id);
        return true;
      }
      const selected = options[idx];
      const { data: target } = await supabase.from("whatsapp_operators").select("*").eq("id", selected.id).maybeSingle();
      await clearConvState(phone);
      if (!target) {
        await sendWhatsAppText(from, "Não encontrei o operador selecionado. Envie o comando novamente.", op.farm_id);
        return true;
      }
      if (action === "exclude") {
        await sendWhatsAppText(from, `Para remover alguém com segurança, envie o pedido já com o nome. Exemplo: excluir ${target.full_name ?? target.name}.`, op.farm_id);
        return true;
      }
      return await sendOperatorActionPrompt(from, phone, op, target, action);
    }

    const matches = await findOperatorMatchesForAdmin(op, raw, Array.isArray(ctx.scopedFarmIds) ? ctx.scopedFarmIds : null);
    if (matches.length === 0) {
      await sendWhatsAppText(from, `Não encontrei operador com "*${raw}*". Envie o nome do operador ou *cancelar*.`, op.farm_id);
      return true;
    }
    if (matches.length > 1) {
      const limited = matches.slice(0, 8).map((m: any) => ({ id: m.id, name: m.full_name ?? m.name, phone: m.phone, farm_id: m.farm_id }));
      const list = limited.map((m: any, i: number) => `${i + 1}. ${m.name} — ${m.phone ?? "—"}`).join("\n");
      await saveConvState(phone, "selecting_operator", {
        ...ctx,
        action: action ?? ctx.action ?? null,
        options: limited,
        operatorQuery: raw,
      });
      await sendWhatsAppText(from, `Encontrei mais de um operador:\n${list}\n\nEnvie o número correto.`, op.farm_id);
      return true;
    }

    await clearConvState(phone);
    if (action === "exclude") {
      await sendWhatsAppText(from, `Para remover alguém com segurança, envie o pedido já com o nome. Exemplo: excluir ${matches[0].full_name ?? matches[0].name}.`, op.farm_id);
      return true;
    }
    return await sendOperatorActionPrompt(from, phone, op, matches[0], action);
  }

  return false;
}

const PROTECTED_MAIN_ADMIN_PHONES = new Set(["557799608294", "5577996082945"]);
function isProtectedMainAdmin(target: any): boolean {
  if (!target) return false;
  const phone = String(target.phone ?? "").replace(/\D/g, "");
  if (phone && PROTECTED_MAIN_ADMIN_PHONES.has(phone)) return true;
  const name = String(target.full_name ?? target.name ?? "").toLowerCase();
  if (name.includes("paulo gabriel") || name.includes("gabriel carneiro")) return true;
  return false;
}

async function applyOperatorAction(
  from: string, phone: string, op: any,
  d: { action: OpAction; operator_id: string; operator_name: string; operator_phone: string; farm_id: string | null },
): Promise<boolean> {
  if (d.action === "exclude") {
    // Defesa em profundidade: nunca exclui o administrador principal
    const { data: targetRow } = await supabase.from("whatsapp_operators")
      .select("id, phone, full_name, name").eq("id", d.operator_id).maybeSingle();
    if (isProtectedMainAdmin(targetRow ?? { phone: d.operator_phone, full_name: d.operator_name })) {
      await sendWhatsAppText(from, "Não é possível excluir o administrador principal.", op.farm_id);
      return true;
    }
    const { error } = await supabase.from("whatsapp_operators")
      .update({ is_active: false, approval_status: "revoked" })
      .eq("id", d.operator_id);
    if (error) { console.error("[applyOperatorAction:exclude]", error); await sendWhatsAppText(from, "❌ Ocorreu um erro interno. Tente novamente.", op.farm_id); return true; }
    await auditLog({
      event_type: "operator_revoked", actor_phone: phone, actor_name: op.name,
      target_phone: d.operator_phone, target_name: d.operator_name,
      farm_id: d.farm_id, details: { action: "exclude" },
    });
    await sendWhatsAppText(from, `${d.operator_name} foi removido do sistema.`, op.farm_id);
    // Silent exclusion: do NOT notify the revoked operator.
    return true;
  }
  if (d.action === "block" || d.action === "unblock") {
    const active = d.action === "unblock";
    const { error } = await supabase.from("whatsapp_operators")
      .update({ is_active: active }).eq("id", d.operator_id);
    if (error) { console.error("[applyOperatorAction:block]", error); await sendWhatsAppText(from, "❌ Ocorreu um erro interno. Tente novamente.", op.farm_id); return true; }
    await auditLog({
      event_type: active ? "operator_unblocked" : "operator_blocked",
      actor_phone: phone, actor_name: op.name,
      target_phone: d.operator_phone, target_name: d.operator_name,
      farm_id: d.farm_id, details: { action: d.action },
    });
    await sendWhatsAppText(from, active
      ? `✅ Operador *${d.operator_name}* desbloqueado.`
      : `🔒 Operador *${d.operator_name}* bloqueado. Pode ser reativado com *desbloquear ${d.operator_name}*.`, op.farm_id);
    return true;
  }
  return true;
}

// ─── Permission change commands (super_admin) ───────────────────────────────
// Examples:
//   "ativar áudio do Kennedy" / "desativar ia do Paulo"
//   "ativar controle do João" / "desativar programação da Maria"
//   "mudar permissões do Kennedy" → resends the permission question
async function handleOperatorPermissionCommands(
  from: string, phone: string, op: any, text: string,
): Promise<boolean> {
  const raw = (text || "").trim();
  const t = stripAccents(raw.toLowerCase());

  // ── NEW: super_admin pode delegar can_register / can_approve ──────────────
  // "dar permissão de cadastro para X" / "dar permissão de aprovação para X"
  // "remover permissão de aprovação do X" / "tirar permissão de cadastro de X"
  const mDelegate = t.match(/^(dar|conceder|adicionar|ativar|habilitar|liberar|remover|tirar|revogar|retirar|desativar|desabilitar)\s+(?:a\s+)?permiss(?:ao|oes)\s+de\s+(cadastro|aprovac[ao]o|registro)\s+(?:para|do|da|de|ao|a)\s+(.+)$/i);
  // "permissões do X" (consulta)
  const mShow = t.match(/^permiss(?:ao|oes)\s+(?:do|da|de)\s+(.+)$/i);

  if (mDelegate) {
    if (!(op?.role === "super_admin" || op?.is_super_admin === true)) {
      await sendWhatsAppText(from, "⚠️ Apenas o super_admin pode delegar permissões de cadastro ou aprovação.", op?.farm_id ?? null);
      return true;
    }
    const verb = mDelegate[1].toLowerCase();
    const field = mDelegate[2].toLowerCase();
    const targetName = mDelegate[3].replace(/[.!?]+$/g, "").trim();
    const turnOn = /^(dar|conceder|adicionar|ativar|habilitar|liberar)$/.test(verb);
    const { data: matches } = await supabase
      .from("whatsapp_operators")
      .select("*")
      .ilike("name", `%${targetName}%`)
      .eq("is_active", true)
      .limit(5);
    const list = (matches ?? []) as any[];
    if (list.length === 0) {
      await sendWhatsAppText(from, `❓ Não encontrei operador com nome "*${targetName}*".`, op?.farm_id ?? null);
      return true;
    }
    if (list.length > 1) {
      const names = list.map((o) => `• ${o.name}`).join("\n");
      await sendWhatsAppText(from, `Mais de um operador combina:\n${names}\n\nSeja mais específico.`, op?.farm_id ?? null);
      return true;
    }
    const tgt = list[0];
    const patch: any = {};
    let label = "";
    if (/^(cadastro|registro)$/.test(field)) { patch.can_register = turnOn; label = "Permissão de cadastrar operadores"; }
    else if (/^aprovac[ao]o$/.test(field)) { patch.can_approve = turnOn; label = "Permissão de aprovar cadastros"; }
    const { error } = await supabase.from("whatsapp_operators").update(patch).eq("id", tgt.id);
    if (error) {
      console.error("[delegate perm]", error);
      await sendWhatsAppText(from, "❌ Falha ao atualizar permissões.", op?.farm_id ?? null);
      return true;
    }
    await auditLog({
      event_type: "operator_delegation_changed", actor_phone: phone, actor_name: op.name,
      target_phone: tgt.phone, target_name: tgt.name,
      farm_id: tgt.farm_id, details: { patch },
    });
    await sendWhatsAppText(from, `✅ *${label}* ${turnOn ? "concedida" : "removida"} para *${tgt.name}*.`, op?.farm_id ?? null);
    return true;
  }

  const mPerms = t.match(/^(?:mudar|alterar|editar|configurar|definir)\s+(?:as\s+)?permiss[õo]es\s+(?:do|da|de)\s+(.+)$/i);
  const mPermsNoTarget = t.match(/^(?:mudar|alterar|editar|configurar|definir)\s+(?:as\s+)?permiss[õo]es\s*$/i);
  const mToggle = t.match(/^(ativar|desativar|ligar|desligar|habilitar|desabilitar)\s+(audio|ia|ai|controle|programac[ao]o|programacoes|alertas?)\s+(?:do|da|de)\s+(.+)$/i);

  // Pure show (no edit verb): "permissões do X"
  if (!mPerms && !mToggle && mShow && isRegistrationCodeAdmin(op)) {
    const targetName = mShow[1].replace(/[.!?]+$/g, "").trim();
    let q = supabase.from("whatsapp_operators").select("*").ilike("name", `%${targetName}%`).eq("is_active", true);
    const isSuperShow = op?.role === "super_admin" || op?.is_super_admin === true;
    if (!isSuperShow && op?.farm_id) q = q.eq("farm_id", op.farm_id);
    const { data: matches } = await q.limit(5);
    const list = (matches ?? []) as any[];
    if (list.length === 0) {
      await sendWhatsAppText(from, `❓ Não encontrei operador com nome "*${targetName}*".`, op.farm_id);
      return true;
    }
    if (list.length > 1) {
      const names = list.map((o) => `• ${o.name}`).join("\n");
      await sendWhatsAppText(from, `Mais de um operador combina:\n${names}\n\nSeja mais específico.`, op.farm_id);
      return true;
    }
    const tgt = list[0];
    await sendWhatsAppText(from,
      `Permissões atuais de *${tgt.name}*:\n` +
      `• Papel: *${tgt.role}*\n` +
      `• Controle: *${tgt.can_control ? "Sim" : "Não"}*\n` +
      `• Áudio: *${tgt.audio_enabled ? "Ativo" : "Inativo"}*\n` +
      `• IA: *${tgt.ai_enabled ? "Ativa" : "Bot simples"}*\n` +
      `• Programações: *${tgt.can_schedule ? "Sim" : "Não"}*\n` +
      `• Cadastrar operadores: *${tgt.can_register ? "Sim" : "Não"}*\n` +
      `• Aprovar cadastros: *${tgt.can_approve ? "Sim" : "Não"}*`,
      op.farm_id,
    );
    return true;
  }

  if (!mPerms && !mPermsNoTarget && !mToggle) return false;
  if (!isRegistrationCodeAdmin(op)) {
    await sendWhatsAppText(from, "⚠️ Apenas administradores podem alterar permissões.", op?.farm_id ?? null);
    return true;
  }

  if (mPermsNoTarget) {
    await saveConvState(phone, "selecting_operator", { action: "change_permissions" });
    await sendWhatsAppText(from, "Para qual operador?", op?.farm_id ?? null);
    return true;
  }

  const name = (mPerms?.[1] ?? mToggle?.[3] ?? "").replace(/[.!?]+$/g, "").trim();
  if (!name) return false;

  // Find target operator by name (scoped to admin's farm unless super_admin global)
  let q = supabase.from("whatsapp_operators")
    .select("*")
    .ilike("name", `%${name}%`)
    .eq("is_active", true);
  const isSuper = op?.role === "super_admin";
  if (!isSuper && op?.farm_id) q = q.eq("farm_id", op.farm_id);
  const { data: matches } = await q.limit(5);
  const list = (matches ?? []) as any[];
  if (list.length === 0) {
    await sendWhatsAppText(from, `❓ Não encontrei operador com nome "*${name}*".`, op.farm_id);
    return true;
  }
  if (list.length > 1) {
    if (mPerms) {
      const options = list.slice(0, 8).map((o: any) => ({ id: o.id, name: o.full_name ?? o.name, phone: o.phone, farm_id: o.farm_id }));
      const names = options.map((o: any, i: number) => `${i + 1}. ${o.name} — ${o.phone ?? "—"}`).join("\n");
      await saveConvState(phone, "selecting_operator", { action: "change_permissions", options, operatorQuery: name });
      await sendWhatsAppText(from, `Mais de um operador combina:\n${names}\n\nEnvie o número correto.`, op.farm_id);
      return true;
    }
    const names = list.map((o) => `• ${o.name}`).join("\n");
    await sendWhatsAppText(from, `Mais de um operador combina:\n${names}\n\nSeja mais específico.`, op.farm_id);
    return true;
  }
  const target = list[0];

  if (mPerms) {
    return await sendOperatorActionPrompt(from, phone, op, target, "change_permissions");
  }


  // Toggle path
  const verb = mToggle![1];
  const field = mToggle![2];
  const turnOn = /^(ativar|ligar|habilitar)$/.test(verb);
  const patch: any = {};
  let label = "";
  if (/^audio$/.test(field)) {
    patch.audio_enabled = turnOn;
    label = "Áudio";
  } else if (/^(ia|ai)$/.test(field)) {
    patch.ai_enabled = turnOn;
    label = "IA";
  } else if (/^controle$/.test(field)) {
    patch.can_control = turnOn;
    patch.can_turn_on = turnOn;
    patch.can_turn_off = turnOn;
    label = "Controle de equipamentos";
  } else if (/^(programac[ao]o|programacoes)$/.test(field)) {
    patch.can_schedule = turnOn;
    label = "Programações";
  } else if (/^alertas?$/.test(field)) {
    patch.receive_alerts = turnOn;
    label = "Alertas";
  }

  const { error } = await supabase.from("whatsapp_operators").update(patch).eq("id", target.id);
  if (error) {
    console.error("[perm change]", error);
    await sendWhatsAppText(from, "❌ Falha ao atualizar permissões.", op.farm_id);
    return true;
  }
  const { data: saved } = await supabase
    .from("whatsapp_operators")
    .select("*")
    .eq("id", target.id)
    .maybeSingle();
  console.log("[PERMISSIONS] operador atualizado", {
    phone: normalizePhone(saved?.phone ?? target.phone),
    role: saved?.role,
    audio_enabled: saved?.audio_enabled,
    ai_enabled: saved?.ai_enabled,
    can_control: saved?.can_control,
    can_schedule: saved?.can_schedule,
    receive_alerts: saved?.receive_alerts,
  });
  await auditLog({
    event_type: "operator_perms_changed", actor_phone: phone, actor_name: op.name,
    target_phone: target.phone, target_name: target.name,
    farm_id: target.farm_id, details: { patch },
  });
  await sendWhatsAppText(from, `✅ *${label}* ${turnOn ? "ativado" : "desativado"} para *${target.name}*.`, op.farm_id);
  return true;
}

async function handleOperatorManagementCommands(
  from: string, phone: string, op: any, text: string,
): Promise<boolean> {
  if (!text || !isOperatorManagementCommand(text)) return false;
  if (!isRegistrationCodeAdmin(op)) {
    await sendWhatsAppText(from, "⚠️ Apenas administradores podem gerenciar operadores.", op?.farm_id ?? null);
    return true;
  }
  const intent = parseOperatorMgmtIntent(text);
  if (!intent) return false;

  const isSuper = op?.role === "super_admin" || op?.is_super_admin === true;

  // Resolve farm scope
  let scopedFarmIds: string[] | null = null;
  let scopedFarmName: string | null = null;
  if (intent.farm) {
    const { data: farms } = await supabase
      .from("farms").select("id, name").ilike("name", `%${intent.farm}%`).limit(5);
    if (!farms || farms.length === 0) {
      await sendWhatsAppText(from, `Não encontrei fazenda com "*${intent.farm}*".`, op.farm_id);
      return true;
    }
    if (farms.length > 1) {
      const list = farms.map((f: any) => `• ${f.name}`).join("\n");
      await sendWhatsAppText(from, `Mais de uma fazenda combina:\n${list}\n\nSeja mais específico.`, op.farm_id);
      return true;
    }
    scopedFarmIds = [farms[0].id];
    scopedFarmName = farms[0].name;
  } else if (!isSuper && op.farm_id) {
    scopedFarmIds = [op.farm_id];
  }

  // ── LIST ────────────────────────────────────────────────────────────────
  if (intent.action === "list") {
    let q = supabase.from("whatsapp_operators")
      .select("id, name, full_name, cpf, phone, farm_id, is_active")
      .eq("is_active", true)
      .order("name", { ascending: true });
    if (scopedFarmIds) q = q.in("farm_id", scopedFarmIds);
    const { data: ops } = await q;
    if (!ops || ops.length === 0) {
      await sendWhatsAppText(from, scopedFarmName
        ? `Nenhum operador ativo na *${scopedFarmName}*.`
        : "Nenhum operador ativo encontrado.", op.farm_id);
      return true;
    }
    const farmIds = [...new Set(ops.map((o: any) => o.farm_id).filter(Boolean))];
    const { data: farms } = await supabase.from("farms").select("id, name").in("id", farmIds);
    const fmap = new Map((farms ?? []).map((f: any) => [f.id, f.name]));
    const header = scopedFarmName
      ? `👥 *Operadores ativos — ${scopedFarmName}:*`
      : `👥 *Operadores ativos:*`;
    const lines = ops.map((o: any, i: number) => {
      const nm = o.full_name || o.name || "—";
      const cpfPart = o.cpf ? ` — ${maskCpf(o.cpf)}` : "";
      const farmPart = !scopedFarmName && o.farm_id ? ` — ${fmap.get(o.farm_id) ?? "?"}` : "";
      return `${i + 1}. ${nm}${cpfPart}${farmPart}`;
    });
    await sendWhatsAppText(from, `${header}\n${lines.join("\n")}\n\nTotal: ${ops.length} operador${ops.length !== 1 ? "es" : ""}`, op.farm_id);
    return true;
  }

  // ── EXCLUDE / BLOCK / UNBLOCK: resolve operator by name ─────────────────
  const name = intent.name!;
  const nameNorm = stripAccents(name.toLowerCase());
  let q = supabase.from("whatsapp_operators")
    .select("*");
  if (scopedFarmIds) q = q.in("farm_id", scopedFarmIds);
  const { data: candidates } = await q;
  const tokens = nameNorm.split(/\s+/).filter(Boolean);
  const matches = (candidates ?? []).filter((c: any) => {
    const hay = stripAccents(`${c.full_name ?? ""} ${c.name ?? ""}`.toLowerCase());
    return tokens.every((tk) => hay.includes(tk));
  });

  if (matches.length === 0) {
    await sendWhatsAppText(from, `Não encontrei operador com "*${name}*"${scopedFarmName ? ` na *${scopedFarmName}*` : ""}.`, op.farm_id);
    return true;
  }
  if (matches.length > 1) {
    const options = matches.slice(0, 8).map((m: any) => ({ id: m.id, name: m.full_name ?? m.name, phone: m.phone, farm_id: m.farm_id }));
    const list = options.map((m: any, i: number) => `${i + 1}. ${m.name} — ${m.phone ?? "—"}`).join("\n");
    await saveConvState(phone, "selecting_operator", { action: intent.action, options, operatorQuery: name });
    await sendWhatsAppText(from, `Mais de um operador combina:\n${list}\n\nEnvie o número correto.`, op.farm_id);
    return true;
  }
  const target = matches[0] as any;

  if (intent.action === "exclude" && isProtectedMainAdmin(target)) {
    await sendWhatsAppText(from, "Não é possível excluir o administrador principal.", op.farm_id);
    return true;
  }

  if (intent.action === "change_permissions") {
    return await sendOperatorActionPrompt(from, phone, op, target, "change_permissions");
  }

  // For block/unblock, validate state coherence
  if (intent.action === "block" && !target.is_active) {
    await sendWhatsAppText(from, `*${target.full_name ?? target.name}* já está bloqueado.`, op.farm_id);
    return true;
  }
  if (intent.action === "unblock" && target.is_active) {
    await sendWhatsAppText(from, `*${target.full_name ?? target.name}* já está ativo.`, op.farm_id);
    return true;
  }

  if (isSuperAdmin(op) || op.skip_confirmation === true) {
    return await applyOperatorAction(from, phone, op, {
      action: intent.action as OpAction,
      operator_id: target.id,
      operator_name: target.full_name ?? target.name,
      operator_phone: target.phone,
      farm_id: target.farm_id ?? null,
    });
  }

  // ── Confirmation step ───────────────────────────────────────────────────
  const { data: farmRow } = target.farm_id
    ? await supabase.from("farms").select("name").eq("id", target.farm_id).maybeSingle()
    : { data: null as any };
  const farmName = (farmRow as any)?.name ?? "—";
  const verbMap = { exclude: "exclusão", block: "bloqueio", unblock: "desbloqueio", change_permissions: "alteração de permissões" } as const;
  const summary =
    `Confirma *${verbMap[intent.action as OpAction]}* do operador?\n\n` +
    `Nome: ${target.full_name ?? target.name}\n` +
    (target.cpf ? `CPF: ${maskCpf(target.cpf)}\n` : "") +
    `Fazenda: ${farmName}\n` +
    `Telefone: ${target.phone ?? "—"}\n\n` +
    `Responda *confirmar* ou *cancelar*.`;
  await supabase.from("registration_flow_state").upsert({
    phone, step: "admin_confirm_op_action", farm_id: target.farm_id,
    data: {
      action: intent.action,
      operator_id: target.id,
      operator_name: target.full_name ?? target.name,
      operator_phone: target.phone,
      farm_id: target.farm_id,
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: "phone" });
  await sendWhatsAppText(from, summary, op.farm_id);
  return true;
}



async function handleCodeRegistrationFlow(from: string, phone: string, text: string) {
  const msg = (text || "").trim();

  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await supabase.from("registration_flow_state").delete().lt("updated_at", cutoff);

  const { data: state } = await supabase
    .from("registration_flow_state").select("*").eq("phone", phone).maybeSingle();

  const setState = async (patch: Record<string, unknown>) => {
    await supabase.from("registration_flow_state")
      .update({ ...patch, updated_at: new Date().toISOString() }).eq("phone", phone);
  };
  const clearState = async () => {
    await supabase.from("registration_flow_state").delete().eq("phone", phone);
  };

  if (!state) {
    await supabase.from("registration_flow_state").insert({ phone, step: "await_code", data: {} });
    await sendWhatsAppText(from, "Seu número não está cadastrado. Informe o *código de acesso de 8 dígitos* para continuar.", null);
    return;
  }

  if (state.step === "await_admin_approval") {
    await sendWhatsAppText(from, "⏳ Seu cadastro está aguardando aprovação do administrador. Você será notificado assim que for liberado.", null);
    return;
  }

  if (state.step === "await_code") {
    if (!msg) return;
    const code = msg.replace(/\D/g, "");
    if (!REG_CODE_RE.test(code)) {
      await sendWhatsAppText(from, "Código inválido. Solicite um código de acesso ao administrador da fazenda.", null);
      return;
    }
    const { data: codeRow } = await supabase.from("registration_codes").select("*").eq("code", code).maybeSingle();
    const expired = codeRow && new Date(codeRow.expires_at).getTime() < Date.now();
    if (!codeRow) {
      await sendWhatsAppText(from, "Código inválido. Solicite um código de acesso ao administrador da fazenda.", null);
      return;
    }
    if (codeRow.status !== "active" || expired) {
      if (codeRow.status === "active" && expired) {
        await supabase.from("registration_codes").update({ status: "expired" }).eq("id", codeRow.id);
      }
      await sendWhatsAppText(from, "Código expirado. Solicite um novo ao administrador.", null);
      return;
    }

    // Vincular código ao telefone alvo: bloqueia uso por outro número
    if (codeRow.target_phone) {
      const tail8 = String(codeRow.target_phone).replace(/\D/g, "").slice(-8);
      const reqTail8 = normalizePhone(phone).slice(-8);
      if (tail8 !== reqTail8) {
        await sendWhatsAppText(from, "Este código foi gerado para outro número.", null);
        return;
      }
    }

    // MANDATORY: verification link must be clicked and GPS location granted
    const { data: ver } = await supabase
      .from("registration_verifications")
      .select("verified_at, location_denied, latitude, longitude")
      .eq("registration_code", code)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!ver) {
      await sendWhatsAppText(from, "Você precisa clicar no link de verificação e aceitar a localização antes de continuar. Verifique a mensagem anterior.", null);
      return;
    }
    if (!ver.verified_at || ver.location_denied || ver.latitude == null || ver.longitude == null) {
      await sendWhatsAppText(from, "A localização é obrigatória. Clique no link novamente e *aceite* a permissão de localização para continuar.", null);
      return;
    }

    const { data: farm } = await supabase.from("farms").select("name").eq("id", codeRow.farm_id).maybeSingle();
    await setState({
      step: "await_name", code, farm_id: codeRow.farm_id,
      data: { farm_name: (farm as any)?.name ?? null },
    });
    await sendWhatsAppText(from, "✅ Código aceito! Vou precisar de algumas informações para completar seu cadastro.\n\nQual seu *nome completo*?", null);
    return;
  }


  if (state.step === "await_name") {
    if (!msg || msg.length < 2 || !/\s/.test(msg)) {
      await sendWhatsAppText(from, "Por favor, envie seu *nome completo* (nome e sobrenome).", null);
      return;
    }
    const d = { ...(state.data || {}), full_name: msg.slice(0, 120) };
    await setState({ step: "await_cpf", data: d });
    await sendWhatsAppText(from, "Qual seu *CPF*?", null);
    return;
  }

  if (state.step === "await_cpf") {
    const digits = (msg || "").replace(/\D/g, "");
    if (digits.length !== 11) {
      await sendWhatsAppText(from, "CPF inválido. Envie os *11 dígitos*.", null);
      return;
    }
    const d = { ...(state.data || {}), cpf: digits };
    await setState({ step: "await_location", data: d });
    await sendWhatsAppText(from, "Qual sua *localização*? (cidade/estado)", null);
    return;
  }

  if (state.step === "await_location") {
    if (!msg || msg.length < 2) {
      await sendWhatsAppText(from, "Por favor, envie sua *localização* (ex: Barreiras - BA).", null);
      return;
    }
    const d = { ...(state.data || {}), location: msg.slice(0, 120) };
    await setState({ step: "await_confirm", data: d });
    const farmName = (d as any).farm_name ?? "—";
    await sendWhatsAppText(
      from,
      `*Confirme seus dados:*\n\n` +
      `Nome: ${(d as any).full_name}\n` +
      `CPF: ${formatCpf((d as any).cpf)}\n` +
      `Localização: ${(d as any).location}\n` +
      `Fazenda: ${farmName}\n\n` +
      `Está correto? (*sim* / *não*)`,
      null,
    );
    return;
  }

  if (state.step === "await_confirm") {
    const n = stripAccents((msg || "").trim().toLowerCase()).replace(/[.!?]+$/g, "");
    if (["sim", "s", "ok", "confirmar", "confirmo"].includes(n)) {
      const d: any = state.data || {};
      const { data: codeRow } = await supabase
        .from("registration_codes").select("*").eq("code", state.code).maybeSingle();
      const expired = codeRow && new Date(codeRow.expires_at).getTime() < Date.now();
      if (!codeRow || codeRow.status !== "active" || expired) {
        await clearState();
        await sendWhatsAppText(from, "O código expirou durante o cadastro. Solicite um novo ao administrador.", null);
        return;
      }

      const { data: farm } = await supabase.from("farms").select("name").eq("id", state.farm_id).maybeSingle();
      const farmName = (farm as any)?.name ?? (d.farm_name ?? "—");

      // Marca o código como usado (consome o convite) mas NÃO ativa o operador ainda.
      await supabase.from("registration_codes").update({
        status: "used", used_at: new Date().toISOString(), used_by_phone: phone,
      }).eq("id", codeRow.id);

      // Cria solicitação pendente de aprovação para rastreio
      const { data: reqIns, error: reqErr } = await supabase
        .from("whatsapp_registration_requests")
        .insert({
          phone: phone.startsWith("+") ? phone : `+${phone}`,
          name: d.full_name,
          farm_id: state.farm_id,
          farm_name_provided: farmName,
          role_provided: "operator",
          invite_code_used: state.code,
          status: "pending_approval",
          step: 4,
          registration_location_text: d.location ?? null,
          consent_given: true,
        })
        .select("id").maybeSingle();
      if (reqErr) {
        console.error("registration_request insert err", reqErr);
      }

      // Estado do registrante: aguardando aprovação (não limpar para preservar dados se necessário)
      await setState({ step: "await_admin_approval", data: { ...d, request_id: (reqIns as any)?.id ?? null } });

      // Determina os APROVADORES da fazenda: super_admin (global) + qualquer
      // operador com can_approve=true vinculado à fazenda. O admin que gerou
      // o código NÃO aprova sozinho (a menos que tenha can_approve=true).
      const generatorPhone = normalizePhone(codeRow.generated_by ?? codeRow.created_by_phone ?? "");
      const { data: approverRows } = await supabase
        .from("whatsapp_operators")
        .select("phone, role, can_approve, default_farm_id, farm_id, is_active")
        .eq("is_active", true);
      const approverList = (approverRows ?? []).filter((a: any) => {
        const role = String(a.role ?? "").toLowerCase();
        if (role === "super_admin") return true;
        if (a.can_approve === true) {
          return (a.default_farm_id === state.farm_id) || (a.farm_id === state.farm_id);
        }
        return false;
      });
      const approverPhones = Array.from(new Set(
        approverList.map((a: any) => normalizePhone(a.phone ?? "")).filter(Boolean),
      ));

      // Estado "aguardando aprovação" para cada aprovador.
      for (const ap of approverPhones) {
        const approvalContext = {
          target_phone: phone,
          operator_phone: phone,
          request_id: (reqIns as any)?.id ?? null,
          full_name: d.full_name,
          operator_name: d.full_name,
          cpf: d.cpf,
          location: d.location,
          farm_id: state.farm_id,
          farm_name: farmName,
          code: state.code,
          generator_phone: generatorPhone || null,
        };
        await supabase.from("registration_flow_state").upsert({
          phone: ap,
          step: "admin_await_review",
          farm_id: state.farm_id,
          data: approvalContext,
          updated_at: new Date().toISOString(),
        }, { onConflict: "phone" });
        await saveConvState(ap, "awaiting_approval", approvalContext);
      }


      await auditLog({
        event_type: "registration_pending_approval", actor_phone: phone, farm_id: state.farm_id,
        details: { code: state.code, full_name: d.full_name, cpf_masked: maskCpf(d.cpf), location: d.location, request_id: (reqIns as any)?.id ?? null },
      });
      await auditLog({
        event_type: "code_used", actor_phone: phone, farm_id: state.farm_id,
        details: { code: state.code, used_by: phone },
      });

      // Notifica o registrante
      await sendWhatsAppText(
        from,
        "Seu cadastro está pendente de aprovação. Você será avisado em breve.",
        state.farm_id,
      );

      // Busca dados de verificação (IP + GPS) associados ao código
      let verificationBlock = "📍 *Verificação de segurança:* ⚠️ NÃO VERIFICADO — pessoa não clicou no link.";
      try {
        const { data: vrow } = await supabase
          .from("registration_verifications")
          .select("ip_address, user_agent, latitude, longitude, location_accuracy, location_denied, city_from_ip, state_from_ip, verified_at")
          .eq("registration_code", state.code)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (vrow && (vrow as any).verified_at) {
          const v: any = vrow;
          const ua = String(v.user_agent ?? "");
          const device = /iPhone|iPad|iPod/i.test(ua) ? "iPhone/iPad"
            : /Android/i.test(ua) ? "Android"
            : /Windows/i.test(ua) ? "Windows"
            : /Mac OS/i.test(ua) ? "Mac"
            : /Linux/i.test(ua) ? "Linux"
            : "Desconhecido";
          const when = v.verified_at ? new Date(v.verified_at).toLocaleString("pt-BR", { timeZone: "America/Bahia" }) : "—";
          if (v.location_denied || (v.latitude == null && v.longitude == null)) {
            verificationBlock =
              `📍 *Verificação de segurança:*\n` +
              `GPS: Negado pelo usuário\n` +
              `IP: ${v.ip_address ?? "—"}\n` +
              `Dispositivo: ${device}\n` +
              `Verificado em: ${when}`;
          } else {
            const lat = Number(v.latitude);
            const lon = Number(v.longitude);
            const acc = v.location_accuracy != null ? ` ±${Math.round(Number(v.location_accuracy))}m` : "";

            // Reverse geocode via Nominatim (OpenStreetMap)
            let gpsCity = "";
            let gpsState = "";
            try {
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 5000);
              const r = await fetch(
                `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=pt-BR&zoom=10`,
                { headers: { "User-Agent": "RenovGestor/1.0 (suporte@renovtecnologia.com.br)" }, signal: ctrl.signal },
              );
              clearTimeout(t);
              if (r.ok) {
                const j = await r.json();
                const a = j?.address ?? {};
                gpsCity = a.city || a.town || a.village || a.municipality || a.county || "";
                gpsState = a.state_code || a.state || "";
              }
            } catch (e) { console.error("nominatim err", e); }
            const gpsLocLabel = [gpsCity, gpsState].filter(Boolean).join(", ");

            // Compara localização informada × GPS (match por substring de cidade)
            let matchLine = "";
            const informed = String(d.location ?? "").toLowerCase();
            if (informed && gpsCity) {
              const norm = (s: string) => s.toLowerCase()
                .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
                .replace(/[^a-z0-9 ]/g, " ");
              const ni = norm(informed);
              const nc = norm(gpsCity);
              const match = nc && (ni.includes(nc) || nc.split(" ").some((w) => w.length >= 4 && ni.includes(w)));
              matchLine = match
                ? `\n✅ Localização GPS bate com o informado.`
                : `\n⚠️ Localização GPS NÃO bate com o informado. Verifique.`;
            }

            verificationBlock =
              `📍 *Verificação de segurança:*\n` +
              `GPS: ${lat.toFixed(5)}, ${lon.toFixed(5)}${acc}\n` +
              (gpsLocLabel ? `📍 Local (GPS): ${gpsLocLabel}\n` : "") +
              `🗺️ Ver no mapa: https://maps.google.com/?q=${lat},${lon}\n` +
              `IP: ${v.ip_address ?? "—"}\n` +
              `Dispositivo: ${device}\n` +
              `Verificado em: ${when}` +
              matchLine;
          }
        }
      } catch (e) { console.error("fetch verification err", e); }

      // Notifica TODOS os aprovadores com a mensagem de revisão
      const reviewMsg =
        `🔔 *Novo cadastro pendente de aprovação:*\n\n` +
        `Nome: ${d.full_name}\n` +
        `CPF: ${formatCpf(d.cpf)}\n` +
        `Fazenda: ${farmName}\n` +
        `Localização informada: ${d.location ?? "—"}\n` +
        `Telefone: +${phone}\n` +
        `Código usado: ${state.code}\n\n` +
        `${verificationBlock}\n\n` +
        `Responda *aprovar* ou *rejeitar*.`;
      for (const ap of approverPhones) {
        try { await sendWhatsAppText(ap, reviewMsg, state.farm_id); }
        catch (e) { console.error("notify approver err", e); }
      }

      return;
    }
    if (["nao", "n", "cancelar", "errado"].includes(n)) {
      await setState({ step: "await_name", data: { farm_name: (state.data as any)?.farm_name ?? null } });
      await sendWhatsAppText(from, "Ok, vamos refazer. Qual seu *nome completo*?", null);
      return;
    }
    await sendWhatsAppText(from, "Responda *sim* para confirmar ou *não* para refazer.", null);
    return;
  }
}





async function processMessage(from: string, text: string, location: WaLocation = null) {
  const phone = normalizePhone(from);
  if (!phone) return;
  if (!text && !location) return;



  console.log("WA raw from Meta:", from, "| normalized:", phone);

  // ── First-message welcome: send Central de Ajuda uma única vez por número ──
  // A mensagem atual já foi registrada como "incoming" antes de chamarmos
  // processMessage. Se este é o único inbound existente, é a primeira interação.
  try {
    const last8 = phone.slice(-8);
    const { count: inboundCount } = await supabase
      .from("whatsapp_message_log")
      .select("id", { count: "exact", head: true })
      .ilike("phone", `%${last8}`)
      .eq("direction", "incoming");
    if ((inboundCount ?? 0) <= 1) {
      await sendWhatsAppText(from, HELP_MSG, null);
    }
  } catch (e) {
    console.error("first-message welcome check err", (e as Error).message);
  }

  // ── Short-circuit determinístico: pedidos de ajuda/menu/tutorial retornam
  // o HELP_MSG formatado SEM passar pelo Gemini/AI router.
  if (text) {
    const helpNorm = stripAccents(text.trim().toLowerCase()).replace(/\s+/g, " ");
    if (HELP_TRIGGERS.test(helpNorm)) {
      await sendWhatsAppText(from, HELP_MSG, null);
      return;
    }
  }



  // ── STEP A: lookup active operator ──────────────────────────────────────────
  const incomingTail8 = phone.slice(-8);
  const { data: operators } = await supabase
    .from("whatsapp_operators")
    .select("*")
    .eq("is_active", true);
  const operatorMatches = (operators ?? []).filter((o: any) => {
    const stored = normalizePhone(o.phone ?? "");
    return stored && stored.slice(-8) === incomingTail8;
  });
  // Se houver registros duplicados para o mesmo WhatsApp, super_admin vence sempre.
  // Isso evita cair em um registro comum/antigo e bloquear permissões do dono.
  const matched = operatorMatches.find((o: any) => isSuperAdmin(o)) ?? operatorMatches[0];

  // ── STEP B: unknown/revoked sender → permitir fluxo de cadastro por código ──
  if (!matched) {
    const trimmed = (text || "").trim();
    const digitsOnly = trimmed.replace(/\D/g, "");

    // É um código válido (8 dígitos) que existe e está ativo para este telefone?
    let hasValidCode = false;
    if (REG_CODE_RE.test(digitsOnly)) {
      const { data: codeRow } = await supabase
        .from("registration_codes")
        .select("id, status, expires_at, target_phone")
        .eq("code", digitsOnly)
        .maybeSingle();
      if (codeRow && codeRow.status === "active" && new Date(codeRow.expires_at).getTime() > Date.now()) {
        const tgt = codeRow.target_phone ? normalizePhone(codeRow.target_phone) : null;
        if (!tgt || tgt.slice(-8) === incomingTail8) hasValidCode = true;
      }
    }

    // Já existe um fluxo de cadastro ativo para este telefone?
    const { data: flowState } = await supabase
      .from("registration_flow_state")
      .select("phone, step")
      .eq("phone", phone)
      .maybeSingle();
    const hasActiveFlow = !!flowState;

    if (hasValidCode || hasActiveFlow) {
      await handleCodeRegistrationFlow(from, phone, text || "");
      return;
    }

    // Sem código e sem fluxo: verificar se era um operador previamente revogado/inativo
    const { data: inactiveRows } = await supabase
      .from("whatsapp_operators")
      .select("id, phone, is_active")
      .eq("is_active", false);
    const wasOperator = (inactiveRows ?? []).some((o: any) => {
      const stored = normalizePhone(o.phone ?? "");
      return stored && stored.slice(-8) === incomingTail8;
    });
    if (wasOperator) {
      await sendWhatsAppText(from, "Você não tem acesso ao sistema no momento. Envie status para ver a situação atual.");
      return;
    }

    await handleCodeRegistrationFlow(from, phone, text || "");
    return;
  }

  const op = matched;
  // super_admin tem IA SEMPRE ativa, independente do valor salvo no banco.
  // Mantém a propriedade efetiva verdadeira para todos os gates abaixo.
  if (isSuperAdmin(op)) {
    op.ai_enabled = true;
  }
  console.log("WA op:", op.name, "farm:", op.farm_id, "role:", op.role, "ai:", (op.ai_enabled === true || isSuperAdmin(op)));

  // Audit stamps for automation_schedules writes (read by trigger + UI)
  const _waAuditUpdate = { last_modified_by_name: op.name, last_modified_by_via: "whatsapp" } as const;
  const _waAuditCreate = { ..._waAuditUpdate, created_by_name: op.name, created_by_via: "whatsapp" } as const;

  let deterministicMaintenancePreempt = !!text && isMaintenanceDeterministicCommand(text);
  let deterministicAutoModePreempt = !!text && isAutoModeDeterministicCommand(text);

  // 1. Respostas curtas (sim/não) sempre verificam pending_actions primeiro.
  // Evita que o preemptor determinístico limpe o post_maintenance_ligar antes
  // da confirmação "Deseja ligar ... agora? (sim/não)".
  if (text && (isConfirmWord(text) || isNegationWord(text))) {
    const shortPendings = await fetchAllPending(phone);
    // Janela ampla (15 min) para respostas sim/não. Usuário pode demorar a responder
    // "Deseja ligar agora?" após liberar manutenção. Curto demais → cai na IA e quebra.
    const cutoffShort = Date.now() - 15 * 60 * 1000;
    const pending = shortPendings.find((p) =>
      new Date(p.created_at).getTime() >= cutoffShort
    );
    if (pending) {
      if (isConfirmWord(text)) {
        await deleteAllPending(phone);
        const farmIdExec = pending.farm_id ?? op.default_farm_id ?? op.farm_id ?? null;
        const turnOn = pending.action_type === "liga" || pending.action_type === "post_maintenance_ligar";
        await executeTurnCommands({
          from, phone, op, farmId: farmIdExec, turnOn,
          equipmentIds: [pending.equipment_id as string], originalText: text,
        });
        return;
      }

      const isPostMaint = pending.action_type === "post_maintenance_ligar";
      const eqName = (pending as any).equipment_name
        ?? (pending as any).original_text?.replace(/^liberar\s+/i, "")
        ?? "Equipamento";
      await deleteAllPending(phone);
      await sendWhatsAppText(
        from,
        isPostMaint ? `Ok, ${eqName} mantido desligado. ✅` : "👍 Ok, comando cancelado.",
        pending.farm_id ?? op.default_farm_id ?? op.farm_id ?? null,
      );
      return;
    }
  }

  // 1b. Pendência "auto_mode_select_equipment" — usuário respondendo qual equipamento
  //     deseja ativar/desativar modo automático. Consome a próxima mensagem como alvo.
  if (text && !isConfirmWord(text) && !isNegationWord(text)) {
    const amsPendings = await fetchAllPending(phone);
    const amsHit = amsPendings.find((p) =>
      p.action_type === "auto_mode_select_equipment"
      && new Date(p.created_at).getTime() >= Date.now() - PENDING_TTL_MS,
    );
    if (amsHit) {
      let ctx: { farm_id?: string; farm_name?: string; activate?: boolean } = {};
      try { ctx = JSON.parse(((amsHit as any).original_text as string) || "{}"); } catch (_e) { ctx = {}; }
      await deleteAllPending(phone);
      const combined = ctx.farm_name ? `${text} fazenda ${ctx.farm_name}` : text;
      await handleAutoMode(
        combined,
        ctx.activate !== false,
        phone,
        ctx.farm_id ?? amsHit.farm_id ?? op.default_farm_id ?? op.farm_id ?? "",
        from,
        op,
      );
      return;
    }

    // 1b'. Pendência "global_auto_select_farm" — super_admin escolhendo qual fazenda
    //      para o toggle global do modo automático.
    const gaHit = amsPendings.find((p) =>
      p.action_type === "global_auto_select_farm"
      && new Date(p.created_at).getTime() >= Date.now() - PENDING_TTL_MS,
    );
    if (gaHit) {
      let ctx: { activate?: boolean } = {};
      try { ctx = JSON.parse(((gaHit as any).original_text as string) || "{}"); } catch (_e) { ctx = {}; }
      await deleteAllPending(phone);
      const { data: allFarms } = await supabase.from("farms").select("id, name");
      const farms = ((allFarms ?? []) as any[]).filter((f) => f?.id && f?.name);
      const match = findFarmMentionInText(text, farms);
      if (!match) {
        await sendWhatsAppText(
          from,
          `❓ Não identifiquei essa fazenda. Fazendas disponíveis:\n${farms.map((f) => `• ${f.name}`).join("\n")}`,
          op.default_farm_id ?? op.farm_id ?? null,
        );
        return;
      }
      await runFarmWideAutoMode(match, ctx.activate !== false, phone, from, op);
      return;
  }

  // ── 1c. CLASSIFICADOR DE AÇÃO (Gemini) — AUTORITATIVO ───────────────────────
  // Para qualquer mensagem que NÃO seja confirmação/negação e que NÃO seja
  // claramente um comando de consulta (status/niveis/ops/ajuda/cadastr) nem já
  // tenha casado um preempt determinístico, o Gemini decide se é AÇÃO
  // (ligar/desligar/manutenção/modo automático) e reescreve em forma canônica.
  // O fluxo abaixo (preempts de manutenção/auto + DETERMINISTIC_CMD_RE de
  // ligar/desligar) re-detecta sobre o canonical e roteia para os executores
  // existentes (handleMaintenance, handleAutoMode, executeTurnCommands) —
  // mantendo audit log, command queue, notify e verificação de hardware.
  const QUERY_ONLY_RE = /^\s*(status|n[ií]vel|n[ií]veis|ops|ajuda|help|menu|cadastr|relat[oó]rio|programa|agendar|listar|ver\s|alarmes?|alertas?|codigo|c[oó]digo)/i;
  if (
    text &&
    !isConfirmWord(text) && !isNegationWord(text) &&
    !deterministicMaintenancePreempt && !deterministicAutoModePreempt &&
    !QUERY_ONLY_RE.test(text)
  ) {
    if (!isGeminiAvailable()) {
      // Circuit breaker aberto (5min TTL pós-falha). Não desperdiça latência
      // chamando o upstream — o regex legado abaixo assume o roteamento.
      const st = getClassifierStatus();
      console.warn(
        `[action-classifier] FALLBACK — Gemini indisponível, usando regex legado (reason=${st.lastFailureReason} ms_remaining=${st.msRemaining})`,
      );
    } else {
      try {
        const cls = await classifyAction(text);
        if (cls && cls.intent !== "conversa_livre" && cls.canonical && cls.confidence >= 0.55) {
          console.log("[action-classifier] AÇÃO detectada", {
            orig: text.slice(0, 80),
            intent: cls.intent,
            canonical: cls.canonical,
            confidence: cls.confidence,
          });
          text = cls.canonical;
          // Recalcula preempts com o texto canônico para que os handlers
          // determinísticos abaixo capturem corretamente.
          deterministicMaintenancePreempt = isMaintenanceDeterministicCommand(text);
          deterministicAutoModePreempt = isAutoModeDeterministicCommand(text);
        } else if (cls) {
          console.log("[action-classifier] conversa_livre/baixa confiança", {
            orig: text.slice(0, 80),
            intent: cls?.intent,
            confidence: cls?.confidence,
          });
        } else {
          // null pós-chamada → circuit acabou de abrir OU resposta vazia.
          // Caller cai no regex legado automaticamente.
          const st = getClassifierStatus();
          console.warn(
            `[action-classifier] FALLBACK — classificador retornou null, usando regex legado (reason=${st.lastFailureReason ?? "empty_response"})`,
          );
        }
      } catch (e) {
        console.error("[action-classifier] threw:", (e as Error).message);
      }
    }
  }
  }




  // Parser determinístico TEM prioridade absoluta sobre conversation_state.
  // Se for manutenção/liberação, qualquer estado ativo é descartado ANTES de
  // consultar/consumir fluxos conversacionais como data de visita/agendamento.
  if (deterministicMaintenancePreempt) {
    console.log("[deterministic-preempt] maintenance command before conversation_state", { phone_tail: phone.slice(-4) });
    await clearConvState(phone);
    try { await supabase.from("registration_flow_state").delete().eq("phone", phone); } catch (_e) { /* noop */ }
  }

  // ── BYPASS: confirmação/cancelamento e respostas a estado ativo NUNCA passam pela IA.
  // Evita a IA reinterpretar "confirmar" como nova exclusão ou outro comando.
  let deterministicParserBypass = false;
  if (deterministicMaintenancePreempt) deterministicParserBypass = true;
  if (deterministicAutoModePreempt) deterministicParserBypass = true;
  if (text) {
    const pendingsForBypass = await fetchAllPending(phone);
    const cutoffBypass = Date.now() - PENDING_TTL_MS;
    const cutoffPostMaintBypass = Date.now() - 120 * 1000;
    // Para sim/não amplia a janela: a resposta do usuário pode demorar.
    const isShortYesNo = isConfirmWord(text) || isNegationWord(text);
    const cutoffYesNo = Date.now() - 15 * 60 * 1000;
    const hasValidPending = pendingsForBypass.some((p) => {
      if (isShortYesNo) return new Date(p.created_at).getTime() >= cutoffYesNo;
      const ac = p.action_type === "post_maintenance_ligar" ? cutoffPostMaintBypass : cutoffBypass;
      return new Date(p.created_at).getTime() >= ac;
    });
    const hasCriticalState = await hasActiveAdminOrConversationState(phone);
    // Short-circuit: comandos determinísticos reconhecidos pelo parser regex
    // (status, modo automático, níveis, ligar/desligar bombas, programações, etc.)
    // NÃO devem passar pela IA — ela tem alucinado em casos como "modo automático
    // da fazenda X" e "Status Fazenda Y". O parser já cobre estes casos.
    const DETERMINISTIC_KINDS = new Set<string>([
      "status_all", "global_auto", "level", "ops", "auto_mode", "set_auto",
      "add_schedule", "del_schedule", "edit_schedule", "del_all_farm",
      "set_sched_active", "list_schedules", "list_holidays", "add_holiday",
      "schedule_help", "edit_help", "del_help",
    ]);
    let deterministicHit = false;
    try {
      const probe = parseCommand(text);
      if (probe && DETERMINISTIC_KINDS.has(probe.kind as string)) deterministicHit = true;
    } catch (_e) { /* ignore parser probe errors */ }

    // Super_admin: comandos determinísticos de gestão (cadastrar/excluir gestor)
    // NUNCA podem passar pela IA — ela tende a virar a resposta em "peça para a
    // pessoa se cadastrar sozinha", quebrando o fluxo de cadastro direto.
    const managerMgmtHit = !!text && isSuperAdmin(op) &&
      /^(cadastrar|registrar|criar|adicionar|novo|nova)\s+(um\s+|uma\s+|novo\s+|nova\s+)?(gestor|gerente|manager|administrador|admin)\b/i.test(
        stripAccents(text.toLowerCase()),
      );

    const maintenanceMgmtHit = deterministicMaintenancePreempt || /\b(manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo|bloquear|bloqueia|bloqueio|desbloquear|desbloqueia|travar|trava|liberar|libera)\b/i.test(
      stripAccents(text.toLowerCase()),
    );

    if ((hasValidPending && (isConfirmWord(text) || isNegationWord(text))) || hasCriticalState || deterministicHit || managerMgmtHit || maintenanceMgmtHit || deterministicAutoModePreempt) {
      console.log("[bypass] short-circuit AI router:", { hasValidPending, hasCriticalState, deterministicHit, managerMgmtHit, maintenanceMgmtHit, deterministicAutoModePreempt });
      if (deterministicHit) deterministicParserBypass = true;
      // cai direto no fluxo normal abaixo, que possui handlers de pendências/estado/parser.
    } else {
      const aiRes = await tryAiRouter(from, phone, op, text);
      if (aiRes === true) return;
      if (aiRes && typeof aiRes === "object" && "canonical" in aiRes) {
        // Overview: envia primeiro os níveis (canonical) e agenda o status
        // (followUp) para rodar depois, na mesma sessão. Ambos são comandos
        // determinísticos (níveis/status) e não voltam a passar pelo AI router.
        const followUp = (aiRes as any).followUp as string | undefined;
        if (followUp) {
          console.log("[overview] STEP 1 canonical=", aiRes.canonical, "STEP 2 followUp=", followUp);
          await processMessage(from, aiRes.canonical, location);
          console.log("[overview] STEP 1 done, running STEP 2:", followUp);
          text = followUp;
        } else {
          text = aiRes.canonical;
        }
        deterministicParserBypass = true;
        deterministicMaintenancePreempt = isMaintenanceDeterministicCommand(text);
        deterministicAutoModePreempt = isAutoModeDeterministicCommand(text);
      }
    }
  }



  // Fallback regex/contextual: só roda quando a IA não executou ação válida.
  if (!deterministicMaintenancePreempt && text && await handleAwaitingPermissionsInput(from, phone, op, text)) {
    return;
  }
  if (!deterministicMaintenancePreempt && text && await handleReservedApprovalKeyword(from, phone, op, text)) {
    return;
  }


  // ── DETERMINISTIC COMMAND PREEMPT ────────────────────────────────────────
  // Se a mensagem é um comando determinístico (status, níveis, ligar, etc.),
  // cancela QUALQUER conversation_state/pendência de visita ativa e segue para
  // o parser normal. Operador sempre pode interromper um fluxo enviando comando.
  if (text) {
    const _tDet = stripAccents(text.trim().toLowerCase()).replace(/[.!?]+$/g, "");
    const DETERMINISTIC_CMD_RE =
      /^(status|niveis?|n[ií]vel|ligar?|desligar?|liberar?|liga|desliga|programar?|programa[cç][aã]o|agendar?|alarmes?|alertas?|ops|operador(es)?|broadcast|aviso\s+geral|automa(tico|tismo)?|manual|ajuda|help|menu|codigo|c[oó]digo|aprovar|rejeitar|revogar|excluir|bloquear|desbloquear|relat[oó]rio|bombas?|po[cç]os?|equipamentos?|fazendas?|manuten[;cç]?[aã]o|manunte[;cç]?[aã]o|modo\s+manuten[;cç]?[aã]o|modo\s+manunte[;cç]?[aã]o|colocar\s+(?:modo\s+)?manuten[;cç]?[aã]o|colocar\s+(?:modo\s+)?manunte[;cç]?[aã]o|ativar\s+(?:modo\s+)?manuten[;cç]?[aã]o|ativar\s+(?:modo\s+)?manunte[;cç]?[aã]o|ativar\s+(?:modo\s+)?autom[aá]tico|desativar\s+(?:modo\s+)?autom[aá]tico|ligar\s+(?:modo\s+)?autom[aá]tico|desligar\s+(?:modo\s+)?autom[aá]tico)\b/;
    if (deterministicMaintenancePreempt || deterministicAutoModePreempt || DETERMINISTIC_CMD_RE.test(_tDet)) {
      try {
        await supabase
          .from("whatsapp_conversation_state")
          .delete()
          .eq("operator_phone", phone);
      } catch (_e) { /* noop */ }
    }
  }

  // ── MAINTENANCE VISIT SCHEDULING (resposta ao relatório diário de offline) ──
  if (!deterministicMaintenancePreempt && text && await handleMaintenanceVisitFlow(from, phone, op, text)) {
    return;
  }



  // ── CONVERSATION STATE: o bot perguntou algo? consumir a resposta ──────────
  if (text) {
    const convState = await getConvState(phone);
    if (convState) {
      const tNorm = stripAccents((text || "").trim().toLowerCase()).replace(/[.!?]+$/g, "");
      if (/^(cancelar?|sair|nada|esquece|esquecer)$/.test(tNorm)) {
        await clearConvState(phone);
        await sendWhatsAppText(from, "👍 Ok, cancelado.", op.farm_id ?? null);
        return;
      }
        if (!deterministicMaintenancePreempt && await handleOperatorConversationState(from, phone, op, text, convState)) {
          return;
        }
      if (convState.awaiting === "farm_selection") {
        const options = Array.isArray(convState.context?.options) ? convState.context.options : [];
        // status geral atalho
        if (/^status\s+geral$/.test(tNorm) || /^geral$/.test(tNorm)) {
          await clearConvState(phone);
          text = "status geral";
        } else {
          const picked = matchFarmFromText(text, options);
          if (picked) {
            await clearConvState(phone);
            const ctxCmd = String(convState.context?.context ?? "status");
            // reescreve o texto para o parser tratar como "<comando> fazenda <nome>"
            text = `${ctxCmd} fazenda ${picked.name}`;
          } else {
            // não bateu — se parece com novo comando, segue fluxo normal
            const looksLikeNewCommand = /^(ligar|desligar|liberar|programar|status|alarmes?|niveis?|n[ií]vel|automa|broadcast|aprovar|rejeitar|revogar|codigo|c[oó]digo|ajuda|help|cancelar|manuten[;cç]?[aã]o|manuntecao|modo\s+manuten[;cç]?[aã]o|modo\s+manuntecao|colocar\s+(?:modo\s+)?manuten[;cç]?[aã]o|colocar\s+(?:modo\s+)?manuntecao|ativar\s+(?:modo\s+)?manuten[;cç]?[aã]o|ativar\s+(?:modo\s+)?manuntecao|bloquear|desbloquear)/i.test(tNorm);
            if (!looksLikeNewCommand) {
              const numbered = options.map((f: any, i: number) => `${i + 1}. ${f.name}`).join("\n");
              await sendWhatsAppText(
                from,
                `Não reconheci essa fazenda. Responda com o *nome* ou o *número* da lista:\n\n${numbered}\n\nOu envie *cancelar*.`,
                op.farm_id ?? null,
              );
              return;
            }
            // novo comando: descarta o estado e segue
            await clearConvState(phone);
          }
        }
      }
    }
  }



  // ── STEP C.0a: REGISTRATION CODE ADMIN (super_admin: gerar/listar/cancelar) ─
  if (text && await handleDefaultFarmCommand(from, phone, op, text)) {
    return;
  }

  // ── STEP C.0a: REGISTRATION CODE ADMIN (super_admin: gerar/listar/cancelar) ─
  if (text && await handleRegistrationCodeAdminCommands(from, phone, op, text)) {
    return;
  }

  // ── STEP C.0b: OPERATOR MANAGEMENT (super_admin: listar/excluir/bloquear) ──
  // Gestão de operadores é catch-all e deve rodar depois dos comandos
  // determinísticos (manutenção, automático, equipamentos, níveis e agendas).
  if (text && !deterministicMaintenancePreempt && !deterministicAutoModePreempt && await handleOperatorManagementCommands(from, phone, op, text)) {
    return;
  }

  // ── STEP C.0c: PERMISSION CHANGES (super_admin: ativar/desativar áudio/IA/controle/programação) ──
  if (text && await handleOperatorPermissionCommands(from, phone, op, text)) {
    return;
  }


  // ── STEP C.0-mm: MASTER MANAGERS management (super_admin only) ─────────────
  // Runs BEFORE MANAGER REGISTRATION so "cadastrar gestor master" is captured here.
  if (text && await handleMasterManagerCommands(from, phone, op, text)) {
    return;
  }

  // ── STEP C.0: MANAGER REGISTRATION ASSISTANT (super_admin only) ────────────
  if (await handleManagerRegistrationFlow(from, phone, op, text, location)) {
    return;
  }


  // ── STEP C: approver/manager commands (APROVAR/REJEITAR/REVOGAR/codigo) ─────
  if (text && await handleApproverCommands(from, phone, op, text)) {
    return;
  }

  // ── STEP C.1: BROADCAST (super_admin / manager) ────────────────────────────
  if (text && await handleBroadcastCommand(from, phone, op, text)) {
    return;
  }






  // Roteamento IA vs Bot padrão (por operador).
  if ((op.ai_enabled === true || isSuperAdmin(op))) {
    // TODO: route to AI processing
  }


  // ===== MAINTENANCE PENDING (check BEFORE generic confirm/negation) =====
  // Suporta:
  //  • awaiting_numbers=true → operador deve responder com números/"todas".
  //  • equipment_ids preenchidos → texto vira motivo/confirmação para o lote.
  {
    const farmIdMP = op.farm_id ?? null;
    const tMP = stripAccents((text || "").trim().toLowerCase()).replace(/[.!?]+$/g, "");
    const { data: pendMPRows } = await supabase
      .from("whatsapp_maintenance_pending")
      .select("*")
      .eq("operator_phone", phone)
      .order("created_at", { ascending: false })
      .limit(1);
    const pendMP: any | null = (pendMPRows ?? [])[0] ?? null;
    if (pendMP) {
      const expired = pendMP.expires_at && new Date(pendMP.expires_at).getTime() < Date.now();
      if (expired) {
        await supabase.from("whatsapp_maintenance_pending").delete().eq("id", pendMP.id);
        await sendWhatsAppText(from, "⏰ Bloqueio de manutenção expirado. Envie o comando novamente.", farmIdMP);
        return;
      }
      if (isNegationWord(text) || /^cancelar?$/.test(tMP)) {
        await supabase.from("whatsapp_maintenance_pending").delete().eq("id", pendMP.id);
        await sendWhatsAppText(from, "👍 Bloqueio cancelado.", farmIdMP);
        return;
      }

      // --- AWAITING NUMBERS: operador respondendo "1,2,3" / "1-4" / "todas" ---
      if (pendMP.awaiting_numbers === true) {
        const base = pendMP.base_label || "";
        const { allOfType, nums } = parseBulkTargets(tMP);
        const variants = baseSearchVariants(base);
        const seen = new Set<string>();
        const pool: any[] = [];
        for (const v of variants) {
          const { data } = await supabase
            .from("equipments")
            .select("id, name, maintenance_mode")
            .eq("farm_id", farmIdMP)
            .ilike("name", `%${v}%`)
            .limit(200);
          for (const r of (data ?? []) as any[]) {
            if (!seen.has(r.id)) { seen.add(r.id); pool.push(r); }
          }
        }
        let bulkMatches: any[] = [];
        if (allOfType) {
          bulkMatches = pool;
        } else if (nums.length > 0) {
          bulkMatches = nums
            .map((n) => pool.find((e) => extractNumbers(e.name).includes(n)))
            .filter(Boolean) as any[];
        } else {
          await sendWhatsAppText(
            from,
            "❓ Não entendi. Envie os números separados por vírgula (ex: 1,2,3), um intervalo (ex: 1-4) ou 'todas'.",
            farmIdMP,
          );
          return;
        }
        // Filtra os que já estão em manutenção.
        bulkMatches = bulkMatches.filter((e) => e.maintenance_mode !== true);
        if (bulkMatches.length === 0) {
          await supabase.from("whatsapp_maintenance_pending").delete().eq("id", pendMP.id);
          await sendWhatsAppText(from, "ℹ️ Nenhum equipamento elegível para bloqueio (já em manutenção ou não encontrado).", farmIdMP);
          return;
        }
        await supabase
          .from("whatsapp_maintenance_pending")
          .update({
            awaiting_numbers: false,
            equipment_ids: bulkMatches.map((e) => e.id),
            equipment_names: bulkMatches.map((e) => e.name),
            equipment_id: bulkMatches[0].id,
            equipment_name: bulkMatches[0].name,
          })
          .eq("id", pendMP.id);
        const listLines = bulkMatches.map((e) => `• ${e.name}`).join("\n");
        const title = bulkMatches.length === 1
          ? `🔒 Bloquear ${bulkMatches[0].name} para manutenção?`
          : `🔒 Bloquear ${bulkMatches.length} equipamentos para manutenção?`;
        await sendWhatsAppText(
          from,
          `${title}\n\n${listLines}\n\nEnvie 'sim' para confirmar ou 'não' para cancelar.`,
          farmIdMP,
        );
        return;
      }

      // --- CONFIRMA bloqueio (motivo livre ou "sim") ---
      const rawText = (text || "").trim();
      const reason = isConfirmWord(text) ? null : rawText;
      await supabase.from("whatsapp_maintenance_pending").delete().eq("id", pendMP.id);

      // Determina o conjunto de equipamentos: prefere arrays bulk; fallback ao legado single.
      const ids: string[] = Array.isArray(pendMP.equipment_ids) && pendMP.equipment_ids.length > 0
        ? pendMP.equipment_ids
        : (pendMP.equipment_id ? [pendMP.equipment_id] : []);
      const names: string[] = Array.isArray(pendMP.equipment_names) && pendMP.equipment_names.length > 0
        ? pendMP.equipment_names
        : (pendMP.equipment_name ? [pendMP.equipment_name] : []);

      if (ids.length === 0) {
        await sendWhatsAppText(from, "⚠️ Pendência inválida. Envie o comando novamente.", farmIdMP);
        return;
      }

      const { data: eqRows } = await supabase
        .from("equipments")
        .select("id, name, desired_running, hw_id, saida, plc_group_id, farm_id")
        .in("id", ids);
      const eqMap = new Map<string, any>(((eqRows ?? []) as any[]).map((r) => [r.id, r]));

      const okLines: string[] = [];
      const errLines: string[] = [];
      const runningIds: string[] = [];
      const blockedEquipments: { id: string; name: string }[] = [];
      for (let i = 0; i < ids.length; i++) {
        const eid = ids[i];
        const nm = eqMap.get(eid)?.name ?? names[i] ?? "Equipamento";
        const { error: upErr } = await supabase
          .from("equipments")
          .update({
            maintenance_mode: true,
            maintenance_reason: reason && reason.length ? reason : null,
            maintenance_started_at: new Date().toISOString(),
            maintenance_started_by: op.name ?? phone,
            maintenance_started_via: "whatsapp",
            last_changed_by: op.name ?? phone,
            last_actuation_origin: "whatsapp",
          })
          .eq("id", eid);
        if (upErr) {
          errLines.push(`• ${nm} ❌ ${upErr.message}`);
          continue;
        }
        okLines.push(`• ${nm} ✅`);
        blockedEquipments.push({ id: eid, name: nm });
        if (eqMap.get(eid)?.desired_running === true) runningIds.push(eid);
        await auditLog({
          event_type: "maintenance_activated",
          actor_phone: phone, actor_name: op.name ?? null,
          farm_id: farmIdMP,
          details: { equipment_id: eid, equipment_name: nm, reason, via: "whatsapp" },
        });
      }

      // Notifica demais operadores da fazenda + super_admins (exceto quem executou).
      if (blockedEquipments.length > 0) {
        await dispatchMaintenanceNotify({
          equipments: blockedEquipments,
          farmId: farmIdMP,
          farmName: null,
          action: "block",
          changedBy: op.name ?? phone,
          actorPhone: phone,
        });
      }


      // Desliga em lote o que estava ligado.
      if (runningIds.length > 0) {
        try {
          await executeTurnCommands({
            from, phone, op,
            farmId: farmIdMP,
            turnOn: false,
            equipmentIds: runningIds,
            originalText: "desligar (manutenção)",
            silent: true,
          });
        } catch (_) { /* ignore */ }
      }

      const total = okLines.length;
      const isOne = total === 1 && errLines.length === 0;
      const header = isOne
        ? `🔒 ${names[0]} bloqueado para MANUTENÇÃO.`
        : `🔒 ${total} equipamentos bloqueados para MANUTENÇÃO:`;
      const namesCsv = names.map((n) => n.toLowerCase()).join(",");
      const msgParts: string[] = [header];
      if (!isOne) msgParts.push("", ...okLines);
      if (errLines.length) msgParts.push("", ...errLines);
      msgParts.push(
        "⚠️ Comandos remotos bloqueados (WhatsApp, sistema e automação).",
        "O bloqueio não impede acionamento local (chave no painel).",
        `Para liberar: envie 'liberar ${namesCsv}'`,
      );
      await sendWhatsAppText(from, msgParts.join("\n"), farmIdMP);
      return;
    }
  }



  // ===== CONFIRMAÇÃO de comandos pendentes (TTL 60s) =====

  const allPendings = await fetchAllPending(phone);
  const cutoffTs = Date.now() - PENDING_TTL_MS;
  const cutoffPostMaint = Date.now() - 120 * 1000;
  const validPendings = allPendings.filter((p) => {
    const ageCutoff = p.action_type === "post_maintenance_ligar" ? cutoffPostMaint : cutoffTs;
    return new Date(p.created_at).getTime() >= ageCutoff;
  });
  const expiredPendings = allPendings.filter((p) => {
    const ageCutoff = p.action_type === "post_maintenance_ligar" ? cutoffPostMaint : cutoffTs;
    return new Date(p.created_at).getTime() < ageCutoff;
  });

  // Pendências expiradas → limpa e avisa (apenas se NÃO houver válidas).
  if (validPendings.length === 0 && expiredPendings.length > 0) {
    await supabase
      .from("whatsapp_pending_actions")
      .delete()
      .in("id", expiredPendings.map((p) => p.id));
    await sendWhatsAppText(from, "⏰ Comando expirado. Envie o comando novamente.", op.farm_id);
    return;
  }

  // Pendência VÁLIDA existe → AI (se ativa) ou string-match exato decide.
  if (validPendings.length > 0) {
    const pending = validPendings[0];
    const desc = describePending(pending);

    type PendingDecision = { decision: "confirm" | "cancel" | "modify" | "unrelated"; confidence: number; reply?: string; new_command?: string };
    let decision: PendingDecision | null = null;

    if ((op.ai_enabled === true || isSuperAdmin(op))) {
      decision = await classifyPendingResponse(text, desc) as PendingDecision | null;
    } else {
      // Legacy: somente match exato de sim/não.
      const n = stripAccents((text || "").trim().toLowerCase()).replace(/[.!?]+$/g, "");
      if (["sim", "s", "ok", "confirmar", "confirmo"].includes(n)) {
        decision = { decision: "confirm", confidence: 1 };
      } else if (["nao", "n", "cancelar", "cancela"].includes(n)) {
        decision = { decision: "cancel", confidence: 1 };
      } else {
        decision = { decision: "unrelated", confidence: 1 };
      }
    }

    // Fallback se a IA falhou: re-pergunta sem perder a pendência.
    if (!decision) {
      await sendWhatsAppText(
        from,
        `⏳ Ainda tem um comando pendente: *${desc}*. Quer confirmar ou cancelar?`,
        op.farm_id,
      );
      return;
    }

    console.log(`[pending] decision=${decision.decision} conf=${decision.confidence} for "${text}" (pending: ${desc})`);

    if (decision.decision === "confirm") {
      await deleteAllPending(phone);
      // Segurança: uma confirmação executa somente a ÚLTIMA pendência mostrada.
      // As demais são limpas para evitar execução acidental em lote.
      const farmIdExec = pending.farm_id ?? op.farm_id;
      const turnOn = pending.action_type === "liga" || pending.action_type === "post_maintenance_ligar";
      await executeTurnCommands({
        from, phone, op, farmId: farmIdExec, turnOn,
        equipmentIds: [pending.equipment_id as string], originalText: text,
      });
      return;
    }


    if (decision.decision === "cancel") {
      const isPostMaint = pending.action_type === "post_maintenance_ligar";
      const eqName = (pending as any).equipment_name
        ?? (pending as any).original_text?.replace(/^liberar\s+/i, "")
        ?? "Equipamento";
      await deleteAllPending(phone);
      const reply = decision.reply?.trim() ||
        (isPostMaint
          ? `Ok, ${eqName} mantido desligado. ✅`
          : "👍 Ok, comando cancelado.");
      await sendWhatsAppText(from, reply, op.farm_id);
      return;
    }

    if (decision.decision === "modify") {
      // Operador quer outro comando: cancela o pendente e processa o novo texto.
      await deleteAllPending(phone);
      const newCmd = (decision.new_command || "").trim();
      if (newCmd) {
        console.log(`[pending] modify → re-roteando como "${newCmd}"`);
        text = newCmd;
        // segue o fluxo normal abaixo com o texto reescrito
      } else {
        await sendWhatsAppText(from, "👍 Comando anterior cancelado. Me diz o que quer fazer.", op.farm_id);
        return;
      }
    }

    if (decision.decision === "unrelated") {
      // No modo legacy, re-pergunta. No modo AI, mantém pendência viva e processa normal.
      if (op.ai_enabled !== true) {
        await sendWhatsAppText(
          from,
          `⏳ Comando pendente: *${desc}*. Responda *sim* para confirmar ou *não* para cancelar.`,
          op.farm_id,
        );
        return;
      }
      console.log(`[pending] unrelated — mantendo pendência viva`);
      // segue o fluxo normal abaixo
    }
  }




  // ===== PREFERÊNCIA DE NOTIFICAÇÃO DO OPERADOR =====
  // (WhatsApp Cloud API não suporta grupos — apenas privado/mudo/padrão)
  {
    const tN = stripAccents((text || "").trim().toLowerCase()).replace(/[.!?]+$/g, "");
    const mute = /^(silenciar\s+notificac\w*|notificac\w*\s+(mudo|mute|silenciar|silenciado))$/.test(tN);
    const priv = /^notificac\w*\s+(privad\w*|individual)$/.test(tN);
    const def = /^notificac\w*\s+(padrao|default|normal)$/.test(tN);
    const show = /^(notificac\w*|notificac\w*\s+status|status\s+notificac\w*)$/.test(tN);
    if (mute || priv || def || show) {
      const newPref = mute ? "mute" : priv ? "private" : def ? "default" : null;
      if (newPref) {
        await supabase.from("whatsapp_operators")
          .update({ notification_preference: newPref })
          .eq("id", op.id);
        const labels: Record<string, string> = {
          private: "🔔 Você passará a receber alertas no *privado*.",
          default: "🔔 Preferência reposta para o *padrão*.",
          mute: "🔇 Notificações *silenciadas*. Você continua podendo enviar comandos.",
        };
        await sendWhatsAppText(from, labels[newPref], op.farm_id);
        return;
      }
      // show current
      const { data: me } = await supabase
        .from("whatsapp_operators").select("notification_preference").eq("id", op.id).maybeSingle();
      const cur = (me as any)?.notification_preference ?? "default";
      const map: Record<string, string> = {
        default: "Padrão",
        private: "Sempre privado",
        mute: "Silenciado",
      };
      await sendWhatsAppText(
        from,
        `🔔 *Sua preferência de notificação:* ${map[cur] ?? cur}\n\nMudar com:\n• notificações privado\n• notificações mudo\n• notificações padrão`,
        op.farm_id,
      );
      return;
    }
  }




  const tAlert = stripAccents((text || "").trim().toLowerCase()).replace(/[.!?]+$/g, "");
  const alertOn = /^(alertas?\s+on|alertas?\s+ativ\w*|ativar\s+alertas?|ligar\s+alertas?)$/.test(tAlert);
  const alertOff = /^(alertas?\s+off|alertas?\s+desativ\w*|desativar\s+alertas?|desligar\s+alertas?|pausar\s+alertas?|parar\s+alertas?|silenciar\s+alertas?|mutar\s+alertas?|alertas?\s+(mudo|mute|silencia\w*))$/.test(tAlert);
  const alertStatus = /^(alertas?|alertas?\s+proativos?|alertas?\s+on\/?off|alertas?\s+status|status\s+alertas?)$/.test(tAlert);
  if (alertOn || alertOff || alertStatus) {
    if (alertOn || alertOff) {
      const desired = alertOn;
      await supabase.from("whatsapp_operators")
        .update({ receive_alerts: desired }).eq("id", op.id);
      await sendWhatsAppText(
        from,
        desired
          ? "✅ Alertas proativos ativados. Você receberá notificações de eventos importantes."
          : "✅ Alertas proativos desativados. Você não receberá mais notificações automáticas.",
        op.farm_id,
      );
      return;
    }
    // status / toggle prompt
    const { data: me } = await supabase
      .from("whatsapp_operators").select("receive_alerts").eq("id", op.id).maybeSingle();
    const on = (me as any)?.receive_alerts !== false;
    await sendWhatsAppText(
      from,
      on
        ? "Seus alertas proativos estão *ativados*. Deseja desativar? Envie *alertas off*."
        : "Seus alertas proativos estão *desativados*. Deseja ativar? Envie *alertas on*.",
      op.farm_id,
    );
    return;
  }

  // ===== MAINTENANCE COMMANDS (manutenção / bloquear / liberar) ===============
  // Intercepta antes do parseCommand para dar suporte a fluxo conversacional
  // (pedido de motivo após "manutenção poço X").
  {
    let farmIdM: string | null = op.default_farm_id ?? op.farm_id ?? null;
    try {
      const { data: farmRowsM } = await supabase
        .from("farms")
        .select("id, name")
        .order("name", { ascending: true });
      const farmsM = ((farmRowsM ?? []) as any[]).filter((f) => f?.id && f?.name);
      const mentionedFarm = findFarmMentionInText(text || "", farmsM);
      if (mentionedFarm && (isSuperAdmin(op) || op.farm_id === mentionedFarm.id || op.default_farm_id === mentionedFarm.id)) {
        farmIdM = mentionedFarm.id;
      }
    } catch (_e) { /* mantém fazenda padrão do operador */ }
    const tM = stripAccents((text || "").trim().toLowerCase()).replace(/[.!?]+$/g, "");

    // 0) NOVA INTENÇÃO: "manutenção concluída/resolvida/finalizada/pronta" → broadcast global.
    // Restrito a super_admin/admin. Sempre antes da detecção legada para que
    // "X pronto", "manutenção concluída X" etc. não caiam no release simples.
    if (text && isMaintenanceCompletedText(text)) {
      console.log("[maintenance_completed] detected", { phone_tail: phone.slice(-4), text: text.slice(0, 80) });
      if (await handleMaintenanceCompleted(from, phone, op, text, farmIdM)) return;
    }


    // 1) Há uma "manutenção pendente" para este telefone? Tratar este texto como motivo/confirmação.
    const { data: pendMRows } = await supabase
      .from("whatsapp_maintenance_pending")
      .select("*")
      .eq("operator_phone", phone)
      .order("created_at", { ascending: false })
      .limit(1);
    const pendM: any | null = (pendMRows ?? [])[0] ?? null;
    const freshMaintCommandWhilePending = /^(?:(?:colocar|ativar|modo)\s+)?(?:modo\s+)?(?:manuten[;cç]?[aã]o(?:es)?|manuntecao)\s+.+/.test(tM)
      || /^(?:bloquear|bloqueia|travar|trava|liberar|libera|desbloquear|desbloqueia|tirar|desativar|desativa)\s+.+/.test(tM);
    if (pendM) {
      const expired = pendM.expires_at && new Date(pendM.expires_at).getTime() < Date.now();
      if (expired) {
        await supabase.from("whatsapp_maintenance_pending").delete().eq("id", pendM.id);
      } else if (freshMaintCommandWhilePending) {
        // Novo comando completo deve preemptar a pergunta pendente de motivo/confirmação.
        await supabase.from("whatsapp_maintenance_pending").delete().eq("id", pendM.id);
      } else if (isNegationWord(text) || /^cancelar?$/.test(tM)) {
        await supabase.from("whatsapp_maintenance_pending").delete().eq("id", pendM.id);
        await sendWhatsAppText(from, "👍 Bloqueio cancelado.", farmIdM);
        return;
      } else {
        // Aceita como motivo (ou "sim" sem motivo).
        const reason = isConfirmWord(text) ? null : (text || "").trim();
        await supabase.from("whatsapp_maintenance_pending").delete().eq("id", pendM.id);
        const { error: upErr } = await supabase
          .from("equipments")
          .update({
            maintenance_mode: true,
            maintenance_reason: reason && reason.length ? reason : null,
            maintenance_started_at: new Date().toISOString(),
            maintenance_started_by: op.name ?? phone,
            maintenance_started_via: "whatsapp",
            last_changed_by: op.name ?? phone,
            last_actuation_origin: "whatsapp",
          })
          .eq("id", pendM.equipment_id);
        if (upErr) {
          await sendWhatsAppText(from, `❌ Falha ao bloquear: ${upErr.message}`, farmIdM);
          return;
        }
        await auditLog({
          event_type: "maintenance_activated",
          actor_phone: phone, actor_name: op.name ?? null,
          farm_id: farmIdM,
          details: { equipment_id: pendM.equipment_id, equipment_name: pendM.equipment_name, reason, via: "whatsapp" },
        });
        const lines = [
          `🔒 ${pendM.equipment_name} bloqueado para MANUTENÇÃO.`,
          "⚠️ Comandos remotos bloqueados (WhatsApp, sistema e automação).",
          "O bloqueio não impede acionamento local (chave no painel).",
          `Para liberar: envie 'liberar ${pendM.equipment_name.toLowerCase()}'`,
        ];
        await sendWhatsAppText(from, lines.join("\n"), farmIdM);
        return;
      }
    }

    // 2) Detecção expandida de comandos de manutenção (list / block / release).
    //    Sinônimos suportados conforme especificação UX.
    const detectMaint = (s: string): { kind: "list" | "block" | "release" | "release_no_target" | "block_no_target"; rest?: string } | null => {
      // LIST (sem alvo) — "manutenção", "quais em manutenção"
      if (/^(?:em\s+)?(?:manuten[;cç]?[aã]o(?:es)?|manuntecao)$/.test(s)) return { kind: "list" };
      if (/^em\s+reparo$/.test(s)) return { kind: "list" };
      if (/^reparo$/.test(s)) return { kind: "list" };
      if (/^quais\s+em\s+(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)$/.test(s)) return { kind: "list" };
      if (/^(?:listar|ver)\s+(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)$/.test(s)) return { kind: "list" };

      // RELEASE sem alvo: "tirar modo manutencao", "remover manutencao", "liberar manutencao", "desligar modo manutencao"
      if (/^(?:tirar|remove(?:r)?|desativar|desativa|finalizar|finaliza|liberar|libera|desbloquear|desbloqueia|destrava(?:r)?|desligar|desliga|desabilitar|desabilita)\s+(?:o\s+|a\s+|da\s+|do\s+)?(?:modo\s+)?(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)$/.test(s)) {
        return { kind: "release_no_target" };
      }
      if (/^sair\s+d[ao]\s+(?:modo\s+)?(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)$/.test(s)) {
        return { kind: "release_no_target" };
      }
      // BLOCK sem alvo: "colocar modo manutencao", "ativar manutencao", "ligar modo manutencao"
      if (/^(?:colocar|coloca|botar|bota|ativar|ativa|por|poe|dar|ligar|liga|habilitar|habilita)\s+(?:em\s+)?(?:modo\s+)?(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)$/.test(s)) {
        return { kind: "block_no_target" };
      }

      let m: RegExpMatchArray | null;

      // BLOCK determinístico pedido em campo:
      if ((m = s.match(/^(?:(?:colocar|ativar|ligar|liga|habilitar|modo)\s+)?(?:modo\s+)?(?:manuten[;cç]?[aã]o(?:es)?|manuntecao)\s+(.+)$/))) {
        return { kind: "block", rest: m[1].trim() };
      }

      // BLOCK: "colocar/ativar/ligar modo manutenção poço 03"
      if ((m = s.match(/^(?:colocar|coloca|botar|bota|ativar|ativa|ligar|liga|habilitar|habilita|por|poe)\s+(?:em\s+)?(?:modo\s+)?(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)\s+(.+)$/))) {
        return { kind: "block", rest: m[1].trim() };
      }

      // RELEASE: "tirar/desativar/desligar modo manutenção poço 03"
      if ((m = s.match(/^(?:tirar|remove(?:r)?|desativar|desativa|desligar|desliga|desabilitar|desabilita|finalizar|finaliza|liberar|libera)\s+(?:o\s+)?(?:modo\s+)?(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)\s+(.+)$/))) {
        return { kind: "release", rest: m[1].trim() };
      }

      // RELEASE
      if ((m = s.match(/^(?:liberar|libera|desbloquear|desbloqueia|destrava|destravar|liberacao)\s+(.+)$/))) {
        const r = m[1].trim();
        const m2 = r.match(/^(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)\s+(.+)$/);
        return { kind: "release", rest: (m2 ? m2[1] : r).trim() };
      }
      if ((m = s.match(/^tirar\s+(.+?)\s+d[ao]\s+(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)$/))) return { kind: "release", rest: m[1].trim() };
      if ((m = s.match(/^remover\s+(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)\s+(.+)$/))) return { kind: "release", rest: m[1].trim() };
      if ((m = s.match(/^sair\s+d[ao]\s+(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)\s+(.+)$/))) return { kind: "release", rest: m[1].trim() };
      if ((m = s.match(/^(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)\s+conclu[ií]d[ao]\s+(.+)$/))) return { kind: "release", rest: m[1].trim() };
      if ((m = s.match(/^finalizar\s+(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)\s+(.+)$/))) return { kind: "release", rest: m[1].trim() };
      if ((m = s.match(/^(.+)\s+(?:pronto|pronta|liberado|liberada)$/))) return { kind: "release", rest: m[1].trim() };

      // BLOCK com marcador de manutenção/reparo (sufixo " para|pra|em manutenção/reparo")
      const maintMarker = /\s+(?:p(?:a)?ra|em)\s+(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)$/;
      if (maintMarker.test(s)) {
        const stripped = s.replace(maintMarker, "").trim();
        const m3 = stripped.match(/^(?:bloquear|bloqueia|parar|para|desativar|desativa|desligar|desliga|travar|trava|colocar|coloca|botar|bota|por|poe)\s+(.+)$/);
        return { kind: "block", rest: (m3 ? m3[1] : stripped).trim() };
      }

      // BLOCK por prefixo
      if ((m = s.match(/^(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo|bloquear|bloqueia|bloqueio|travar|trava)\s+(.+)$/))) {
        return { kind: "block", rest: m[1].trim() };
      }
      if ((m = s.match(/^dar\s+(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)\s+(.+)$/))) {
        return { kind: "block", rest: m[1].trim() };
      }
      // BLOCK por sufixo "<equip> manutenção/reparo"
      if ((m = s.match(/^(.+)\s+(?:manuten[;cç]?[aã]o(?:es)?|manuntecao|reparo)$/))) {
        return { kind: "block", rest: m[1].trim() };
      }

      return null;
    };

    const maintDet = detectMaint(tM);

    if (maintDet?.kind === "list") {
      if (!farmIdM) {
        await sendWhatsAppText(from, "⚠️ Operador sem fazenda vinculada.", null);
        return;
      }
      const { data: mEqs } = await supabase
        .from("equipments")
        .select("name, maintenance_reason, maintenance_started_at, maintenance_started_by")
        .eq("farm_id", farmIdM)
        .eq("maintenance_mode", true)
        .order("name");
      const list = (mEqs ?? []) as any[];
      if (list.length === 0) {
        await sendWhatsAppText(from, "✅ Nenhum equipamento em manutenção.", farmIdM);
        return;
      }
      const out = ["🔧 Equipamentos em manutenção:", ""];
      for (const e of list) {
        const dur = fmtMaintDuration(e.maintenance_started_at);
        const motivo = e.maintenance_reason ? ` — ${e.maintenance_reason}` : "";
        out.push(`• ${e.name}${motivo} (desde ${fmtMaintStarted(e.maintenance_started_at)}${dur ? `, ${dur}` : ""})`);
      }
      out.push("", "Para liberar: liberar <equipamento>");
      await sendWhatsAppText(from, out.join("\n"), farmIdM);
      return;
    }

    if (maintDet?.kind === "release_no_target") {
      if (!farmIdM) {
        await sendWhatsAppText(from, "⚠️ Operador sem fazenda vinculada.", null);
        return;
      }
      const { data: mEqs } = await supabase
        .from("equipments")
        .select("name")
        .eq("farm_id", farmIdM)
        .eq("maintenance_mode", true)
        .order("name");
      const list = ((mEqs ?? []) as any[]).map((e) => e.name);
      if (list.length === 0) {
        await sendWhatsAppText(from, "ℹ️ Nenhum equipamento está em manutenção no momento.", farmIdM);
        return;
      }
      const numbered = list.map((n, i) => `${i + 1}. ${n}`).join("\n");
      await sendWhatsAppText(
        from,
        `🔓 Qual equipamento deseja liberar da manutenção?\n\n${numbered}\n\nResponda com o nome (ex: 'liberar ${list[0].toLowerCase()}') ou envie *cancelar*.`,
        farmIdM,
      );
      return;
    }

    if (maintDet?.kind === "block_no_target") {
      if (!farmIdM) {
        await sendWhatsAppText(from, "⚠️ Operador sem fazenda vinculada.", null);
        return;
      }
      await sendWhatsAppText(
        from,
        "🔒 Qual equipamento deseja colocar em manutenção?\n\nExemplo: *colocar modo manutenção poço 03*",
        farmIdM,
      );
      return;
    }

    if (maintDet?.kind === "block" || maintDet?.kind === "release") {


      if (!farmIdM) {
        await sendWhatsAppText(from, "⚠️ Operador sem fazenda vinculada.", null);
        return;
      }
      const isBlock = maintDet.kind === "block";
      const rest = (maintDet.rest ?? "").trim();

      // Extrai base (tokens não-numéricos iniciais; ignora "todos/todas/os/as").
      const FILLER = new Set(["todos","todas","todo","toda","os","as","o","a","de","do","da","para","pra","em"]);
      const tokens = rest.split(/[\s,]+/).filter(Boolean);
      const baseToks: string[] = [];
      for (const tk of tokens) {
        const norm = stripAccents(tk).toLowerCase();
        if (/^\d/.test(norm) || /-/.test(norm)) break;
        if (FILLER.has(norm)) continue;
        baseToks.push(tk);
      }
      if (baseToks.length === 0 && tokens.length > 0) baseToks.push(tokens[0]);
      const baseCanon = resolveBaseFromTokens(baseToks) || baseToks.join(" ");
      const base = baseCanon;

      const { allOfType, nums } = parseBulkTargets(rest);
        const hasExplicitEquipmentTarget = nums.length > 0 || allOfType;

      // Pool de equipamentos da base.
      const variants = baseSearchVariants(base);
      const seen = new Set<string>();
      const pool: any[] = [];
      for (const v of variants) {
        const { data } = await supabase
          .from("equipments")
            .select("id, name, maintenance_mode, maintenance_reason, maintenance_started_at, maintenance_started_by, desired_running")
          .eq("farm_id", farmIdM)
          .ilike("name", `%${v}%`)
          .limit(200);
        for (const r of (data ?? []) as any[]) {
          if (!seen.has(r.id)) { seen.add(r.id); pool.push(r); }
        }
      }

      // Resolve matches segundo a forma do comando.
      let matches: any[] = [];
      let pluralWithoutNums = false;
      if (allOfType) {
        matches = pool;
      } else if (nums.length > 0) {
        matches = nums
          .map((n) => pool.find((e) => extractNumbers(e.name).includes(n)))
          .filter(Boolean) as any[];
      } else if (isBlock && isPluralBaseWithoutNumbers(rest)) {
        // "parar bombas para manutenção" → pergunta quais.
        pluralWithoutNums = true;
      } else {
        // Forma singular sem número → primeiro do tipo.
        matches = pool.slice(0, 1);
      }

      // BLOCK → pergunta quais quando plural sem números.
      if (isBlock && pluralWithoutNums) {
        if (op.can_turn_off === false && !isSuperAdmin(op)) {
          await sendWhatsAppText(from, "🚫 Você não tem permissão para bloquear equipamentos.", farmIdM);
          return;
        }
        await supabase.from("whatsapp_maintenance_pending").delete().eq("operator_phone", phone);
        await supabase.from("whatsapp_maintenance_pending").insert({
          operator_phone: phone,
          farm_id: farmIdM,
          operator_id: op.id ?? null,
          awaiting_numbers: true,
          base_label: base,
          equipment_ids: [],
          equipment_names: [],
        });
        const baseLabel = base.endsWith("s") ? base : `${base}s`;
        await sendWhatsAppText(
          from,
          `🔒 Quais ${baseLabel} deseja bloquear para manutenção?\n\n` +
          `Envie os números separados por vírgula (ex: 1,2,3), um intervalo (ex: 1-4) ou 'todas':`,
          farmIdM,
        );
        return;
      }

      if (matches.length === 0) {
        await sendWhatsAppText(from, `❓ Equipamento "${rest}" não encontrado.`, farmIdM);
        return;
      }

      if (isBlock) {
        if (op.can_turn_off === false && !isSuperAdmin(op)) {
          await sendWhatsAppText(from, "🚫 Você não tem permissão para bloquear equipamentos.", farmIdM);
          return;
        }
        // Filtra os já bloqueados.
        const already = matches.filter((e) => e.maintenance_mode === true);
        const eligible = matches.filter((e) => e.maintenance_mode !== true);
        if (eligible.length === 0) {
          const lines = already.map((e) => `• ${e.name}${e.maintenance_reason ? ` — ${e.maintenance_reason}` : ""}`);
          await sendWhatsAppText(
            from,
            `ℹ️ ${already.length === 1 ? "Equipamento já está" : "Equipamentos já estão"} em manutenção:\n${lines.join("\n")}`,
            farmIdM,
          );
          return;
        }
        if (hasExplicitEquipmentTarget) {
          await supabase.from("whatsapp_maintenance_pending").delete().eq("operator_phone", phone);
          const okLines: string[] = [];
          const errLines: string[] = [];
          const runningIds: string[] = [];
          const blockedEquipments: { id: string; name: string }[] = [];
          for (const eq of eligible) {
            const { error: upErr } = await supabase
              .from("equipments")
              .update({
                maintenance_mode: true,
                maintenance_reason: null,
                maintenance_started_at: new Date().toISOString(),
                maintenance_started_by: op.name ?? phone,
                maintenance_started_via: "whatsapp",
                last_changed_by: op.name ?? phone,
                last_actuation_origin: "whatsapp",
              })
              .eq("id", eq.id)
              .eq("farm_id", farmIdM);
            if (upErr) {
              errLines.push(`• ${eq.name} ❌ ${upErr.message}`);
              continue;
            }
            okLines.push(`• ${eq.name} ✅`);
            blockedEquipments.push({ id: eq.id, name: eq.name });
            if (eq.desired_running === true) runningIds.push(eq.id);
            await auditLog({
              event_type: "maintenance_activated",
              actor_phone: phone,
              actor_name: op.name ?? null,
              farm_id: farmIdM,
              details: { equipment_id: eq.id, equipment_name: eq.name, reason: null, via: "whatsapp", deterministic: true },
            });
          }
          if (runningIds.length > 0) {
            try {
              await executeTurnCommands({
                from, phone, op,
                farmId: farmIdM,
                turnOn: false,
                equipmentIds: runningIds,
                originalText: "desligar (manutenção)",
                silent: true,
              });
            } catch (_) { /* bloqueio já foi aplicado */ }
          }
          if (blockedEquipments.length > 0) {
            await dispatchMaintenanceNotify({
              equipments: blockedEquipments,
              farmId: farmIdM,
              farmName: null,
              action: "block",
              changedBy: op.name ?? phone,
              actorPhone: phone,
            });
          }

          const total = okLines.length;
          const header = total === 1 && errLines.length === 0
            ? `🔒 ${eligible[0].name} bloqueado para MANUTENÇÃO.`
            : `🔒 ${total} equipamentos bloqueados para MANUTENÇÃO:`;
          const msgParts: string[] = [header];
          if (total !== 1 || errLines.length > 0) msgParts.push("", ...okLines);
          if (errLines.length) msgParts.push("", ...errLines);
          const namesCsv = eligible.map((e) => e.name.toLowerCase()).join(", ");
          msgParts.push(
            "⚠️ Comandos remotos bloqueados (WhatsApp, sistema e automação).",
            "O bloqueio não impede acionamento local (chave no painel).",
            `Para liberar: envie 'liberar ${namesCsv}'`,
          );
          await sendWhatsAppText(from, msgParts.join("\n"), farmIdM);
          return;
        }
        await supabase.from("whatsapp_maintenance_pending").delete().eq("operator_phone", phone);
        await supabase.from("whatsapp_maintenance_pending").insert({
          operator_phone: phone,
          farm_id: farmIdM,
          operator_id: op.id ?? null,
          equipment_id: eligible[0].id,
          equipment_name: eligible[0].name,
          equipment_ids: eligible.map((e) => e.id),
          equipment_names: eligible.map((e) => e.name),
        });
        const listLines = eligible.map((e) => `• ${e.name}`).join("\n");
        const title = eligible.length === 1
          ? `🔒 Bloquear ${eligible[0].name} para manutenção?`
          : `🔒 Bloquear ${eligible.length} equipamentos para manutenção?`;
        const skipped = already.length > 0
          ? `\n\n(${already.length} já em manutenção: ${already.map((e) => e.name).join(", ")})`
          : "";
        await sendWhatsAppText(
          from,
          `${title}\n\n${listLines}${skipped}\n\nEnvie 'sim' para confirmar ou 'não' para cancelar.`,
          farmIdM,
        );
        return;
      }

      // ===== RELEASE =====
      const okLines: string[] = [];
      const infoLines: string[] = [];
      const errLines: string[] = [];
      const releasedEquipments: { id: string; name: string }[] = [];
      for (const eq of matches) {
        if (eq.maintenance_mode !== true) {
          infoLines.push(`• ${eq.name} (não estava em manutenção)`);
          continue;
        }
        const { error: upErr } = await supabase
          .from("equipments")
          .update({
            maintenance_mode: false,
            maintenance_reason: null,
            maintenance_started_at: null,
            maintenance_started_by: null,
            maintenance_started_via: null,
            last_changed_by: op.name ?? phone,
            last_actuation_origin: "whatsapp",
          })
          .eq("id", eq.id);
        if (upErr) {
          errLines.push(`• ${eq.name} ❌ ${upErr.message}`);
          continue;
        }
        await auditLog({
          event_type: "maintenance_released",
          actor_phone: phone, actor_name: op.name ?? null,
          farm_id: farmIdM,
          details: { equipment_id: eq.id, equipment_name: eq.name, via: "whatsapp" },
        });
        releasedEquipments.push({ id: eq.id, name: eq.name });
        okLines.push(`• ${eq.name} ✅`);
      }

      if (releasedEquipments.length > 0) {
        await dispatchMaintenanceNotify({
          equipments: releasedEquipments,
          farmId: farmIdM,
          farmName: null,
          action: "release",
          changedBy: op.name ?? phone,
          actorPhone: phone,
        });
      }

      const total = releasedEquipments.length;
      const msgParts: string[] = [];
      if (total === 1 && errLines.length === 0 && infoLines.length === 0) {
        msgParts.push(`🔓 ${releasedEquipments[0].name} liberada da manutenção.`);
      } else if (total > 0) {
        msgParts.push(`🔓 ${total} equipamento${total === 1 ? "" : "s"} liberado${total === 1 ? "" : "s"} da manutenção:`, "", ...okLines);
      }
      if (infoLines.length) msgParts.push("", ...infoLines);
      if (errLines.length) msgParts.push("", ...errLines);

      if (total === 1) {
        const eq = releasedEquipments[0];
        await deleteAllPending(phone);
        const { error: postMaintPendErr } = await supabase.from("whatsapp_pending_actions").insert({
          operator_phone: phone,
          farm_id: farmIdM,
          equipment_id: eq.id,
          equipment_name: eq.name,
          action_type: "post_maintenance_ligar",
          operator_id: op.id ?? null,
          original_text: `liberar ${eq.name}`,
        });
        if (postMaintPendErr) {
          console.error("WA: falha ao registrar pendência pós-manutenção", postMaintPendErr);
          msgParts.push("", `Para ligar agora, envie: ligar ${eq.name.toLowerCase()}`);
        } else {
          msgParts.push("", `Deseja ligar a ${eq.name} agora? (sim/não)`);
        }
      } else if (total > 1) {
        const csv = releasedEquipments.map((e) => e.name.toLowerCase()).join(",");
        msgParts.push("", `Deseja ligar algum deles? (envie 'ligar ${csv}' ou 'não')`);
      }

      await sendWhatsAppText(from, msgParts.join("\n"), farmIdM);
      return;
    }
  }


  // ── AI LAYER (opt-in por operador via whatsapp_operators.ai_enabled) ──────
  // Chamada APÓS toda lógica de pending-actions/confirmações para nunca
  // gastar token em "sim"/"não". Reescreve o texto para a forma canônica que
  // o parser de regex existente entende. Em caso de falha/baixa confiança,
  // segue com o texto original (fallback transparente).
  let aiClassification: ClassificationResult | null = null;
  let aiFallbackUsed = true;
  if (!deterministicParserBypass && (op.ai_enabled === true || isSuperAdmin(op)) && text && text.trim().length > 0) {
    // Busca últimas 5 mensagens deste operador como contexto conversacional
    let convHistory: { role: "user" | "assistant"; content: string }[] = [];
    try {
      const { data: hist } = await supabase
        .from("whatsapp_message_log")
        .select("message_body, direction, created_at")
        .eq("phone", phone)
        .order("created_at", { ascending: false })
        .limit(5);
      if (hist && hist.length > 0) {
        convHistory = hist
          .slice()
          .reverse()
          .map((m: any) => ({
            role: (m.direction === "incoming" ? "user" : "assistant") as "user" | "assistant",
            content: String(m.message_body ?? "").trim(),
          }))
          .filter((m) => m.content.length > 0);
      }
    } catch (e) {
      console.warn("[ai] falha ao buscar histórico:", (e as Error).message);
    }
    aiClassification = await classifyMessage(text, convHistory);
    if (aiClassification && aiClassification.confidence >= 0.7) {
      // ── FEEDBACK (auto-aprendizado): operador reagiu à última resposta do bot
      if (aiClassification.intent === "feedback") {
        const polarity = (aiClassification as any).feedback_polarity as
          | "positive" | "negative" | "correction" | undefined;
        // Localiza última classificação deste operador para vincular o feedback
        let feedbackForId: string | null = null;
        try {
          const { data: lastLog } = await supabase
            .from("ai_classification_log")
            .select("id")
            .eq("operator_phone", phone)
            .is("feedback_type", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          feedbackForId = lastLog?.id ?? null;
        } catch (_) { /* ignore */ }

        await supabase.from("ai_classification_log").insert({
          farm_id: op.farm_id ?? null,
          operator_phone: phone,
          raw_message: text,
          canonical_command: aiClassification.canonical_command ?? null,
          ai_intent: "feedback",
          ai_equipments: aiClassification.equipments ?? [],
          ai_confidence: aiClassification.confidence,
          ai_full_response: aiClassification as any,
          fallback_used: false,
          execution_time_ms: aiClassification.execution_time_ms ?? null,
          tokens_input: aiClassification.tokens_input ?? null,
          tokens_output: aiClassification.tokens_output ?? null,
          feedback_type: polarity ?? null,
          operator_correction: polarity === "correction"
            ? (aiClassification.canonical_command || text)
            : null,
          feedback_for_log_id: feedbackForId,
        });

        // Se foi correção com canonical novo, executa o comando corrigido
        const correctionCmd = (aiClassification.canonical_command || "").trim();
        if (polarity === "correction" && correctionCmd.length > 0) {
          console.log(`[ai-feedback] correção → executando "${correctionCmd}"`);
          text = correctionCmd;
          aiFallbackUsed = false;
        } else {
          const reply = (aiClassification.ai_response || "").trim() ||
            (polarity === "positive"
              ? "Beleza! 👍"
              : polarity === "negative"
                ? "Desculpa. Pode reformular o que você queria?"
                : "Anotado.");
          await sendWhatsAppText(from, reply, op.farm_id);
          return;
        }
      } else if (aiClassification.intent === "needs_clarification") {
        const reply = (aiClassification.ai_response || "").trim()
          || "Qual equipamento? Me diz o número.";
        await sendWhatsAppText(from, reply, op.farm_id);
        await supabase.from("ai_classification_log").insert({
          farm_id: op.farm_id ?? null,
          operator_phone: phone,
          raw_message: text,
          canonical_command: "",
          ai_intent: aiClassification.intent,
          ai_equipments: [],
          ai_confidence: aiClassification.confidence,
          ai_full_response: aiClassification as any,
          fallback_used: false,
          execution_time_ms: aiClassification.execution_time_ms ?? null,
          tokens_input: aiClassification.tokens_input ?? null,
          tokens_output: aiClassification.tokens_output ?? null,
        });
        return;
      } else if (aiClassification.intent === "generate_code") {
        const adminText = (aiClassification.canonical_command || text).trim();
        if (await handleRegistrationCodeAdminCommands(from, phone, op, adminText)) {
          return;
        }
      } else if (aiClassification.intent === "manage_operator") {
        const adminText = (aiClassification.canonical_command || text).trim();
        if (await handleOperatorManagementCommands(from, phone, op, adminText)) {
          return;
        }
      } else if (aiClassification.intent === "greeting") {
        const normText = text.trim().toLowerCase();
        const nowMs = Date.now();

        // Dedup em memória (mesma worker)
        const dedupKey = `${phone}|${normText}`;
        const lastAt = recentGreetingDedup.get(dedupKey);
        if (lastAt && nowMs - lastAt < 60_000) {
          console.log(`[ai] dedup mem ignorado: ${dedupKey}`);
          return;
        }
        // Dedup persistente: olha último incoming do mesmo phone nos últimos 60s
        try {
          const since = new Date(nowMs - 60_000).toISOString();
          const { data: recent } = await supabase
            .from("whatsapp_message_log")
            .select("message_body, created_at, direction")
            .eq("phone", phone)
            .eq("direction", "incoming")
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(5);
          const dup = (recent ?? []).slice(1).some((r: any) =>
            (r.message_body ?? "").trim().toLowerCase() === normText
          );
          if (dup) {
            console.log(`[ai] dedup db ignorado: ${dedupKey}`);
            recentGreetingDedup.set(dedupKey, nowMs);
            return;
          }
        } catch (e) {
          console.warn("[ai] dedup db falhou:", (e as Error).message);
        }
        recentGreetingDedup.set(dedupKey, nowMs);
        if (recentGreetingDedup.size > 200) {
          for (const [k, t] of recentGreetingDedup) {
            if (nowMs - t > 300_000) recentGreetingDedup.delete(k);
          }
        }

        // Saudação por horário (America/Bahia ~ -03:00; usa UTC-3 simples)
        const hourBR = new Date(nowMs - 3 * 3600_000).getUTCHours();
        const tod = hourBR < 12 ? "Bom dia" : hourBR < 18 ? "Boa tarde" : "Boa noite";
        const firstName = (op.name || "").trim().split(/\s+/)[0] || "";

        // Primeira interação: apresentação única
        let reply: string;
        if (aiClassification.intent === "greeting" && !op.first_interaction_at) {
          reply =
            `${tod}! Sou o assistente virtual da Renov Tecnologia Agrícola. ` +
            `Cuido do controle das bombas e programações da fazenda. ` +
            `Pode me pedir o que precisar — ligar, desligar, programar, verificar status. É só mandar.`;
          await supabase
            .from("whatsapp_operators")
            .update({ first_interaction_at: new Date(nowMs).toISOString() })
            .eq("id", op.id);
        } else {
          const fallbackReply = firstName ? `${tod}, ${firstName}. No que posso te ajudar?` : `${tod}! Precisa de algo?`;
          reply = (aiClassification.ai_response || "").trim() || fallbackReply;
        }

        await sendWhatsAppText(from, reply, op.farm_id);
        await supabase.from("ai_classification_log").insert({
          farm_id: op.farm_id ?? null,
          operator_phone: phone,
          raw_message: text,
          canonical_command: aiClassification.canonical_command,
          ai_intent: aiClassification.intent,
          ai_equipments: aiClassification.equipments ?? [],
          ai_confidence: aiClassification.confidence,
          ai_full_response: aiClassification as any,
          fallback_used: false,
          execution_time_ms: aiClassification.execution_time_ms ?? null,
          tokens_input: aiClassification.tokens_input ?? null,
          tokens_output: aiClassification.tokens_output ?? null,
        });
        return;
      }

      const canonical = (aiClassification.canonical_command || "").trim();
      if (canonical.length > 0 && canonical.toLowerCase() !== text.trim().toLowerCase()) {
        console.log(`[ai] rewrote "${text}" → "${canonical}" (intent=${aiClassification.intent}, conf=${aiClassification.confidence})`);
        text = canonical;
        aiFallbackUsed = false;
      } else {
        aiFallbackUsed = false;
      }
    }
    // log assíncrono (sem await bloqueante para não atrasar resposta)
    supabase.from("ai_classification_log").insert({
      farm_id: op.farm_id ?? null,
      operator_phone: phone,
      raw_message: text,
      canonical_command: aiClassification?.canonical_command ?? null,
      ai_intent: aiClassification?.intent ?? null,
      ai_equipments: aiClassification?.equipments ?? null,
      ai_confidence: aiClassification?.confidence ?? null,
      ai_full_response: (aiClassification as any) ?? null,
      fallback_used: aiFallbackUsed,
      execution_time_ms: aiClassification?.execution_time_ms ?? null,
      tokens_input: aiClassification?.tokens_input ?? null,
      tokens_output: aiClassification?.tokens_output ?? null,
    }).then(({ error }) => {
      if (error) console.error("[ai] log insert err", error.message);
    });
  }

  // ── Compound commands: split " e ", ". ", "; " e executa cada parte ────────
  const compoundParts = splitCompoundParts(text);
  if (compoundParts.length > 1) {
    await sendWhatsAppText(
      from,
      `✅ Processando ${compoundParts.length} comandos em sequência…`,
      op.farm_id,
    );
    for (let i = 0; i < compoundParts.length; i++) {
      const part = compoundParts[i];
      await sendWhatsAppText(from, `*${i + 1}.* _"${part}"_`, op.farm_id);
      try {
        await handleParsedFlow(part);
      } catch (e) {
        console.error("WA compound part err", e);
        await sendWhatsAppText(
          from,
          `⚠️ Falha no comando ${i + 1}: ${(e as any)?.message ?? "erro desconhecido"}`,
          op.farm_id,
        );
      }
    }
    return;
  }
  await handleParsedFlow(text);
  return;

  // ────────────────────────────────────────────────────────────────────────────
  // handleParsedFlow: dispatch principal (executado 1× por comando atômico).
  // Declarada após o `return` acima — hoisting permite chamada de cima.
  // ────────────────────────────────────────────────────────────────────────────
  async function handleParsedFlow(text: string): Promise<void> {
  // 2) Parse do comando
  const cmd = parseCommand(text);
  if (!cmd) {
    await sendWhatsAppText(from, smartFallbackMessage(text, op.name), op.farm_id);
    return;
  }

  // Qualquer outro comando reconhecido descarta pendências anteriores.
  await deleteAllPending(phone);


  // 3) Resolve fazenda
  let farmId: string | null = op.default_farm_id ?? op.farm_id ?? null;
  if (!farmId) {
    const { data: f } = await supabase.from("farms").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
    farmId = f?.id ?? null;
    console.log("WA EQ LOOKUP — operador sem farm_id, usando primeira fazenda:", farmId);
  }
  if (!farmId) {
    await sendWhatsAppText(from, "🚫 Nenhuma fazenda cadastrada.");
    return;
  }

  // ===== AUTOMAÇÕES INDEPENDENTES (Fase 3 - WhatsApp commands) =====
  if (await handleAutomacoesCommand(text, farmId, op, phone, from)) return;

  // ── Enforce can_schedule for schedule-modifying commands ──
  const SCHED_MUTATING_KINDS = new Set([
    "add_schedule", "del_schedule", "del_all_farm", "edit_schedule",
    "set_sched_active", "set_auto", "global_auto", "add_holiday",
  ]);
  if (SCHED_MUTATING_KINDS.has(cmd.kind as string) && !isSuperAdmin(op) && (op as any)?.can_schedule === false) {
    await sendWhatsAppText(from, "🚫 Você não tem permissão para criar ou alterar programações. Fale com o administrador.", farmId);
    return;
  }




  const selectCols = "id, name, desired_running, communication_status, last_communication, last_actuation_origin, farm_id, hw_id, saida, plc_group_id, last_outputs_state, type, command_blocked_until, maintenance_mode, maintenance_reason, maintenance_started_at, maintenance_started_by, maintenance_started_via";

  // Bridge health derivada de MAX(last_communication) dos equipamentos da fazenda.
  // <2min=online, 2-5min=warning, >5min ou null=offline.
  type BridgeHealth = { state: "online" | "warning" | "offline"; lastTs: Date | null; ageMin: number };
  async function getBridgeHealth(fid: string): Promise<BridgeHealth> {
    const { data } = await supabase
      .from("equipments")
      .select("last_communication")
      .eq("farm_id", fid)
      .not("last_communication", "is", null)
      .order("last_communication", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data?.last_communication) return { state: "offline", lastTs: null, ageMin: Infinity };
    const ts = new Date(data.last_communication);
    const ageMin = (Date.now() - ts.getTime()) / 60000;
    const state: BridgeHealth["state"] = ageMin < 2 ? "online" : ageMin < 5 ? "warning" : "offline";
    return { state, lastTs: ts, ageMin };
  }
  const fmtHb = (d: Date | null) => d
    ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })
    : "—";
  const bridgeOfflineMsg = (h: BridgeHealth) =>
    `🚨 *Bridge OFFLINE*\n\nSem comunicação com os equipamentos ${h.lastTs ? `desde ${fmtHb(h.lastTs)}` : "há muito tempo"}.\nOs dados de status não estão disponíveis no momento.\n\nVerifique o computador da Bridge e a conexão de internet.`;
  const bridgeOfflineCmdMsg = "🚨 Bridge OFFLINE. Comando não pode ser executado — sem comunicação com os equipamentos.";

  // ===== status_all: lista todos os equipamentos de TODAS as fazendas
  // acessíveis ao operador, com badge AUTO quando há programação ativa. =====
  if (cmd.kind === "status_all") {
    // 1) Resolve fazendas acessíveis (inclui is_demo para filtrar depois)
    let accessibleFarms: Array<{ id: string; name: string; is_demo?: boolean | null }> = [];
    if (isSuperAdmin(op)) {
      const { data: farmRows } = await supabase
        .from("farms").select("id, name, is_demo").order("name", { ascending: true });
      accessibleFarms = ((farmRows ?? []) as any[]).filter((f) => f?.id);
    } else if (op.farm_id) {
      const { data: f } = await supabase
        .from("farms").select("id, name, is_demo").eq("id", op.farm_id).maybeSingle();
      if (f?.id) accessibleFarms = [f as any];
    }

    if (accessibleFarms.length === 0) {
      await sendWhatsAppText(from, "Nenhuma fazenda disponível para consulta.", op.farm_id ?? null);
      return;
    }

    // 2) Filtro por nome explícito ("status Terra Norte", "Status Fazenda Sossego")
    const normStatusText = " " + stripAccents((text || "").toLowerCase()).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim() + " ";
    const matchesFarmName = (farmName: string): boolean => {
      const norm = stripAccents(String(farmName ?? "").toLowerCase()).replace(/[^a-z0-9 ]+/g, " ").trim();
      if (!norm) return false;
      const compact = norm.replace(/^fazenda\s+/, "").trim();
      if (` ${normStatusText} `.includes(` ${norm} `) || normStatusText.includes(` ${norm} `)) return true;
      if (compact && normStatusText.includes(` ${compact} `)) return true;
      // todos os tokens significativos do nome aparecem no texto
      const tokens = compact.split(/\s+/).filter((w) => w.length >= 3 && w !== "fazenda");
      if (tokens.length > 0 && tokens.every((tok) => normStatusText.includes(` ${tok} `))) return true;
      return false;
    };
    // Prefer farm with the longest matching name (avoid "sossego" matching nothing while "terra norte" wins by default)
    let explicitFarm = accessibleFarms
      .filter((f) => matchesFarmName(String(f.name ?? "")))
      .sort((a, b) => String(b.name ?? "").length - String(a.name ?? "").length)[0] ?? null;

    // Detecta menção explícita "fazenda <nome>" no texto do usuário
    const farmMention = normStatusText.match(/\bfazenda\s+([a-z0-9 ]+?)(?:\s|$)/);
    const explicitFarmRequested = !!farmMention;
    console.log("[status_all] text=", normStatusText.trim(), "explicitFarm=", explicitFarm?.name ?? null, "farmMention=", farmMention?.[1] ?? null);

    // Se usuário pediu explicitamente uma fazenda e ela não bate com nenhuma acessível,
    // checa se ela existe globalmente para diferenciar "não encontrada" de "sem acesso".
    if (explicitFarmRequested && !explicitFarm) {
      const mentionTokens = (farmMention![1] || "").split(/\s+/).filter((w) => w.length >= 3);
      const { data: allFarms } = await supabase.from("farms").select("id, name, is_demo");
      const globalMatch = ((allFarms ?? []) as any[]).find((f) => {
        const fn = stripAccents(String(f.name ?? "").toLowerCase()).replace(/[^a-z0-9 ]+/g, " ");
        return mentionTokens.length > 0 && mentionTokens.every((tok) => fn.includes(tok));
      });
      if (globalMatch && isSuperAdmin(op)) {
        // super_admin tem acesso a TODAS as fazendas — nunca bloqueia
        explicitFarm = { id: globalMatch.id, name: globalMatch.name, is_demo: globalMatch.is_demo } as any;
      } else {
        const msg = globalMatch
          ? `🔒 Você não tem acesso à fazenda *${globalMatch.name}*.`
          : `❓ Fazenda não encontrada. Verifique o nome e tente novamente.`;
        await sendWhatsAppText(from, msg, op.farm_id ?? null);
        return;
      }
    }

    // 2b) Usuário pediu explicitamente "todas"/"all" para forçar visão geral
    const askedAll = /\b(todas|todos|all|geral|tudo|completo)\b/.test(normStatusText);

    // 2c) Default: respeitar default_farm_id do operador (super_admin incluído)
    const defaultFarmId: string | null = (op as any).default_farm_id ?? op.farm_id ?? null;
    const defaultFarm = defaultFarmId
      ? accessibleFarms.find((f) => f.id === defaultFarmId) ?? null
      : null;

    let farmsToShow: typeof accessibleFarms;
    if (explicitFarm) {
      farmsToShow = [explicitFarm];
    } else if (askedAll) {
      // Mostra todas, mas sempre exclui demos a menos que peça explicitamente
      const includeDemo = /\bdemo/.test(normStatusText);
      farmsToShow = includeDemo ? accessibleFarms : accessibleFarms.filter((f) => !f.is_demo);
    } else if (defaultFarm) {
      farmsToShow = [defaultFarm];
    } else {
      farmsToShow = accessibleFarms.filter((f) => !f.is_demo);
      if (farmsToShow.length === 0) farmsToShow = accessibleFarms;
    }
    const farmIds = farmsToShow.map((f) => f.id);

    // 3) Carrega equipamentos e programações ativas (para badge AUTO)
    const [{ data: eqRows }, { data: schedRows }] = await Promise.all([
      supabase.from("equipments").select(selectCols).in("farm_id", farmIds).neq("type", "nivel").limit(2000),
      supabase.from("automation_schedules").select("equipment_id, farm_id").in("farm_id", farmIds).eq("active", true),
    ]);
    const autoEq = new Set<string>();
    for (const s of ((schedRows ?? []) as any[])) {
      autoEq.add(s.equipment_id);
    }

    const equipments = ((eqRows ?? []) as any[]).slice().sort((a, b) =>
      String(a.name ?? "").localeCompare(String(b.name ?? ""), "pt-BR"));

    // 4) Renderiza por fazenda — agrupado por estado (Ligados / Desligados / Offline)
    const blocks: string[] = [];
    for (const farm of farmsToShow) {
      const eqs = equipments.filter((e) => e.farm_id === farm.id);
      const lines: string[] = [`📍 ${farm.name}`];
      if (eqs.length === 0) {
        lines.push("(nenhum equipamento cadastrado)");
      } else {
        const ligados: string[] = [];
        const desligados: string[] = [];
        const offline: string[] = [];
        const manutencao: string[] = [];
        for (const eq of eqs) {
          const { isOffline, inMaintenance } = computeEqState(eq);
          const isAuto = autoEq.has(eq.id);
          const origin = String(eq.last_actuation_origin ?? "").toLowerCase();
          const controlMode = origin === "local" ? "Local" : "Remoto";
          if (inMaintenance) {
            manutencao.push(`• ${eq.name}`);
          } else if (isOffline) {
            offline.push(`• ${eq.name}`);
          } else {
            const parts = [controlMode];
            if (isAuto) parts.push("AUTO");
            const line = `• ${eq.name} — ${parts.join(" | ")}`;
            if (eq.desired_running) ligados.push(line);
            else desligados.push(line);
          }
        }
        if (ligados.length) { lines.push("", `🟢 LIGADOS (${ligados.length}):`, ...ligados); }
        if (desligados.length) { lines.push("", `🔴 DESLIGADOS (${desligados.length}):`, ...desligados); }
        if (offline.length) { lines.push("", `⚫ OFFLINE (${offline.length}):`, ...offline); }
        if (manutencao.length) { lines.push("", `🔧 MANUTENÇÃO (${manutencao.length}):`, ...manutencao); }
      }
      blocks.push(lines.join("\n"));
    }

    let finalMessage = blocks.join("\n\n");

    // Fallback robusto para visão geral: como o parser determinístico captura
    // "como está a fazenda/captação/tudo" antes do Gemini, o overview não chega
    // no request_overview. Nesses casos, anexamos os níveis ao final do status
    // se a(s) fazenda(s) tiver(em) sensores de nível. Pedidos explícitos de
    // "bombas/poços/status das bombas" continuam retornando só bombas.
    const shouldAppendLevelsToStatus = (() => {
      const mentionsLevels = /\b(nivel|niveis|reservatorio|reservatorios|canal|canais|agua|tanque|tanques|caixa|caixas)\b/.test(normStatusText);
      const explicitPumpOnly = /\b(bomba|bombas|poco|pocos|equipamento|equipamentos|conjunto|conjuntos|booster|boosters)\b/.test(normStatusText);
      const overviewSignal = /\b(fazenda|captacao|tudo|geral|resumo)\b/.test(normStatusText)
        || /\bcomo\s+(esta|estao|ta|tao)\b/.test(normStatusText);
      return overviewSignal && !mentionsLevels && !explicitPumpOnly;
    })();

    if (shouldAppendLevelsToStatus) {
      console.log("[status_all] overview fallback: appending levels", {
        text: normStatusText.trim(),
        farms: farmsToShow.map((f) => f.name),
      });
      const { data: levelRows, error: levelErr } = await supabase
        .from("equipments")
        .select("id, farm_id, name, level_cal_digital, level_cal_meters, level_max_meters, max_height, level_last_raw, level_last_raw_at")
        .in("farm_id", farmIds)
        .eq("type", "nivel")
        .order("name", { ascending: true });

      if (levelErr) {
        console.error("[status_all] overview fallback levels err:", levelErr.message);
      } else {
        const levelList = (levelRows ?? []) as any[];
        if (levelList.length > 0) {
          const fmtLevelTime = (iso?: string | null) => {
            if (!iso) return "—";
            return new Date(iso).toLocaleString("pt-BR", {
              day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
              timeZone: "America/Bahia",
            }).replace(",", "");
          };
          const bar = (pct: number) => {
            const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
            return "▓".repeat(filled) + "░".repeat(10 - filled);
          };
          const computeLevel = (e: any): { meters: number | null; percent: number | null } => {
            if (e.level_last_raw === null || e.level_last_raw === undefined) return { meters: null, percent: null };
            const raw = Number(e.level_last_raw);
            const calD = Number(e.level_cal_digital);
            const calM = Number(e.level_cal_meters);
            const maxM = Number(e.level_max_meters);
            const maxH = Number(e.max_height);
            if (!Number.isFinite(raw)) return { meters: null, percent: null };
            const calibrated = Number.isFinite(calD) && calD > 0 && Number.isFinite(calM) && calM > 0;
            if (calibrated) {
              const meters = Math.max(0, (raw / calD) * calM);
              const maxRef = Number.isFinite(maxM) && maxM > 0
                ? maxM
                : (Number.isFinite(maxH) && maxH > 0 ? maxH : null);
              const percent = maxRef !== null
                ? Math.max(0, Math.min(100, (meters / maxRef) * 100))
                : null;
              return { meters, percent };
            }
            if (Number.isFinite(maxH) && maxH > 0) {
              return { meters: null, percent: Math.max(0, Math.min(100, (raw / 1023) * 100)) };
            }
            return { meters: null, percent: null };
          };

          const levelBlocks: string[] = [];
          for (const farm of farmsToShow) {
            const farmLevels = levelList.filter((e) => e.farm_id === farm.id);
            if (!farmLevels.length) continue;
            const lines: string[] = [`💧 Níveis — ${farm.name}:`, ""];
            for (const e of farmLevels) {
              const { meters, percent } = computeLevel(e);
              const maxM = Number(e.level_max_meters);
              const hasMax = Number.isFinite(maxM) && maxM > 0;
              const curStr = meters !== null ? `${meters.toFixed(2)}m` : "—";
              const maxStr = hasMax ? `${maxM.toFixed(2)}m` : "—";
              const pctStr = percent !== null ? `${percent.toFixed(0)}%` : "—";
              lines.push(`• ${e.name}: ${curStr} / ${maxStr} (${pctStr})`);
              if (percent !== null) lines.push(`  ${bar(percent)} ${pctStr}`);
              lines.push(`  Última leitura: ${fmtLevelTime(e.level_last_raw_at)}`);
            }
            levelBlocks.push(lines.join("\n"));
          }
          if (levelBlocks.length > 0) finalMessage += `\n\n${levelBlocks.join("\n\n")}`;
        }
      }
    }

    await sendWhatsAppText(from, finalMessage, farmsToShow[0].id);
    return;
  }

  // ===== level: níveis dos equipamentos (reservatório/canal/etc.) =====
  if (cmd.kind === "level") {
    // Resolve fazenda alvo: respeita menção explícita "fazenda <nome>" no texto
    // (mesma lógica do status_all). Default = farmId do operador.
    let targetFarmId = farmId;
    let targetFarmName: string | null = null;
    {
      const normLevelText = " " + stripAccents((text || "").toLowerCase()).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim() + " ";
      const farmMention = normLevelText.match(/\bfazenda\s+([a-z0-9 ]+?)(?:\s|$)/);
      let accessibleFarms: Array<{ id: string; name: string }> = [];
      if (isSuperAdmin(op)) {
        const { data: fr } = await supabase.from("farms").select("id, name").order("name");
        accessibleFarms = ((fr ?? []) as any[]).filter((f) => f?.id);
      } else if (op.farm_id) {
        const { data: f } = await supabase.from("farms").select("id, name").eq("id", op.farm_id).maybeSingle();
        if (f?.id) accessibleFarms = [f as any];
      }
      const matchesFarmName = (farmName: string): boolean => {
        const norm = stripAccents(String(farmName ?? "").toLowerCase()).replace(/[^a-z0-9 ]+/g, " ").trim();
        if (!norm) return false;
        const compact = norm.replace(/^fazenda\s+/, "").trim();
        if (normLevelText.includes(` ${norm} `)) return true;
        if (compact && normLevelText.includes(` ${compact} `)) return true;
        const tokens = compact.split(/\s+/).filter((w) => w.length >= 3 && w !== "fazenda");
        return tokens.length > 0 && tokens.every((tok) => normLevelText.includes(` ${tok} `));
      };
      const explicitFarm = accessibleFarms
        .filter((f) => matchesFarmName(String(f.name ?? "")))
        .sort((a, b) => String(b.name ?? "").length - String(a.name ?? "").length)[0] ?? null;
      console.log("[level] text=", normLevelText.trim(), "explicitFarm=", explicitFarm?.name ?? null, "farmMention=", farmMention?.[1] ?? null);
      if (explicitFarm) {
        targetFarmId = explicitFarm.id;
        targetFarmName = explicitFarm.name;
      } else if (farmMention) {
        const mentionTokens = (farmMention[1] || "").split(/\s+/).filter((w) => w.length >= 3);
        const { data: allFarms } = await supabase.from("farms").select("id, name");
        const globalMatch = ((allFarms ?? []) as any[]).find((f) => {
          const fn = stripAccents(String(f.name ?? "").toLowerCase()).replace(/[^a-z0-9 ]+/g, " ");
          return mentionTokens.length > 0 && mentionTokens.every((tok) => fn.includes(tok));
        });
        if (globalMatch && isSuperAdmin(op)) {
          // super_admin tem acesso a TODAS as fazendas — nunca bloqueia
          targetFarmId = globalMatch.id;
          targetFarmName = globalMatch.name;
        } else {
          const msg = globalMatch
            ? `🔒 Você não tem acesso à fazenda *${globalMatch.name}*.`
            : `❓ Fazenda não encontrada. Verifique o nome e tente novamente.`;
          await sendWhatsAppText(from, msg, op.farm_id ?? null);
          return;
        }
      }
    }

    console.log("[level] resolved targetFarmId=", targetFarmId, "targetFarmName=", targetFarmName ?? null, "operatorDefaultFarmId=", (op as any).default_farm_id ?? null, "operatorFarmId=", op.farm_id ?? null, "cmdBase=", cmd.base ?? null);

    // Bloqueio por módulo desativado para a fazenda alvo
    const { data: farmMod } = await supabase
      .from("farms").select("modules, name").eq("id", targetFarmId).maybeSingle();
    if (!targetFarmName) targetFarmName = (farmMod as any)?.name ?? null;
    const niveisOn = ((farmMod?.modules ?? {}) as any).niveis !== false;
    if (!niveisOn) {
      await sendWhatsAppText(from, "⚠️ Módulo de Níveis não está ativo para esta fazenda.", targetFarmId);
      return;
    }
    const bridge = await getBridgeHealth(targetFarmId);
    if (bridge.state === "offline") {
      await sendWhatsAppText(from, bridgeOfflineMsg(bridge), targetFarmId);
      return;
    }
    const { data: rows } = await supabase
      .from("equipments")
      .select("id, name, type, level_cal_digital, level_cal_meters, level_max_meters, max_height, level_last_raw, level_last_raw_at")
      .eq("farm_id", targetFarmId)
      .eq("type", "nivel")
      .order("name", { ascending: true });
    let list = (rows ?? []) as any[];

    const normalizedTargetFarmName = stripAccents(String(targetFarmName ?? "").toLowerCase()).replace(/[^a-z0-9 ]+/g, " ").replace(/^fazenda\s+/, "").trim();
    const normalizedLevelBase = stripAccents(String(cmd.base ?? "").toLowerCase()).replace(/[^a-z0-9 ]+/g, " ").replace(/^fazenda\s+/, "").trim();
    const baseIsFarmSelector = !!normalizedLevelBase && !!normalizedTargetFarmName && (
      normalizedLevelBase === normalizedTargetFarmName ||
      normalizedTargetFarmName.includes(normalizedLevelBase) ||
      normalizedLevelBase.includes(normalizedTargetFarmName)
    );

    if (cmd.base && !baseIsFarmSelector) {
      const variants = baseSearchVariants(cmd.base);
      list = list.filter((e) =>
        variants.some((v) => String(e.name ?? "").toLowerCase().includes(v))
      );
    }
    if (cmd.nums.length) {
      list = list.filter((e) => {
        const ns = extractNumbers(e.name);
        return cmd.nums.some((n) => ns.includes(n));
      });
    }

    if (!list.length) {
      const farmSuffix = targetFarmName ? ` em ${targetFarmName}` : "";
      await sendWhatsAppText(from, `💧 Nenhum equipamento com leitura de nível encontrado${farmSuffix}.`, targetFarmId);
      return;
    }


    const fmtLevelTime = (iso?: string | null) => {
      if (!iso) return "—";
      return new Date(iso).toLocaleString("pt-BR", {
        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
        timeZone: "America/Bahia",
      }).replace(",", "");
    };

    const bar = (pct: number) => {
      const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
      return "▓".repeat(filled) + "░".repeat(10 - filled);
    };

    // Mesma fórmula do dashboard (src/lib/levelCalibration.ts):
    //   metros = (raw / cal_digital) * cal_meters
    //   percent = (metros / max_meters) * 100
    const computeLevel = (e: any): { meters: number | null; percent: number | null } => {
      const raw = Number(e.level_last_raw);
      const calD = Number(e.level_cal_digital);
      const calM = Number(e.level_cal_meters);
      const maxM = Number(e.level_max_meters);
      const maxH = Number(e.max_height);
      if (!Number.isFinite(raw)) return { meters: null, percent: null };
      const calibrated = Number.isFinite(calD) && calD > 0 && Number.isFinite(calM) && calM > 0;
      if (calibrated) {
        const meters = Math.max(0, (raw / calD) * calM);
        const maxRef = Number.isFinite(maxM) && maxM > 0
          ? maxM
          : (Number.isFinite(maxH) && maxH > 0 ? maxH : null);
        const percent = maxRef !== null
          ? Math.max(0, Math.min(100, (meters / maxRef) * 100))
          : null;
        return { meters, percent };
      }
      if (Number.isFinite(maxH) && maxH > 0) {
        return { meters: null, percent: Math.max(0, Math.min(100, (raw / 1023) * 100)) };
      }
      return { meters: null, percent: null };
    };

    // Busca histórico (6h) para cálculo de taxa via regressão linear,
    // mesma janela do hook useReservoirDrainEta usado no dashboard.
    const eqIds = list.map((e) => e.id).filter(Boolean);
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: hist } = await supabase
      .from("level_history")
      .select("equipment_id, read_at, percent")
      .in("equipment_id", eqIds)
      .gte("read_at", since)
      .order("read_at", { ascending: true })
      .limit(5000);

    const byEq = new Map<string, Array<{ t: number; p: number }>>();
    for (const row of (hist ?? []) as any[]) {
      if (row.percent == null) continue;
      const arr = byEq.get(row.equipment_id) ?? [];
      arr.push({ t: new Date(row.read_at).getTime(), p: Number(row.percent) });
      byEq.set(row.equipment_id, arr);
    }

    // Regressão linear → %/h
    const ratePerHour = (eqId: string): number | null => {
      const pts = byEq.get(eqId);
      if (!pts || pts.length < 2) return null;
      const n = pts.length;
      const sumX = pts.reduce((s, p) => s + p.t, 0);
      const sumY = pts.reduce((s, p) => s + p.p, 0);
      const sumXY = pts.reduce((s, p) => s + p.t * p.p, 0);
      const sumXX = pts.reduce((s, p) => s + p.t * p.t, 0);
      const denom = n * sumXX - sumX * sumX;
      if (denom === 0) return null;
      const slopePerMs = (n * sumXY - sumX * sumY) / denom;
      return slopePerMs * 3_600_000;
    };

    const headerTitle = targetFarmName ? `💧 Níveis — ${targetFarmName}:` : "💧 Níveis atuais:";
    const lines = [headerTitle, ""];
    const pctSamples: number[] = [];
    const rateSamples: number[] = [];
    const lastPctById = new Map<string, number>();

    for (const e of list) {
      const { meters, percent } = computeLevel(e);
      const maxM = Number(e.level_max_meters);
      const hasMax = Number.isFinite(maxM) && maxM > 0;
      const curStr = meters !== null ? `${meters.toFixed(2)}m` : "—";
      const maxStr = hasMax ? `${maxM.toFixed(2)}m` : "—";
      const pctStr = percent !== null ? `${percent.toFixed(0)}%` : "—";
      lines.push(`• ${e.name}: ${curStr} / ${maxStr} (${pctStr})`);
      if (percent !== null) {
        lines.push(`  ${bar(percent)} ${pctStr}`);
        pctSamples.push(percent);
        lastPctById.set(e.id, percent);
      }
      lines.push(`  Última leitura: ${fmtLevelTime(e.level_last_raw_at)}`);
      const r = ratePerHour(e.id);
      if (r !== null && Number.isFinite(r)) rateSamples.push(r);
    }

    // ===== Resumo de Captação =====
    if (pctSamples.length > 0) {
      const avgPct = pctSamples.reduce((s, v) => s + v, 0) / pctSamples.length;
      const avgRate = rateSamples.length > 0
        ? rateSamples.reduce((s, v) => s + v, 0) / rateSamples.length
        : null;

      let statusLine: string;
      if (avgRate === null) statusLine = "⚪ Sem dados suficientes";
      else if (avgRate > 0) statusLine = "✅ Captação suficiente";
      else if (avgRate >= -0.5) statusLine = "⚠️ Captação insuficiente";
      else statusLine = "🔴 Captação crítica";

      let forecastLine: string | null = null;
      if (avgRate !== null && Number.isFinite(avgRate) && Math.abs(avgRate) > 0.01) {
        if (avgRate < 0) {
          const h = avgPct / Math.abs(avgRate);
          forecastLine = h > 48
            ? `esvazia em ~${Math.round(h)}h (${(h / 24).toFixed(1)} dias)`
            : `esvazia em ~${h.toFixed(1)}h`;
        } else {
          const h = (100 - avgPct) / avgRate;
          if (h > 0 && Number.isFinite(h)) {
            forecastLine = h > 48
              ? `enche em ~${Math.round(h)}h (${(h / 24).toFixed(1)} dias)`
              : `enche em ~${h.toFixed(1)}h`;
          }
        }
      }

      lines.push("");
      lines.push("📊 Resumo de Captação:");
      lines.push(`• Nível médio: ${avgPct.toFixed(0)}%`);
      lines.push(`• Taxa: ${avgRate === null ? "—" : `${avgRate >= 0 ? "+" : ""}${avgRate.toFixed(2)} %/h`}`);
      lines.push(`• Status: ${statusLine}`);
      if (forecastLine) lines.push(`• Previsão: ${forecastLine}`);
    }

    await sendWhatsAppText(from, lines.join("\n"), targetFarmId);
    return;
  }

  // ===== auto_mode: ativa/desativa modo automático direto no equipamento =====
  if (cmd.kind === "auto_mode") {
    await handleAutoMode(cmd.target, cmd.activate, phone, farmId, from, op);
    return;
  }

  // ===== set_auto: ativa/desativa modo automático para equipamento(s) =====
  if (cmd.kind === "set_auto") {
    const eqs = await resolveEquipmentsForBase(farmId, cmd.base, cmd.nums);
    if (!eqs.length) {
      await sendWhatsAppText(from, `❓ Equipamento "${cmd.base}${cmd.nums.length ? " " + cmd.nums.join(",") : ""}" não encontrado.`, farmId);
      return;
    }
    if (cmd.enable) {
      // Garante motor global ligado para a fazenda.
      await supabase.from("automation_engine").upsert(
        { farm_id: farmId, enabled: true, last_changed_by: op.name ?? phone, last_changed_via: "whatsapp" },
        { onConflict: "farm_id" },
      );
    }
    const lines: string[] = [];
    for (const eq of eqs) {
      const { data: schedRows } = await supabase
        .from("automation_schedules")
        .select("id")
        .eq("farm_id", farmId)
        .eq("equipment_id", eq.id);
      const count = (schedRows ?? []).length;
      if (cmd.enable) {
        if (count === 0) {
          lines.push(`⚠️ ${eq.name}: não há programações. Crie com "programar ${cmd.base} <n> ligar HH:MM desligar HH:MM".`);
          continue;
        }
        await supabase
          .from("automation_schedules")
          .update({ active: true, ..._waAuditUpdate })
          .eq("farm_id", farmId)
          .eq("equipment_id", eq.id);
        lines.push(`🤖 ${eq.name} — Modo Automático ATIVADO (${count} programação${count > 1 ? "ões" : ""})`);
      } else {
        await supabase
          .from("automation_schedules")
          .update({ active: false, ..._waAuditUpdate })
          .eq("farm_id", farmId)
          .eq("equipment_id", eq.id);
        lines.push(`🔧 ${eq.name} — Modo Manual ATIVADO`);
      }
    }
    await sendWhatsAppText(from, lines.join("\n"), farmId);
    return;
  }

  // ===== global_auto: master toggle do Modo Automático da fazenda =====
  if (cmd.kind === "global_auto") {
    // Resolve fazenda alvo: super_admin com múltiplas fazendas precisa de hint;
    // se não vier, perguntamos qual fazenda (issue 3).
    let targetFarmId = farmId;
    let targetFarmName: string | null = null;
    const hint = (cmd as any).farmHint as string | undefined;

    if (hint && isSuperAdmin(op)) {
      const hintNorm = stripAccents(hint.toLowerCase()).replace(/^fazenda\s+/, "").trim();
      const { data: allFarms } = await supabase.from("farms").select("id, name");
      const match = (allFarms ?? []).find((f: any) => {
        const n = stripAccents(String(f.name ?? "").toLowerCase());
        const c = n.replace(/^fazenda\s+/, "").trim();
        return n === hintNorm || c === hintNorm || n.includes(hintNorm) || c.includes(hintNorm);
      }) as any;
      if (!match) {
        await sendWhatsAppText(from, `❓ Fazenda "${hint}" não encontrada.`, farmId);
        return;
      }
      targetFarmId = match.id;
      targetFarmName = match.name;
    } else if (!hint && isSuperAdmin(op) && (cmd.action === "on" || cmd.action === "off")) {
      // Super admin sem hint: se tem acesso a mais de uma fazenda, pergunta qual.
      const { data: allFarms } = await supabase.from("farms").select("id, name").order("name", { ascending: true });
      const farms = ((allFarms ?? []) as any[]).filter((f) => f?.id && f?.name);
      if (farms.length > 1) {
        await deleteAllPending(phone);
        await supabase.from("whatsapp_pending_actions").insert({
          operator_phone: phone,
          farm_id: farmId,
          action_type: "global_auto_select_farm",
          operator_id: op?.id ?? null,
          original_text: JSON.stringify({ activate: cmd.action === "on" }),
        });
        await sendWhatsAppText(
          from,
          `❓ Qual fazenda você quer ${cmd.action === "on" ? "ATIVAR" : "DESATIVAR"} o modo automático?\n${farms.map((f: any) => `• ${f.name}`).join("\n")}`,
          farmId,
        );
        return;
      }
    }

    if (cmd.action === "query") {
      const { data: engRow } = await supabase
        .from("automation_engine")
        .select("enabled")
        .eq("farm_id", targetFarmId)
        .maybeSingle();
      const current = !!engRow?.enabled;
      const farmLabel = targetFarmName ? ` (${targetFarmName})` : "";
      const txt = current
        ? `🤖 Modo Automático${farmLabel}: ATIVADO ✅`
        : `🔧 Modo Automático${farmLabel}: DESATIVADO ❌`;
      await sendWhatsAppText(from, txt, targetFarmId);
      return;
    }

    // ON/OFF → runFarmWideAutoMode (envia mensagem + dispara notify formatada)
    if (!targetFarmName) {
      const { data: f } = await supabase.from("farms").select("id, name").eq("id", targetFarmId).maybeSingle();
      targetFarmName = (f as any)?.name ?? "Fazenda";
    }
    await runFarmWideAutoMode(
      { id: targetFarmId, name: targetFarmName ?? "Fazenda" },
      cmd.action === "on",
      phone,
      from,
      op,
    );
    return;
  }

  // ===== set_sched_active: ativa/desativa programações (per equip ou todas) =====
  if (cmd.kind === "set_sched_active") {
    const dayFilter = cmd.days && cmd.days.length ? new Set(cmd.days) : null;
    const matchDays = (row: any) => !dayFilter || (row.days ?? []).some((d: string) => dayFilter.has(d));

    if (cmd.target === "all") {
      const { data: allScheds } = await supabase
        .from("automation_schedules")
        .select("id, days")
        .eq("farm_id", farmId);
      const rows = (allScheds ?? []).filter(matchDays);
      const total = rows.length;
      if (total === 0) {
        await sendWhatsAppText(from, "📅 Nenhuma programação cadastrada.", farmId);
        return;
      }
      const ids = rows.map((r: any) => r.id);
      await supabase.from("automation_schedules").update({ active: cmd.active, ..._waAuditUpdate }).in("id", ids);
      const dayTxt = dayFilter ? ` (dias: ${formatDays(Array.from(dayFilter))})` : "";
      const txt = cmd.active
        ? `✅ Todas as programações ATIVADAS${dayTxt} (${total}).`
        : `⏸️ Todas as programações DESATIVADAS${dayTxt} (${total}).`;
      await sendWhatsAppText(from, txt, farmId);
      return;
    }
    const { base, nums } = cmd.target;
    const eqs = await resolveEquipmentsForBase(farmId, base, nums);
    if (!eqs.length) {
      await sendWhatsAppText(from, `❓ Equipamento "${base}${nums.length ? " " + nums.join(",") : ""}" não encontrado.`, farmId);
      return;
    }
    const lines: string[] = [];
    for (const eq of eqs) {
      const { data: schedRows } = await supabase
        .from("automation_schedules")
        .select("id, days")
        .eq("farm_id", farmId)
        .eq("equipment_id", eq.id);
      const rows = (schedRows ?? []).filter(matchDays);
      const count = rows.length;
      if (count === 0) {
        lines.push(`⚠️ ${eq.name}: não há programações${dayFilter ? " nesses dias" : " cadastradas"}.`);
        continue;
      }
      const ids = rows.map((r: any) => r.id);
      await supabase.from("automation_schedules").update({ active: cmd.active, ..._waAuditUpdate }).in("id", ids);
      const dayTxt = dayFilter ? ` (${formatDays(Array.from(dayFilter))})` : "";
      lines.push(
        cmd.active
          ? `✅ Programação do ${eq.name} ATIVADA${dayTxt} (${count}).`
          : `⏸️ Programação do ${eq.name} DESATIVADA${dayTxt} (${count}).`,
      );
    }
    await sendWhatsAppText(from, lines.join("\n"), farmId);
    return;
  }

  // ===== schedule_help: trigger de criação SEM horários =====
  if (cmd.kind === "schedule_help") {
    await sendWhatsAppText(
      from,
      "📋 Para criar uma programação, use o formato:\n\n" +
        "programar [equipamento] ligar [HH:MM] desligar [HH:MM] [dias]\n\n" +
        "Exemplo: programar poço 02 ligar 06:00 desligar 18:00 seg-sex",
      farmId,
    );
    return;
  }

  // ===== list_schedules: programações da fazenda =====

  if (cmd.kind === "list_schedules") {
    const { data: scheds } = await supabase
      .from("automation_schedules")
      .select("id, equipment_id, active, mode, days, time_on, time_off, created_by_name, created_by_via, created_at")

      .eq("farm_id", farmId);
    let rows = (scheds ?? []) as any[];
    if (!rows.length) {
      await sendWhatsAppText(from, "📅 Nenhuma programação cadastrada.", farmId);
      return;
    }
    const eqIds = Array.from(new Set(rows.map((r) => r.equipment_id)));
    const { data: eqs } = await supabase
      .from("equipments")
      .select("id, name")
      .in("id", eqIds);
    const eqMap = new Map((eqs ?? []).map((e: any) => [e.id, e.name as string]));

    if (cmd.base) {
      const variants = baseSearchVariants(cmd.base);
      rows = rows.filter((r) => {
        const name = String(eqMap.get(r.equipment_id) ?? "").toLowerCase();
        if (!variants.some((v) => name.includes(v))) return false;
        if (cmd.nums.length === 0) return true;
        const ns = extractNumbers(eqMap.get(r.equipment_id) ?? "");
        return cmd.nums.some((n) => ns.includes(n));
      });
    } else if (cmd.nums.length) {
      rows = rows.filter((r) => {
        const ns = extractNumbers(eqMap.get(r.equipment_id) ?? "");
        return cmd.nums.some((n) => ns.includes(n));
      });
    }
    if (!rows.length) {
      await sendWhatsAppText(from, "📅 Nenhuma programação encontrada para esse filtro.", farmId);
      return;
    }
    // Agrupa por equipamento
    const byEq = new Map<string, any[]>();
    for (const r of rows) {
      const k = r.equipment_id;
      if (!byEq.has(k)) byEq.set(k, []);
      byEq.get(k)!.push(r);
    }
    // Header: nome da fazenda + estado do Modo Automático global
    const { data: farmRow } = await supabase.from("farms").select("name").eq("id", farmId).maybeSingle();
    const { data: engRow } = await supabase
      .from("automation_engine").select("enabled").eq("farm_id", farmId).maybeSingle();
    const globalOn = !!engRow?.enabled;
    const totalActive = rows.filter((r: any) => r.active).length;
    const lines: string[] = [
      `📋 Programações — ${farmRow?.name ?? "Fazenda"}:`,
      "",
      `🤖 Modo Automático: ${globalOn ? "✅ ATIVO" : "❌ INATIVO"} (${totalActive} programaç${totalActive === 1 ? "ão" : "ões"} ativas)`,
      "",
    ];
    // Ordena equipamentos por nome
    const sortedEntries = Array.from(byEq.entries()).sort((a, b) => {
      const na = (eqMap.get(a[0]) ?? "").localeCompare(eqMap.get(b[0]) ?? "", "pt-BR");
      return na;
    });
    for (const [eqId, items] of sortedEntries) {
      const name = eqMap.get(eqId) ?? "(equipamento)";
      const total = items.length;
      const active = items.filter((i: any) => i.active).length;
      lines.push(`• ${name} — ${total} prog. (${active} ativa${active === 1 ? "" : "s"})`);
      // Agrupa por assinatura de dias (mesmos dias = mesma linha)
      const byDays = new Map<string, { days: string[]; on?: string; off?: string }>();
      for (const it of items) {
        const key = (it.days ?? []).slice().sort().join(",");
        if (!byDays.has(key)) byDays.set(key, { days: it.days ?? [] });
        const slot = byDays.get(key)!;
        if (it.mode === "on-only") slot.on = it.time_on;
        else if (it.mode === "off-only") slot.off = it.time_off;
      }
      for (const slot of byDays.values()) {
        const parts: string[] = [];
        if (slot.on) parts.push(`Liga ${slot.on}`);
        if (slot.off) parts.push(`Desliga ${slot.off}`);
        lines.push(`  ${formatDays(slot.days)}: ${parts.join(" / ") || "—"}`);
      }
      // Autor (primeiro registro com info)
      const authored = items.find((i: any) => i.created_by_name);
      if (authored) {
        const via = authored.created_by_via === "whatsapp" ? "WhatsApp" : (authored.created_by_via ?? "frontend");
        const d = authored.created_at ? new Date(authored.created_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "";
        lines.push(`  Criado por: ${authored.created_by_name} via ${via}${d ? " em " + d : ""}`);
      }
    }

    await sendWhatsAppText(from, lines.join("\n"), farmId);
    return;
  }

  // ===== add_schedule: cria programação ligar/desligar =====
  if (cmd.kind === "add_schedule") {
    const eqs = await resolveEquipmentsForBase(farmId, cmd.base, cmd.nums);
    if (!eqs.length) {
      const nLabel = cmd.nums.length ? ` ${cmd.nums.join(",")}` : "";
      await sendWhatsAppText(from, `❓ Equipamento "${cmd.base}${nLabel}" não encontrado.`, farmId);
      return;
    }
    const days = (cmd.days && cmd.days.length) ? cmd.days : ["mon", "tue", "wed", "thu", "fri"];
    const daysLabel = formatDays(days);
    const hasOn = !!cmd.timeOn;
    const hasOff = !!cmd.timeOff;

    // Determina quais nums não foram encontrados (apenas quando houve lista explícita)
    let notFoundLines: string[] = [];
    if (cmd.nums.length > 0) {
      const foundNums = new Set<number>();
      for (const eq of eqs) for (const n of extractNumbers(eq.name)) foundNums.add(n);
      const missing = cmd.nums.filter((n) => !foundNums.has(n));
      if (missing.length) {
        const baseLabel = cmd.base.charAt(0).toUpperCase() + cmd.base.slice(1);
        notFoundLines = missing.map((n) => `${baseLabel} ${String(n).padStart(2, "0")}`);
      }
    }

    const okLines: string[] = [];
    const failLines: string[] = [];
    // Ordena por nome (Poço 01, Poço 02, ...)
    eqs.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name), "pt-BR", { numeric: true }));
    for (const eq of eqs) {
      const inserts: any[] = [];
      // IMPORTANTE: engine compara time_on != time_off. Para on-only usamos time_off=23:59,
      // para off-only usamos time_on=00:00 — mesmo padrão de janela do frontend.
      if (hasOn) inserts.push({ farm_id: farmId, equipment_id: eq.id, active: true, mode: "on-only", days, time_on: cmd.timeOn, time_off: "23:59" });
      if (hasOff) inserts.push({ farm_id: farmId, equipment_id: eq.id, active: true, mode: "off-only", days, time_on: "00:00", time_off: cmd.timeOff });
      const { error } = await supabase.from("automation_schedules").insert(inserts.map((i: any) => ({ ...i, ..._waAuditCreate })));
      if (error) {
        failLines.push(`• ${eq.name}: ❌ ${error.message}`);
      } else {
        const parts: string[] = [];
        if (hasOn) parts.push(`Liga ${cmd.timeOn}`);
        if (hasOff) parts.push(`Desliga ${cmd.timeOff}`);
        okLines.push(`• ${eq.name} — ${parts.join(" / ")} (${daysLabel})`);
      }
    }

    const { data: engRow } = await supabase
      .from("automation_engine").select("enabled").eq("farm_id", farmId).maybeSingle();
    const globalOn = !!engRow?.enabled;

    const out: string[] = [];
    if (okLines.length) {
      const plural = okLines.length === 1 ? "equipamento" : "equipamentos";
      out.push(`✅ Programação criada para ${okLines.length} ${plural}:`);
      out.push("");
      out.push(...okLines);
    }
    if (failLines.length) {
      if (out.length) out.push("");
      out.push("❌ Falhas:");
      out.push(...failLines);
    }
    if (notFoundLines.length) {
      if (out.length) out.push("");
      out.push(`⚠️ Não encontrados: ${notFoundLines.join(", ")}`);
    }
    if (okLines.length && !globalOn) {
      out.push("");
      out.push("⚠️ Modo Automático precisa estar ATIVO para executar.");
      out.push("Envie *automatico on* para ativar.");
    }
    await sendWhatsAppText(from, out.join("\n"), farmId);
    return;
  }



  // ===== del_help: uso do comando apagar =====
  if (cmd.kind === "del_help") {
    await sendWhatsAppText(
      from,
      "🗑️ Para apagar, especifique o equipamento:\n\n" +
        "• apagar prog poço 02 (apaga todas do Poço 02)\n" +
        "• apagar prog poço 02 ligar 07:17 (apaga só essa)\n" +
        "• apagar prog poço 02 qui (remove só Quinta)\n" +
        "• apagar prog poço 1-4 (apaga todas dos Poços 1 a 4)\n" +
        "• apagar prog todas (apaga TODAS da fazenda)",
      farmId,
    );
    return;
  }

  // ===== del_all_farm: apaga todas as programações da fazenda =====
  if (cmd.kind === "del_all_farm") {
    const { error, count } = await supabase
      .from("automation_schedules")
      .delete({ count: "exact" })
      .eq("farm_id", farmId);
    if (error) {
      await sendWhatsAppText(from, `❌ Falha ao apagar programações: ${error.message}`, farmId);
      return;
    }
    const n = count ?? 0;
    await sendWhatsAppText(
      from,
      `🗑️ Todas as programações excluídas (${n} registro${n === 1 ? "" : "s"} removido${n === 1 ? "" : "s"}).`,
      farmId,
    );
    return;
  }

  // ===== del_schedule: remove programações do equipamento =====
  if (cmd.kind === "del_schedule") {
    const eqs = await resolveEquipmentsForBase(farmId, cmd.base, cmd.nums);
    if (!eqs.length) {
      await sendWhatsAppText(from, `❓ Equipamento "${cmd.base} ${cmd.nums.join(",")}" não encontrado.`, farmId);
      return;
    }
    const dayFilter = cmd.days && cmd.days.length ? new Set(cmd.days) : null;
    const timeOn = (cmd as any).timeOn as string | null | undefined;
    const timeOff = (cmd as any).timeOff as string | null | undefined;
    const hasTimeFilter = !!(timeOn || timeOff);
    const lines: string[] = [];
    for (const eq of eqs) {
      // ── Filtro por horário específico (ex: "apagar prog poço 02 ligar 07:17")
      if (hasTimeFilter) {
        let q = supabase
          .from("automation_schedules")
          .select("id, mode, time_on, time_off, days")
          .eq("farm_id", farmId)
          .eq("equipment_id", eq.id);
        const { data: rows } = await q;
        const matched = (rows ?? []).filter((r: any) => {
          const ton = String(r.time_on ?? "").slice(0, 5);
          const toff = String(r.time_off ?? "").slice(0, 5);
          if (timeOn && r.mode === "on-only" && ton === timeOn) return true;
          if (timeOff && r.mode === "off-only" && toff === timeOff) return true;
          return false;
        });
        if (matched.length === 0) {
          const tTxt = timeOn ? `Liga ${timeOn}` : `Desliga ${timeOff}`;
          lines.push(`⚠️ ${eq.name}: nenhuma programação encontrada com ${tTxt}.`);
          continue;
        }
        for (const r of matched) {
          await supabase.from("automation_schedules").update(_waAuditUpdate).eq("id", (r as any).id);
          await supabase.from("automation_schedules").delete().eq("id", (r as any).id);
          const ton = String((r as any).time_on ?? "").slice(0, 5);
          const toff = String((r as any).time_off ?? "").slice(0, 5);
          const dTxt = formatDays((r as any).days ?? []);
          const what = (r as any).mode === "on-only" ? `Liga ${ton}` : `Desliga ${toff}`;
          lines.push(`🗑️ Programação excluída: ${eq.name} ${what} (${dTxt})`);
        }
        continue;
      }
      if (!dayFilter) {
        const { error, count } = await supabase
          .from("automation_schedules")
          .delete({ count: "exact" })
          .eq("farm_id", farmId)
          .eq("equipment_id", eq.id);
        if (error) lines.push(`• ${eq.name}: ❌ ${error.message}`);
        else lines.push(`🗑️ Programações do ${eq.name} excluídas (${count ?? 0} registro${(count ?? 0) === 1 ? "" : "s"} removido${(count ?? 0) === 1 ? "" : "s"}).`);
        continue;
      }
      // Com filtro de dias: para cada row, remove dias do array; deleta se vazio.
      const { data: rows } = await supabase
        .from("automation_schedules")
        .select("id, days")
        .eq("farm_id", farmId)
        .eq("equipment_id", eq.id);
      let removed = 0;
      let updated = 0;
      for (const r of (rows ?? [])) {
        const orig: string[] = (r as any).days ?? [];
        const remaining = orig.filter((d) => !dayFilter.has(d));
        if (remaining.length === orig.length) continue;
        if (remaining.length === 0) {
          await supabase.from("automation_schedules").update(_waAuditUpdate).eq("id", (r as any).id);
          await supabase.from("automation_schedules").delete().eq("id", (r as any).id);
          removed++;
        } else {
          await supabase.from("automation_schedules").update({ days: remaining, ..._waAuditUpdate }).eq("id", (r as any).id);
          updated++;
        }
      }
      const dTxt = formatDays(Array.from(dayFilter));
      if (removed === 0 && updated === 0) {
        lines.push(`⚠️ ${eq.name}: nenhuma programação encontrada para ${dTxt}.`);
      } else {
        lines.push(`🗑️ Programação de ${dTxt} do ${eq.name} excluída (${removed} removida${removed === 1 ? "" : "s"}, ${updated} ajustada${updated === 1 ? "" : "s"}).`);
      }
    }
    await sendWhatsAppText(from, lines.join("\n"), farmId);
    return;
  }


  // ===== edit_help: uso do comando editar =====
  if (cmd.kind === "edit_help") {
    await sendWhatsAppText(
      from,
      "✏️ Para editar uma programação, use o formato:\n\n" +
        "editar prog [equipamento] ligar [HH:MM] desligar [HH:MM] [dias]\n\n" +
        "Exemplos:\n" +
        "• editar prog poço 02 ligar 07:00 desligar 19:00 seg-sex\n" +
        "• editar prog poço 02 ligar 07:00 (muda só o horário de ligar)\n" +
        "• editar prog poço 02 seg-dom (muda só os dias)\n" +
        "• excluir prog poço 02 (remove a programação)",
      farmId,
    );
    return;
  }

  // ===== edit_schedule: atualiza programações existentes =====
  if (cmd.kind === "edit_schedule") {
    const eqs = await resolveEquipmentsForBase(farmId, cmd.base, cmd.nums);
    if (!eqs.length) {
      const nLabel = cmd.nums.length ? ` ${cmd.nums.join(",")}` : "";
      await sendWhatsAppText(from, `❓ Equipamento "${cmd.base}${nLabel}" não encontrado.`, farmId);
      return;
    }
    eqs.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name), "pt-BR", { numeric: true }));

    const hasOn = !!cmd.timeOn;
    const hasOff = !!cmd.timeOff;
    const hasDays = !!(cmd.days && cmd.days.length);
    const fullReplace = hasDays && (hasOn || hasOff);

    const out: string[] = [];
    let title = "✏️ Programação atualizada:";
    if (!hasDays && hasOn && !hasOff) title = "✏️ Horário de ligar atualizado:";
    else if (!hasDays && hasOff && !hasOn) title = "✏️ Horário de desligar atualizado:";
    else if (!hasDays && hasOn && hasOff) title = "✏️ Horários atualizados:";
    else if (hasDays && !hasOn && !hasOff) title = "✏️ Dias atualizados:";
    out.push(title);

    for (const eq of eqs) {
      const { data: rows } = await supabase
        .from("automation_schedules")
        .select("id, mode, days, time_on, time_off, active")
        .eq("farm_id", farmId)
        .eq("equipment_id", eq.id);
      const existing = (rows ?? []) as any[];

      if (!existing.length) {
        out.push("");
        out.push(`⚠️ ${eq.name} não tem programação cadastrada. Use "programar ${cmd.base} ${extractNumbers(eq.name)[0] ?? ""} ligar HH:MM desligar HH:MM [dias]" para criar.`);
        continue;
      }

      // Dias atuais (união dos rows) para manter quando não informados
      const currentDaysSet = new Set<string>();
      for (const r of existing) for (const d of (r.days ?? [])) currentDaysSet.add(d);
      const currentDays = Array.from(currentDaysSet);

      const onRow = existing.find((r) => r.mode === "on-only");
      const offRow = existing.find((r) => r.mode === "off-only");
      const prevOn = onRow?.time_on ? String(onRow.time_on).slice(0, 5) : null;
      const prevOff = offRow?.time_off ? String(offRow.time_off).slice(0, 5) : null;

      try {
        if (fullReplace) {
          // Substituição completa: apaga tudo e cria novo
          await supabase.from("automation_schedules").delete()
            .eq("farm_id", farmId).eq("equipment_id", eq.id);
          const days = cmd.days!;
          const inserts: any[] = [];
          if (hasOn) inserts.push({ farm_id: farmId, equipment_id: eq.id, active: true, mode: "on-only", days, time_on: cmd.timeOn, time_off: "23:59" });
          if (hasOff) inserts.push({ farm_id: farmId, equipment_id: eq.id, active: true, mode: "off-only", days, time_on: "00:00", time_off: cmd.timeOff });
          await supabase.from("automation_schedules").insert(inserts.map((i: any) => ({ ...i, ..._waAuditCreate })));

          out.push("");
          out.push(`• ${eq.name}`);
          const parts: string[] = [];
          if (hasOn) parts.push(`Liga: ${cmd.timeOn}`);
          if (hasOff) parts.push(`Desliga ${cmd.timeOff}`);
          out.push(`  ${parts.join(" / ")}`);
          out.push(`  Dias: ${formatDays(days)}`);
          out.push(`  Status: ✅ Ativa`);
        } else if (hasDays && !hasOn && !hasOff) {
          // Só dias: atualiza days de todas as rows existentes
          for (const r of existing) {
            await supabase.from("automation_schedules").update({ days: cmd.days, ..._waAuditUpdate }).eq("id", r.id);
          }
          out.push("");
          out.push(`• ${eq.name}`);
          if (prevOn) out.push(`  Liga: ${prevOn} (mantido)`);
          if (prevOff) out.push(`  Desliga: ${prevOff} (mantido)`);
          out.push(`  Dias: ${formatDays(cmd.days!)} (antes: ${formatDays(currentDays)})`);
        } else {
          // Só horários: atualiza time_on/time_off conforme presente.
          // Se row não existe para o modo, cria com dias atuais.
          const daysToUse = currentDays.length ? currentDays : ["seg", "ter", "qua", "qui", "sex"];
          if (hasOn) {
            if (onRow) {
              await supabase.from("automation_schedules").update({ time_on: cmd.timeOn, time_off: "23:59", ..._waAuditUpdate }).eq("id", onRow.id);
            } else {
              await supabase.from("automation_schedules").insert({ farm_id: farmId, equipment_id: eq.id, active: true, mode: "on-only", days: daysToUse, time_on: cmd.timeOn, time_off: "23:59", ..._waAuditCreate });
            }
          }
          if (hasOff) {
            if (offRow) {
              await supabase.from("automation_schedules").update({ time_on: "00:00", time_off: cmd.timeOff, ..._waAuditUpdate }).eq("id", offRow.id);
            } else {
              await supabase.from("automation_schedules").insert({ farm_id: farmId, equipment_id: eq.id, active: true, mode: "off-only", days: daysToUse, time_on: "00:00", time_off: cmd.timeOff, ..._waAuditCreate });
            }
          }
          out.push("");
          out.push(`• ${eq.name}`);
          if (hasOn) out.push(`  Liga: ${cmd.timeOn}${prevOn ? ` (antes: ${prevOn})` : ""}`);
          else if (prevOn) out.push(`  Liga: ${prevOn} (mantido)`);
          if (hasOff) out.push(`  Desliga: ${cmd.timeOff}${prevOff ? ` (antes: ${prevOff})` : ""}`);
          else if (prevOff) out.push(`  Desliga: ${prevOff} (mantido)`);
          out.push(`  Dias: ${formatDays(daysToUse)} (mantido)`);
        }
      } catch (e: any) {
        out.push("");
        out.push(`• ${eq.name}: ❌ ${e?.message ?? "falha ao atualizar"}`);
      }
    }

    const { data: engRow } = await supabase
      .from("automation_engine").select("enabled").eq("farm_id", farmId).maybeSingle();
    if (!engRow?.enabled) {
      out.push("");
      out.push("⚠️ Modo Automático precisa estar ATIVO para executar.");
      out.push("Envie *automatico on* para ativar.");
    }
    await sendWhatsAppText(from, out.join("\n"), farmId);
    return;
  }


  if (cmd.kind === "add_holiday") {
    const { error } = await supabase
      .from("national_holidays")
      .upsert({ holiday_date: cmd.date, name: `WhatsApp · ${op.name}` }, { onConflict: "holiday_date" });
    if (error) {
      await sendWhatsAppText(from, `❌ Falha ao adicionar feriado: ${error.message}`, farmId);
      return;
    }
    const [y, m, d] = cmd.date.split("-");
    await sendWhatsAppText(
      from,
      `📅 Feriado adicionado: ${d}/${m}/${y}.\nEquipamentos em modo automático NÃO ligarão neste dia (salvo configuração especial por equipamento).`,
      farmId,
    );
    return;
  }
  if (cmd.kind === "list_holidays") {
    const today = new Date().toISOString().slice(0, 10);
    const { data: hs } = await supabase
      .from("national_holidays")
      .select("holiday_date, name")
      .gte("holiday_date", today)
      .order("holiday_date", { ascending: true })
      .limit(20);
    if (!hs || hs.length === 0) {
      await sendWhatsAppText(from, "📅 Nenhum feriado futuro cadastrado.", farmId);
      return;
    }
    const lines = ["📅 Próximos feriados:", ""];
    for (const h of hs as any[]) {
      const [y, m, d] = String(h.holiday_date).split("-");
      lines.push(`• ${d}/${m}/${y} — ${h.name}`);
    }
    await sendWhatsAppText(from, lines.join("\n"), farmId);
    return;
  }

  // ===== ops: status/turn_on/turn_off com 0..N números =====
  {
    const bridge = await getBridgeHealth(farmId);
    if (bridge.state === "offline") {
      const isQuery = cmd.ops.every((o) => o.action === "status");
      await sendWhatsAppText(from, isQuery ? bridgeOfflineMsg(bridge) : bridgeOfflineCmdMsg, farmId);
      return;
    }
  }

  // Carrega pool de equipamentos da base (uma única vez, com variantes).
  const op0 = cmd.ops[0];
  const variants = baseSearchVariants(op0.base);
  const seen = new Set<string>();
  const pool: any[] = [];
  for (const v of variants) {
    const { data } = await supabase
      .from("equipments")
      .select(selectCols)
      .eq("farm_id", farmId)
      .ilike("name", `%${v}%`)
      .limit(500);
    for (const r of (data ?? []) as any[]) {
      if (!seen.has(r.id)) { seen.add(r.id); pool.push(r); }
    }
  }
  console.log(`WA EQ LOOKUP — base="${op0.base}" pool=${pool.length} nums=${JSON.stringify(op0.nums)}`);

  const findByNum = (num: number): any | null => {
    return pool.find((e) => extractNumbers(e.name).includes(num)) ?? null;
  };

  // Regra "dígitos colados": se o usuário enviou UM número de 3+ dígitos
  // (ex.: "bomba 123") e nenhum equipamento tem esse número exato, expande
  // em dígitos individuais [1,2,3]. Números de 2 dígitos (10, 11, 12) nunca
  // são quebrados — são tratados como número único.
  let effectiveNums: number[] = op0.nums.slice();
  if (
    effectiveNums.length === 1 &&
    effectiveNums[0] >= 100 &&
    !findByNum(effectiveNums[0])
  ) {
    const digits = String(effectiveNums[0]).split("").map((d) => parseInt(d, 10));
    const allMatch = digits.every((d) => !!findByNum(d));
    if (allMatch) {
      console.log(`WA EQ LOOKUP — expandindo ${effectiveNums[0]} → ${JSON.stringify(digits)}`);
      effectiveNums = digits;
    }
  }

  // Resolve a lista de alvos. Se não tem números, usa o primeiro item do pool.
  type Target = { num: number | null; eq: any | null };
  const targets: Target[] = effectiveNums.length === 0
    ? [{ num: null, eq: pool[0] ?? null }]
    : effectiveNums.map((n) => ({ num: n, eq: findByNum(n) }));

  // Se nenhum encontrado: lista equipamentos disponíveis.
  const anyFound = targets.some((t) => !!t.eq);
  if (!anyFound) {
    const { data: all } = await supabase
      .from("equipments")
      .select("name")
      .eq("farm_id", farmId)
      .limit(50);
    const lista = (all ?? []).map((e: any) => `• ${e.name}`).join("\n") || "(nenhum cadastrado)";
    await sendWhatsAppText(
      from,
      `❓ Equipamento "${op0.raw}" não encontrado.\n\nEquipamentos disponíveis nesta fazenda:\n${lista}`,
      farmId,
    );
    return;
  }

  // ===== STATUS =====
  if (op0.action === "status") {
    if (targets.length === 1 && targets[0].eq && effectiveNums.length <= 1) {
      const eq = targets[0].eq;
      const { estado } = computeEqState(eq);
      await sendWhatsAppText(
        from,
        `📊 ${eq.name}\n\nStatus: ${estado}\nOrigem: ${originLabel(eq.last_actuation_origin)}\nÚltima comunicação: ${fmtLastComm(eq.last_communication)}`,
        farmId,
      );
      return;
    }
    const lines: string[] = ["📊 Status múltiplo:", ""];
    for (const t of targets) {
      if (!t.eq) {
        lines.push(`• ${op0.base} ${t.num} — ❓ não encontrado`);
      } else {
        const { estado } = computeEqState(t.eq);
        lines.push(`• ${t.eq.name} — ${estado} — ${originLabel(t.eq.last_actuation_origin)}`);
      }
    }
    await sendWhatsAppText(from, lines.join("\n"), farmId);
    return;
  }

  // ===== TURN ON / TURN OFF — registra como pendente e pede confirmação =====
  const turnOn = op0.action === "turn_on";
  const verbo = turnOn ? "LIGAR" : "DESLIGAR";

  if (turnOn && !op.can_turn_on && !isSuperAdmin(op)) {
    await sendWhatsAppText(from, "🚫 Você não tem permissão para LIGAR equipamentos.", op.farm_id);
    return;
  }
  if (!turnOn && !op.can_turn_off && !isSuperAdmin(op)) {
    await sendWhatsAppText(from, "🚫 Você não tem permissão para DESLIGAR equipamentos.", op.farm_id);
    return;
  }

  // Limpa pendências anteriores deste telefone (uma confirmação por vez).
  await supabase
    .from("whatsapp_pending_actions")
    .delete()
    .eq("operator_phone", phone);

  const validTargets = targets.filter((t) => !!t.eq);
  const missingTargets = targets.filter((t) => !t.eq);

  if (validTargets.length === 0) {
    await sendWhatsAppText(from, `❓ Equipamento "${op0.raw}" não encontrado.`, farmId);
    return;
  }

  // Pré-checagem de estado e comunicação.
  const offlineTargets: typeof validTargets = [];
  const alreadyTargets: typeof validTargets = [];
  const actionableTargets: typeof validTargets = [];
  const maintenanceTargets: typeof validTargets = [];
  for (const t of validTargets) {
    // Bloqueio total: equipamento em manutenção rejeita LIGAR.
    // Para DESLIGAR, permite (não há sentido manter ligado em manutenção).
    if (turnOn && t.eq?.maintenance_mode === true) {
      maintenanceTargets.push(t);
      continue;
    }
    const commStatus = String(t.eq.communication_status ?? "").toLowerCase();
    if (commStatus === "offline") {
      offlineTargets.push(t);
      continue;
    }
    const currentOn = t.eq.desired_running === true;
    if (currentOn === turnOn) {
      alreadyTargets.push(t);
    } else {
      actionableTargets.push(t);
    }
  }

  const estadoLabel = turnOn ? "LIGADO" : "DESLIGADO";

  // Nada para acionar — responde imediatamente.
  if (actionableTargets.length === 0) {
    // Caso especial: 1 alvo em manutenção → mensagem detalhada.
    if (maintenanceTargets.length === 1 && alreadyTargets.length === 0 && offlineTargets.length === 0) {
      await sendWhatsAppText(from, maintenanceLockMessage(maintenanceTargets[0].eq), farmId);
      return;
    }
    const lines: string[] = [];
    if (alreadyTargets.length > 0) {
      if (alreadyTargets.length === 1 && offlineTargets.length === 0 && maintenanceTargets.length === 0) {
        await sendWhatsAppText(from, `ℹ️ ${alreadyTargets[0].eq.name} já está ${estadoLabel}.`, farmId);
        return;
      }
      if (offlineTargets.length === 0 && maintenanceTargets.length === 0 && alreadyTargets.length === validTargets.length) {
        await sendWhatsAppText(from, `ℹ️ Todos já estão ${estadoLabel}S.`, farmId);
        return;
      }
      for (const t of alreadyTargets) lines.push(`ℹ️ ${t.eq.name} já está ${estadoLabel}.`);
    }
    if (offlineTargets.length > 0) {
      if (lines.length) lines.push("");
      for (const t of offlineTargets) {
        lines.push(`⚠️ ${t.eq.name} está OFFLINE. Comando não pode ser enviado.`);
      }
    }
    if (maintenanceTargets.length > 0) {
      if (lines.length) lines.push("");
      for (const t of maintenanceTargets) {
        lines.push(`🔧 ${t.eq.name} em MANUTENÇÃO${t.eq.maintenance_reason ? ` — ${t.eq.maintenance_reason}` : ""}. Não pode ser ligado.`);
      }
    }
    await sendWhatsAppText(from, lines.join("\n"), farmId);
    return;
  }

  // ── BYPASS de confirmação: somente super_admin OU operador explicitamente liberado.
  // Operadores comuns (skip_confirmation=false) SEMPRE recebem "Responda SIM".
  const skipConfirm = op.role === "super_admin" || op.skip_confirmation === true;
  if (skipConfirm) {
    // Avisos sobre alvos não acionáveis (não bloqueia o lote).
    const preNotes: string[] = [];
    for (const t of alreadyTargets) preNotes.push(`ℹ️ ${t.eq.name} já está ${estadoLabel}.`);
    for (const t of offlineTargets) preNotes.push(`⚠️ ${t.eq.name} está OFFLINE.`);
    for (const t of maintenanceTargets) preNotes.push(`🔧 ${t.eq.name} em MANUTENÇÃO.`);
    if (missingTargets.length) {
      preNotes.push("⚠️ Não encontrados (ignorados): " + missingTargets.map((t) => `${op0.base} ${t.num}`).join(", "));
    }
    if (preNotes.length) await sendWhatsAppText(from, preNotes.join("\n"), farmId);
    await executeTurnCommands({
      from, phone, op, farmId, turnOn,
      equipmentIds: actionableTargets.map((t) => t.eq.id),
      originalText: text,
    });
    return;
  }

  const pendingRows = actionableTargets.map((t) => ({
    operator_phone: phone,
    action_type: turnOn ? "liga" : "desliga",
    equipment_id: t.eq.id,
    equipment_name: t.eq.name,
    farm_id: farmId,
    operator_id: op.id ?? null,
  }));
  const { error: pendErr } = await supabase
    .from("whatsapp_pending_actions")
    .insert(pendingRows);
  if (pendErr) {
    console.error("WA: falha ao registrar pendências", pendErr);
    await sendWhatsAppText(from, `❌ Não foi possível registrar a confirmação: ${pendErr.message}`, farmId);
    return;
  }


  const lines: string[] = [];

  // Notas sobre equipamentos já no estado desejado ou offline.
  for (const t of alreadyTargets) {
    lines.push(`ℹ️ ${t.eq.name} já está ${estadoLabel}.`);
  }
  for (const t of offlineTargets) {
    lines.push(`⚠️ ${t.eq.name} está OFFLINE. Comando não pode ser enviado.`);
  }
  for (const t of maintenanceTargets) {
    lines.push(`🔧 ${t.eq.name} em MANUTENÇÃO. Não pode ser ligado.`);
  }
  if (lines.length) lines.push("");

  if (actionableTargets.length === 1) {
    lines.push("⚠️ Confirmar comando:", "");
    lines.push(`• ${verbo} ${actionableTargets[0].eq.name}`);
  } else {
    lines.push("⚠️ Confirmar comandos:", "");
    for (const t of actionableTargets) lines.push(`• ${verbo} ${t.eq.name}`);
  }

  if (missingTargets.length) {
    lines.push("");
    lines.push("⚠️ Não encontrados (serão ignorados):");
    for (const t of missingTargets) lines.push(`• ${op0.base} ${t.num}`);
  }
  lines.push("");
  lines.push("Responda SIM para confirmar. (expira em 1 min)");


  await sendWhatsAppText(from, lines.join("\n"), farmId);
  } // ← fim handleParsedFlow
}

// ──────────────────────────────────────────────────────────────────────────────
// Executa de fato uma lista de equipamentos após confirmação SIM.
// Reutilizada tanto pelo fluxo direto quanto pelo confirmador.
// ──────────────────────────────────────────────────────────────────────────────
async function executeTurnCommands(args: {
  from: string;
  phone: string;
  op: any;
  farmId: string | null;
  turnOn: boolean;
  equipmentIds: string[];
  originalText: string;
  silent?: boolean;
}) {
  const { from, phone, op, farmId, turnOn, equipmentIds, originalText, silent } = args;

  const verbo = turnOn ? "LIGAR" : "DESLIGAR";

  if (!isSuperAdmin(op) && (op as any)?.can_control === false) {
    await sendWhatsAppText(from, "🚫 Você não tem permissão para controlar equipamentos. Fale com o administrador.", op.farm_id ?? farmId);
    return;
  }


  if (!farmId) {
    await sendWhatsAppText(from, "🚫 Nenhuma fazenda associada.", op.farm_id);
    return;
  }

  // created_by: user_id do operador → fallback 1º admin/owner da fazenda.
  let createdBy: string | null = (op as any).user_id ?? null;
  if (!createdBy && farmId) {
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("farm_id", farmId)
      .in("role", ["admin", "owner"])
      .limit(1)
      .maybeSingle();
    createdBy = (roleRow as any)?.user_id ?? null;
  }
  if (!createdBy) {
    await sendWhatsAppText(
      from,
      `❌ Operador ${op.name} não está vinculado a um usuário da plataforma. Peça para o administrador vincular em Integrações → WhatsApp.`,
      farmId,
    );
    return;
  }

  const selectCols = "id, name, desired_running, communication_status, last_communication, last_actuation_origin, farm_id, hw_id, saida, plc_group_id, last_outputs_state, type, command_blocked_until, maintenance_mode, maintenance_reason, maintenance_started_at, maintenance_started_by, maintenance_started_via";
  const { data: eqsRaw } = await supabase
    .from("equipments")
    .select(selectCols)
    .in("id", equipmentIds);
  const eqs = (eqsRaw ?? []) as any[];
  if (!eqs.length) {
    await sendWhatsAppText(from, "❓ Equipamentos pendentes não encontrados mais no sistema.", farmId);
    return;
  }

  // ATENÇÃO: super_admin NÃO pula mais a confirmação. O fluxo correto é sempre
  // "⏳ enviado, aguardando confirmação" → "✅ confirmado" (ou ⚠️ não confirmou).
  // Apenas operadores com skip_confirmation=true explícito recebem ack imediato.
  const skipConfirmMode = (op as any)?.skip_confirmation === true;
  const verboPast = turnOn ? "LIGADA" : "DESLIGADA";

  const okLines: string[] = [];
  const errLines: string[] = [];
  const polls: Array<() => Promise<string>> = [];
  const successEqs: Array<{ id: string; name: string }> = [];

  for (const eq of eqs) {
    if (turnOn && eq?.maintenance_mode === true) {
      errLines.push(`🔧 ${eq.name} em MANUTENÇÃO — bloqueado, não pode ser ligado.`);
      continue;
    }
    const result = await enqueueManualPumpCommandSrv({
      eq, turnOn,
      whoLabel: `${op.name}|${phone}`,
      createdBy,
    });
    if (!result.ok) {
      console.error("WA: enqueue manual falhou", eq.name, result.reason);
      errLines.push(`• ${eq.name} — ❌ ${result.reason}`);
      continue;
    }

    const hhNow = new Date().toLocaleTimeString("pt-BR", {
      timeZone: "America/Bahia", hour: "2-digit", minute: "2-digit",
    });
    if (skipConfirmMode) {
      okLines.push(`• ${eq.name} ${verboPast} — ${hhNow}`);
    } else {
      okLines.push(`• ${verbo} ${eq.name} — Aguardando confirmação...`);
    }
    successEqs.push({ id: eq.id, name: eq.name });

    await supabase.from("automation_log").insert({
      farm_id: farmId,
      equipment_id: eq.id,
      equipment_name: eq.name,
      action: turnOn ? "turn_on" : "turn_off",
      origin: "remote",
      result: "pending",
      actor_label: `WhatsApp · ${op.name}`,
      source_device: `whatsapp:${phone}`,
      details: { message: originalText, operator_id: op.id, phone, channel: "whatsapp", confirmed: true },
    });

    // Enqueue 90s verification — SKIPPED for super_admin / skip_confirmation
    // (eles não recebem polling, então também não devem receber alerta de "não confirmado").
    if (!skipConfirmMode) {
      try {
        await supabase.from("command_verifications").insert({
          equipment_id: eq.id,
          equipment_name: eq.name,
          expected_state: turnOn ? "on" : "off",
          operator_phone: phone,
          farm_id: farmId,
        });
      } catch (e) {
        console.error("WA: failed to enqueue command_verification", eq.name, e);
      }
    }

    // NÃO suprimir pending_notifications: a fila só dispara quando o hardware
    // confirma a mudança real de estado (last_outputs_state). Operadores demais
    // recebem a notificação APENAS depois dessa confirmação, via drain do cron.




    if (skipConfirmMode) continue; // super_admin: no polling, no false-alert messages
    const cmdId = (result as any).commandId as string | undefined;
    const sIdx = Math.max(1, Math.min(6, eq.saida ?? 1));
    polls.push(async (): Promise<string> => {
      const verboGer = turnOn ? "ligamento" : "desligamento";
      // 18 tentativas × 5s = 90s de janela de confirmação de hardware.
      for (let i = 0; i < 18; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        try {
          const { data: fresh } = await supabase
            .from("equipments")
            .select("name, desired_running, communication_status, last_outputs_state")
            .eq("id", eq.id).maybeSingle();
          if (!fresh) continue;
          const outs: string = (fresh as any).last_outputs_state ?? "";
          const physicallyOn =
            /^[01]{6}$/.test(outs) ? outs.charAt(sIdx - 1) === "1"
            : /^[01]$/.test(outs) ? outs === "1"
            : null;
          const physicalOk = physicallyOn !== null && physicallyOn === turnOn;
          let cmdExecuted = false;
          if (cmdId) {
            const { data: cmdRow } = await supabase
              .from("commands").select("status").eq("id", cmdId).maybeSingle();
            cmdExecuted = (cmdRow as any)?.status === "executed";
          }
          if (physicalOk || cmdExecuted) {
            const hh = new Date().toLocaleTimeString("pt-BR", {
              timeZone: "America/Bahia", hour: "2-digit", minute: "2-digit",
            });
            // Notifica OS DEMAIS operadores da fazenda — trigger DB não faz isso
            // para comandos remotos (WhatsApp/web). Chamada imediata garante o
            // envio somente após a confirmação real do hardware.
            try {
              await supabase.functions.invoke("whatsapp-automation-notify", {
                body: {
                  immediate: true,
                  type: "equipment_control",
                  equipment_id: eq.id,
                  action: turnOn ? "ligado" : "desligado",
                  source: op.name ?? phone,
                  via: "whatsapp",
                  exclude_phone: phone,
                },
              });
            } catch (notifyErr) {
              console.error("WA: notify others failed", eq.name, notifyErr);
            }
            return `• ${(fresh as any).name} ${verboPast} com sucesso — ${hh}`;
          }
        } catch (e) {
          console.error(`WA: poll #${i + 1} (${eq.name}) falhou`, e);
        }
      }
      let offlineSuffix = "";
      try {
        const { data: finalEq } = await supabase
          .from("equipments")
          .select("communication_status, last_communication")
          .eq("id", eq.id).maybeSingle();
        const cs = String((finalEq as any)?.communication_status ?? "").toLowerCase();
        const lastMs = (finalEq as any)?.last_communication
          ? new Date((finalEq as any).last_communication).getTime() : 0;
        const stale = lastMs > 0 && (Date.now() - lastMs) > 30 * 60 * 1000;
        if (cs === "offline" && stale) offlineSuffix = " (possivelmente offline)";
      } catch (_) { /* ignore */ }
      return `• ${eq.name} — ⚠️ ${verboGer} NÃO confirmado em 90s${offlineSuffix}`;
    });
  }

  const ackParts: string[] = [];
  if (okLines.length > 0) {
    if (skipConfirmMode) {
      if (okLines.length === 1) {
        ackParts.push(`✅ Comando executado: ${okLines[0].replace(/^•\s*/, "")}`);
      } else {
        ackParts.push("✅ Comandos executados:");
        ackParts.push(...okLines);
      }
    } else if (okLines.length === 1) {
      ackParts.push(`✅ Comando ${okLines[0].replace(/^•\s*/, "").replace(/\s*—\s*Aguardando.*$/, "")} enviado. Aguardando confirmação...`);
    } else {
      ackParts.push("✅ Comandos enviados:");
      ackParts.push(...okLines);
    }
  }
  if (errLines.length > 0) {
    if (ackParts.length) ackParts.push("");
    ackParts.push("⚠️ Erros:");
    ackParts.push(...errLines);
  }
  ackParts.push("");
  ackParts.push(`Operador: ${op.name}`);
  if (!silent) await sendWhatsAppText(from, ackParts.join("\n"), farmId);

  // Os DEMAIS operadores são notificados SOMENTE após o hardware confirmar a
  // mudança real de estado, via trigger DB → pending_notifications → drain do
  // cron `whatsapp-automation-notify`. Nada de notificação imediata aqui.

  const runAllPolls = async () => {
    const results = await Promise.all(polls.map((p) => p()));
    if (results.length === 0) return;
    if (!silent && !skipConfirmMode) {
      await sendWhatsAppText(from, `✅ Confirmações:\n${results.join("\n")}`, farmId);
    }
  };
  // @ts-ignore — EdgeRuntime existe no runtime Deno do Supabase
  if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
    // @ts-ignore
    EdgeRuntime.waitUntil(runAllPolls());
  } else {
    runAllPolls();
  }
}


// ═══════════════════════════════════════════════════════════════
// AUTOMAÇÕES INDEPENDENTES (Phase 3) — WhatsApp commands
// ═══════════════════════════════════════════════════════════════
async function handleAutomacoesCommand(
  rawText: string,
  farmId: string,
  op: any,
  phone: string,
  from: string,
): Promise<boolean> {
  const text = (rawText || "").trim();
  if (!text) return false;
  const t = stripAccents(text.toLowerCase()).replace(/[.!?]+$/g, "").trim();

  const isAutoPrefix = /^(automacao|automacoes|automação|automações)\b/.test(t);
  const isAgendarPrefix = /^agendar\b/.test(t);
  const isCriar = /^criar\s+automacao\b/.test(t);

  // LISTING
  if (/^(ver|listar)?\s*(automacoes|automações)$/.test(t) || /^minhas automacoes$/.test(t)) {
    return await listAutomacoes(farmId, from);
  }

  // HISTORY
  if (/^(historico|log)\s+(automacoes|automações)/.test(t)) {
    return await historyAutomacoes(farmId, from);
  }

  // DELETE
  let m = t.match(/^(excluir|apagar|deletar|remover)\s+automacao\s+(.+)$/);
  if (m) return await deleteAutomacaoByRef(farmId, m[2].trim(), op, from);

  // ACTIVATE / DEACTIVATE
  m = t.match(/^(ativar|reativar)\s+automacao\s+(.+)$/);
  if (m) return await toggleAutomacao(farmId, m[2].trim(), true, op, from);
  m = t.match(/^(desativar|pausar)\s+automacao\s+(.+)$/);
  if (m) return await toggleAutomacao(farmId, m[2].trim(), false, op, from);

  // CREATION
  if (isAutoPrefix || isAgendarPrefix || isCriar) {
    return await createAutomacaoFromText(text, t, farmId, op, phone, from, { isAgendar: isAgendarPrefix });
  }

  return false;
}

async function listAutomacoes(farmId: string, from: string): Promise<boolean> {
  const { data } = await supabase
    .from("automations")
    .select("id, name, is_active, type, created_at, automation_triggers(time_value, days, condition_type, scheduled_for, trigger_type), automation_actions(action, equipment_ids)")
    .eq("farm_id", farmId)
    .order("created_at", { ascending: false })
    .limit(30);
  if (!data || data.length === 0) {
    await sendWhatsAppText(from, "📭 Nenhuma automação cadastrada.", farmId);
    return true;
  }
  const lines = data.map((a: any, idx: number) => {
    const tr = (a.automation_triggers ?? [])[0];
    const act = (a.automation_actions ?? [])[0];
    const status = a.is_active ? "🟢" : "⚪";
    let when = "—";
    if (tr?.trigger_type === "time" && tr.time_value) when = `${String(tr.time_value).slice(0,5)}`;
    else if (tr?.trigger_type === "condition") when = tr.condition_type ?? "condição";
    else if (tr?.trigger_type === "delay" && tr.scheduled_for) when = new Date(tr.scheduled_for).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const verb = act?.action === "liga" ? "Ligar" : act?.action === "desliga" ? "Desligar" : "—";
    return `${idx + 1}. ${status} ${a.name}\n    ${verb} • ${when}`;
  }).join("\n\n");
  await sendWhatsAppText(from, `📋 *Automações* (${data.length}):\n\n${lines}\n\n_Para excluir: "excluir automação <nome ou nº>"_`, farmId);
  return true;
}

async function historyAutomacoes(farmId: string, from: string): Promise<boolean> {
  const { data } = await supabase
    .from("automation_execution_history")
    .select("triggered_at, automation_name, all_success, actions_executed")
    .eq("farm_id", farmId)
    .order("triggered_at", { ascending: false })
    .limit(15);
  if (!data || data.length === 0) {
    await sendWhatsAppText(from, "📭 Sem histórico de execuções.", farmId);
    return true;
  }
  const lines = data.map((h: any) => {
    const when = new Date(h.triggered_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const icon = h.all_success ? "✅" : "⚠️";
    const count = Array.isArray(h.actions_executed) ? h.actions_executed.length : 0;
    return `${icon} ${when} — ${h.automation_name ?? "—"} (${count} ações)`;
  }).join("\n");
  await sendWhatsAppText(from, `📜 *Histórico de Automações:*\n\n${lines}`, farmId);
  return true;
}

async function resolveAutomacaoByRef(farmId: string, ref: string): Promise<any | null> {
  const { data } = await supabase
    .from("automations")
    .select("id, name, is_active")
    .eq("farm_id", farmId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (!data) return null;
  // Try numeric index
  const n = parseInt(ref, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= data.length) return data[n - 1];
  const norm = stripAccents(ref.toLowerCase()).trim();
  const exact = data.find((a: any) => stripAccents(a.name.toLowerCase()).trim() === norm);
  if (exact) return exact;
  return data.find((a: any) => stripAccents(a.name.toLowerCase()).includes(norm)) ?? null;
}

async function deleteAutomacaoByRef(farmId: string, ref: string, op: any, from: string): Promise<boolean> {
  const a = await resolveAutomacaoByRef(farmId, ref);
  if (!a) {
    await sendWhatsAppText(from, `❌ Automação "${ref}" não encontrada.`, farmId);
    return true;
  }
  await supabase.from("automations").delete().eq("id", a.id);
  await supabase.from("automation_audit_log").insert({
    automation_id: a.id, farm_id: farmId,
    event_type: "deleted", performed_via: "whatsapp",
    performed_by_name: op.name ?? null, performed_by_phone: op.phone ?? null,
    notes: `Excluída via WhatsApp: ${a.name}`,
  });
  await sendWhatsAppText(from, `🗑️ Automação "${a.name}" excluída.`, farmId);
  return true;
}

async function toggleAutomacao(farmId: string, ref: string, activate: boolean, op: any, from: string): Promise<boolean> {
  const a = await resolveAutomacaoByRef(farmId, ref);
  if (!a) {
    await sendWhatsAppText(from, `❌ Automação "${ref}" não encontrada.`, farmId);
    return true;
  }
  await supabase.from("automations").update({ is_active: activate }).eq("id", a.id);
  await supabase.from("automation_audit_log").insert({
    automation_id: a.id, farm_id: farmId,
    event_type: activate ? "activated" : "deactivated", performed_via: "whatsapp",
    performed_by_name: op.name ?? null, performed_by_phone: op.phone ?? null,
  });
  await sendWhatsAppText(from, `${activate ? "🟢" : "⚪"} Automação "${a.name}" ${activate ? "ativada" : "desativada"}.`, farmId);
  return true;
}

// ── Creation parser ──────────────────────────────────────────────
async function createAutomacaoFromText(
  rawText: string,
  tNorm: string,
  farmId: string,
  op: any,
  _phone: string,
  from: string,
  opts: { isAgendar: boolean },
): Promise<boolean> {
  // Strip prefix
  let body = tNorm
    .replace(/^(automacao|automacoes|automação|automações)\s+/, "")
    .replace(/^criar\s+automacao\s+/, "")
    .replace(/^agendar\s+/, "")
    .trim();

  // Detect action verb
  let action: "liga" | "desliga" | null = null;
  if (/\b(desligar|desliga|parar)\b/.test(body)) action = "desliga";
  else if (/\b(ligar|liga|acionar|iniciar)\b/.test(body)) action = "liga";
  if (!action) {
    await sendWhatsAppText(from, "❓ Diga o que fazer: 'ligar' ou 'desligar'.\nEx: _automação desligar poço 1 17:30 seg-sex_", farmId);
    return true;
  }

  // Condition: "antes da ponta"
  const condMatch = body.match(/(\d+)\s*min(?:utos)?\s+antes\s+da\s+ponta/) || (body.includes("antes da ponta") ? ["5 minutos antes da ponta", "5"] as any : null);
  let triggerKind: "time" | "condition" | "delay" = "time";
  let timeValue: string | null = null;
  let days: string[] | null = null;
  let scheduledFor: string | null = null;
  let conditionType: string | null = null;
  let conditionValue: string | null = null;

  if (condMatch) {
    triggerKind = "condition";
    conditionType = "peak_hours_start";
    conditionValue = condMatch[1] ?? "5";
  } else {
    // delay: "daqui X horas/minutos"
    const dMatch = body.match(/daqui\s+(\d+)\s*(h|hora|horas|min|minutos|m)\b/);
    if (dMatch) {
      triggerKind = "delay";
      const n = parseInt(dMatch[1], 10);
      const unit = dMatch[2];
      const mins = /^h|hora/.test(unit) ? n * 60 : n;
      scheduledFor = new Date(Date.now() + mins * 60_000).toISOString();
    } else {
      // amanhã HH:MM
      const aMatch = body.match(/amanha[\s,]+(\d{1,2}[:h]\d{2}|\d{1,2})\b/);
      if (aMatch) {
        triggerKind = "delay";
        const hhmm = parseHHMM(aMatch[1]);
        if (!hhmm) {
          await sendWhatsAppText(from, "❓ Horário inválido. Use HH:MM (ex: 06:00).", farmId);
          return true;
        }
        const d = new Date();
        d.setDate(d.getDate() + 1);
        const [hh, mm] = hhmm.split(":").map(Number);
        d.setHours(hh, mm, 0, 0);
        scheduledFor = d.toISOString();
      } else {
        // Plain time: 17:30 or 1730
        const tMatch = body.match(/\b(\d{1,2}[:h]\d{2})\b/);
        if (tMatch) {
          timeValue = parseHHMM(tMatch[1]);
        }
        if (!timeValue) {
          await sendWhatsAppText(from, "❓ Faltou horário. Ex: _automação desligar todas 17:30 seg-sex_", farmId);
          return true;
        }
        // Days
        const tokens = body.split(/\s+/);
        const ds = parseDaySpec(tokens, 0);
        days = ds?.days ?? ["seg", "ter", "qua", "qui", "sex", "sab", "dom"];
      }
    }
  }

  // Equipment resolution
  const allWords = /\b(tudo|todas|todos|todas as bombas|todos os pocos|todos os poços)\b/.test(body);
  let equipmentIds: string[] = [];
  let equipNamesPreview = "todos os equipamentos";

  if (!allWords) {
    // Find base + numbers
    const baseMatch = body.match(/\b(poco|poços|poco|pocos|bomba|bombas)\b/);
    if (baseMatch) {
      const base = baseMatch[1];
      const rest = body.slice((baseMatch.index ?? 0) + base.length).trim();
      const { nums } = parseBulkTargets(rest);
      const variants = ["poco", "poço", "bomba"].includes(base.slice(0, 4)) ? ["poço", "bomba"] : [base];
      const seen = new Set<string>();
      const pool: any[] = [];
      for (const v of variants) {
        const { data } = await supabase
          .from("equipments")
          .select("id, name")
          .eq("farm_id", farmId)
          .ilike("name", `%${v}%`)
          .limit(200);
        for (const r of (data ?? []) as any[]) {
          if (!seen.has(r.id)) { seen.add(r.id); pool.push(r); }
        }
      }
      const matches: any[] = nums.length
        ? nums.map((n) => pool.find((e) => extractNumbers(e.name).includes(n))).filter(Boolean) as any[]
        : pool;
      if (matches.length === 0) {
        await sendWhatsAppText(from, "❌ Nenhum equipamento encontrado. Verifique o nome/número.", farmId);
        return true;
      }
      equipmentIds = matches.map((e) => e.id);
      equipNamesPreview = matches.map((e) => e.name).join(", ");
    } else {
      await sendWhatsAppText(from, "❓ Especifique 'todos' ou 'poço/bomba <nº>'.", farmId);
      return true;
    }
  }

  // Auto-generate name
  const verbo = action === "liga" ? "Ligar" : "Desligar";
  const alvo = allWords ? "tudo" : equipNamesPreview;
  let whenLabel = "";
  if (triggerKind === "time") whenLabel = `${timeValue} ${(days ?? []).slice(0,3).join("/")}`;
  else if (triggerKind === "condition") whenLabel = `${conditionValue}min antes da ponta`;
  else if (triggerKind === "delay") whenLabel = new Date(scheduledFor!).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const autoName = `${verbo} ${alvo} ${whenLabel}`.slice(0, 100);

  // Persist
  const { data: created, error } = await supabase
    .from("automations")
    .insert({
      farm_id: farmId,
      name: autoName,
      type: triggerKind === "delay" ? "one_time" : (triggerKind === "condition" ? "rule_based" : "scheduled"),
      is_active: true,
      created_by: op.name ?? null,
      created_via: "whatsapp",
    })
    .select()
    .single();
  if (error || !created) {
    await sendWhatsAppText(from, `❌ Erro ao criar automação: ${error?.message ?? "desconhecido"}`, farmId);
    return true;
  }

  await supabase.from("automation_actions").insert({
    automation_id: created.id,
    equipment_ids: equipmentIds,
    action,
    order: 0,
  });

  const triggerRow: any = {
    automation_id: created.id,
    trigger_type: triggerKind,
    execute_once: triggerKind === "delay",
  };
  if (triggerKind === "time") {
    triggerRow.time_value = timeValue;
    triggerRow.days = days;
  } else if (triggerKind === "condition") {
    triggerRow.condition_type = conditionType;
    triggerRow.condition_value = conditionValue;
  } else if (triggerKind === "delay") {
    triggerRow.scheduled_for = scheduledFor;
  }
  await supabase.from("automation_triggers").insert(triggerRow);

  await supabase.from("automation_audit_log").insert({
    automation_id: created.id, farm_id: farmId,
    event_type: "created", performed_via: "whatsapp",
    performed_by_name: op.name ?? null, performed_by_phone: op.phone ?? null,
    action, equipment_ids: equipmentIds,
    trigger_type: triggerKind,
    scheduled_time: timeValue ?? (scheduledFor ?? null),
    notes: `Criada via WhatsApp: ${autoName}`,
  });

  await sendWhatsAppText(from, `✅ Automação criada:\n\n📝 ${autoName}\n🎯 ${alvo}\n⏰ ${whenLabel}\n\n_Para listar: "automações"_`, farmId);
  return true;
}

// ───────── Audio transcription (WhatsApp voice notes → text) ─────────
// WhatsApp envia áudio em OGG/Opus. Usamos Lovable AI Gateway (Gemini Flash)
// via chat completions multimodal — aceita OGG nativamente, sem transcodificar.
async function transcribeWhatsAppAudio(mediaId: string, farmId?: string): Promise<string | null> {
  try {
    const { api_token } = await getWaCreds(farmId);
    if (!api_token) {
      console.warn("transcribeWhatsAppAudio: sem api_token Meta");
      return null;
    }
    // 1) Buscar URL temporária do áudio
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${api_token}` },
    });
    if (!metaRes.ok) {
      console.error("transcribeWhatsAppAudio: meta lookup falhou", metaRes.status, await metaRes.text().catch(() => ""));
      return null;
    }
    const metaJson = await metaRes.json();
    const audioUrl: string | undefined = metaJson?.url;
    const mimeType: string = metaJson?.mime_type ?? "audio/ogg";
    if (!audioUrl) return null;
    console.log(`[AUDIO] Media URL fetched | mime=${mimeType}`);

    // 2) Baixar bytes do áudio
    const audioRes = await fetch(audioUrl, {
      headers: { Authorization: `Bearer ${api_token}` },
    });
    if (!audioRes.ok) {
      console.error("transcribeWhatsAppAudio: download falhou", audioRes.status);
      return null;
    }
    const audioBuf = new Uint8Array(await audioRes.arrayBuffer());
    console.log(`[AUDIO] Audio downloaded, ${audioBuf.length} bytes | mime=${mimeType}`);
    if (audioBuf.length < 100) { console.warn("[AUDIO] buffer muito pequeno"); return null; }

    // 3) Base64 (em chunks para não estourar stack)
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < audioBuf.length; i += chunk) {
      bin += String.fromCharCode(...audioBuf.subarray(i, i + chunk));
    }
    const b64 = btoa(bin);

    // 4) Detectar formato p/ Gemini (aceita: wav, mp3, webm, m4a, ogg, aac, flac)
    let fmt = "ogg";
    const mt = mimeType.toLowerCase();
    if (mt.includes("mpeg") || mt.includes("mp3")) fmt = "mp3";
    else if (mt.includes("wav")) fmt = "wav";
    else if (mt.includes("mp4") || mt.includes("m4a")) fmt = "m4a";
    else if (mt.includes("webm")) fmt = "webm";
    else if (mt.includes("aac")) fmt = "aac";
    else if (mt.includes("flac")) fmt = "flac";

    // 5) Transcrever via Google Gemini direto (API key gratuita)
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) {
      console.error("transcribeWhatsAppAudio: GEMINI_API_KEY ausente");
      return null;
    }
    // Normaliza mime para o que o Gemini aceita (audio/ogg, audio/mp3, audio/mpeg, audio/wav, audio/aac, audio/flac)
    let geminiMime = "audio/ogg";
    if (fmt === "mp3") geminiMime = "audio/mp3";
    else if (fmt === "wav") geminiMime = "audio/wav";
    else if (fmt === "m4a") geminiMime = "audio/mp4";
    else if (fmt === "webm") geminiMime = "audio/webm";
    else if (fmt === "aac") geminiMime = "audio/aac";
    else if (fmt === "flac") geminiMime = "audio/flac";

    const ctrl = new AbortController();
    const tout = setTimeout(() => ctrl.abort(), 45_000);
    let aiRes: Response;
    try {
      console.log(`[AUDIO] Calling Gemini direct API for transcription | mime=${geminiMime}`);
      aiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { text: "Transcreva este áudio em português. Retorne apenas o texto falado, sem explicações." },
                  { inlineData: { mimeType: geminiMime, data: b64 } },
                ],
              },
            ],
            generationConfig: { temperature: 0, maxOutputTokens: 1024 },
          }),
        },
      );
    } finally {
      clearTimeout(tout);
    }
    if (!aiRes.ok) {
      console.error("transcribeWhatsAppAudio: gemini falhou", aiRes.status, await aiRes.text().catch(() => ""));
      return null;
    }
    const aiJson = await aiRes.json();
    const txt: string = (aiJson?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p?.text ?? "")
      .join("")
      .trim();
    if (!txt || txt === "[INAUDÍVEL]") return null;
    console.log(`[AUDIO] Transcription received | chars=${txt.length}`);
    return txt;
  } catch (e) {
    console.error("transcribeWhatsAppAudio err", e);
    return null;
  }
}

Deno.serve(async (req) => {
  console.log(`[WEBHOOK HIT] ${new Date().toISOString()} method=${req.method} url=${req.url}`);
  try {



  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);

  if (req.method === "GET") {
    return handleVerification(url);
  }

  if (req.method === "POST") {
    // Verificação HMAC do X-Hub-Signature-256 (Meta App Secret).
    // Se WHATSAPP_APP_SECRET estiver configurado, rejeita payloads sem
    // assinatura válida. Sem o secret, apenas loga warning (fase de rollout).
    const appSecret = Deno.env.get("WHATSAPP_APP_SECRET") ?? "";
    const rawBody = await req.text();
    if (appSecret) {
      const sigHeader = req.headers.get("x-hub-signature-256") ?? "";
      const provided = sigHeader.startsWith("sha256=") ? sigHeader.slice(7) : "";
      let expected = "";
      try {
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(appSecret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
        expected = Array.from(new Uint8Array(sig))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      } catch (e) {
        console.error("[WEBHOOK] HMAC compute failed", e);
      }
      // constant-time compare
      const equal =
        provided.length === expected.length &&
        provided.length > 0 &&
        provided.split("").reduce((acc, c, i) => acc | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0;
      if (!equal) {
        console.warn("[WEBHOOK] invalid X-Hub-Signature-256 — rejected");
        return new Response(JSON.stringify({ error: "invalid_signature" }), {
          status: 401,
          headers: { ...corsHeaders, "content-type": "application/json" },
        });
      }
    } else {
      console.warn("[WEBHOOK] WHATSAPP_APP_SECRET not configured — accepting without HMAC check");
    }

    let payload: any = null;
    try {
      payload = JSON.parse(rawBody);
    } catch (_) {
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    try {
      const entries = payload?.entry ?? [];
      for (const entry of entries) {
        const changes = entry?.changes ?? [];
        for (const ch of changes) {
          // [DIAG-SEMEAR] Loga statuses (delivered/read/failed) da Meta para telefones da Semear.
          const statuses = ch?.value?.statuses ?? [];
          for (const st of statuses) {
            const recipient = String(st?.recipient_id ?? "");
            if (recipient === "557798654782" || recipient === "557788120550") {
              console.log("[DIAG-SEMEAR] META status", {
                recipient,
                status: st?.status,
                message_id: st?.id,
                timestamp: st?.timestamp,
                errors: st?.errors ?? null,
                conversation: st?.conversation ?? null,
                pricing: st?.pricing ?? null,
              });
            }
          }
          const messages = ch?.value?.messages ?? [];
          for (const msg of messages) {
            // Dedup por wamid — Meta reenvia o mesmo webhook em caso de timeout.
            if (isDuplicateMessageId(msg?.id)) {
              console.log(`[WEBHOOK] duplicate wamid ignored: ${msg?.id}`);
              continue;
            }
            const from = msg?.from ?? "";
            let text =
              msg?.text?.body ??
              msg?.button?.text ??
              msg?.interactive?.button_reply?.title ??
              "";
            const loc = msg?.location ?? null;
            const location = loc && typeof loc.latitude === "number" && typeof loc.longitude === "number"
              ? { lat: Number(loc.latitude), lng: Number(loc.longitude), name: loc.name ?? null, address: loc.address ?? null }
              : null;

            // ── Áudio: transcrever via Lovable AI e tratar como texto ──
            const isAudioMsg = msg?.type === "audio" || msg?.type === "voice";
            const audioMediaId: string | null = isAudioMsg
              ? (msg?.audio?.id ?? msg?.voice?.id ?? null)
              : null;
            const audioDuration: number | null = msg?.audio?.duration ?? msg?.voice?.duration ?? null;
            let transcribed = false;
            if (isAudioMsg) {
              console.log(`[AUDIO] Recebido de ${from} | mediaId=${audioMediaId} | duration=${audioDuration}`);
            }
            if (!text && audioMediaId) {
              // Descobrir farm + audio_enabled do remetente (fresco do DB, robusto)
              let farmHint: string | undefined;
              let audioEnabled = false;
              let opName = "";
              let audioOperator: any = null;
              let audioIsSuperAdmin = false;
              try {
                const tail8 = normalizePhone(from).slice(-8);
                const { data: ops, error: opLookupError } = await supabase
                  .from("whatsapp_operators")
                  .select("*")
                  .eq("is_active", true);
                if (opLookupError) {
                  console.error("[AUDIO] erro select operador", opLookupError);
                }
                const candidates = (ops ?? []).filter((o: any) => normalizePhone(o.phone ?? "").slice(-8) === tail8);
                audioOperator = candidates.find((o: any) => isSuperAdmin(o)) ?? candidates[0] ?? null;
                if (audioOperator) {
                  farmHint = (audioOperator as any).farm_id ?? undefined;
                  audioIsSuperAdmin = isSuperAdmin(audioOperator);
                  const perms = getEffectivePermissions(audioOperator);
                  // BYPASS ABSOLUTO: super_admin tem áudio liberado antes de qualquer outra checagem.
                  audioEnabled = audioIsSuperAdmin ? true : perms.audio_enabled === true;
                  opName = (audioOperator as any).name ?? "";
                  if (audioIsSuperAdmin) console.log(`[AUDIO] 👑 super_admin bypass no topo — transcrição liberada sem checar audio_enabled/ai_enabled`);
                  console.log("[AUDIO] Operator permissions:", {
                    phone: normalizePhone((audioOperator as any).phone ?? from),
                    role: (audioOperator as any).role,
                    audio_enabled_db: (audioOperator as any).audio_enabled,
                    ai_enabled_db: (audioOperator as any).ai_enabled,
                    can_control_db: (audioOperator as any).can_control,
                    can_schedule_db: (audioOperator as any).can_schedule,
                    effective_audio_enabled: perms.audio_enabled,
                    effective_ai_enabled: perms.ai_enabled,
                  });
                }
                console.log(`[AUDIO] Operador: ${opName || "(não encontrado)"} | audio_enabled=${audioEnabled} | farm=${farmHint}`);
              } catch (e) {
                console.error("[AUDIO] erro lookup operador", e);
              }

              if (!audioEnabled && !audioIsSuperAdmin) {
                try {
                  await sendWhatsAppText(
                    from,
                    "Seu acesso por áudio não está ativado no momento. Envie o que precisa por texto, ou peça ao administrador para ativar.",
                    farmHint ?? null,
                  );
                } catch (_) { /* ignore */ }
              } else if (!audioIsSuperAdmin && typeof audioDuration === "number" && audioDuration > 120) {
                try {
                  await sendWhatsAppText(from, "Áudio muito longo (máx 2 min). Pode mandar um mais curto ou digitar?", farmHint ?? null);
                } catch (_) { /* ignore */ }
              } else {
                try {
                  console.log(`[AUDIO] Audio enabled for ${from}, proceeding`);
                  console.log(`[AUDIO] Iniciando transcrição mediaId=${audioMediaId}`);
                  const tx = await transcribeWhatsAppAudio(audioMediaId, farmHint);
                  if (tx) {
                    text = tx;
                    transcribed = true;
                    console.log(`[AUDIO] ✅ Transcrito (${from}): "${tx}"`);
                    console.log(`[AUDIO] Processing transcribed text as command`);
                  } else {
                    console.warn(`[AUDIO] ❌ Transcrição vazia/falhou (${from})`);
                    await sendWhatsAppText(from, "🎙️ Não consegui transcrever o áudio agora. Envie o comando por texto: *status*, *níveis*, *ligar/desligar [equipamento]*, *ops* ou *ajuda*.", farmHint ?? null);
                  }
                } catch (e) {
                  console.error("[AUDIO] erro pipeline", e);
                  try {
                    await sendWhatsAppText(from, "🎙️ Falha na transcrição de áudio. Tente novamente em texto: *status*, *níveis*, *ligar [equip]*, *ops*, *ajuda*.", farmHint ?? null);
                  } catch (_) { /* ignore */ }
                }
              }
            }

            // WhatsApp Cloud API não suporta grupos — toda mensagem é 1:1.
            {
              // ── AUDIT: log every incoming message (legal evidence) ──
              if (from) {
                const msgType = msg?.type
                  ?? (location ? "location" : text ? "text" : "unknown");
                const tsRaw = msg?.timestamp ? Number(msg.timestamp) : null;
                const tsIso = tsRaw && Number.isFinite(tsRaw)
                  ? new Date(tsRaw * 1000).toISOString()
                  : null;
                let opName: string | null = null;
                let opId: string | null = null;
                let opFarm: string | null = null;
                try {
                  const last8 = from.slice(-8);
                  const { data: op } = await supabase
                    .from("whatsapp_operators")
                    .select("id, name, farm_id")
                    .ilike("phone", `%${last8}`)
                    .eq("is_active", true)
                    .maybeSingle();
                  if (op) {
                    opName = (op as any).name ?? null;
                    opId = (op as any).id ?? null;
                    opFarm = (op as any).farm_id ?? null;
                  }
                  // Track last_message_at for 24h window template gating
                  try {
                    await supabase
                      .from("whatsapp_operators")
                      .update({ last_message_at: new Date().toISOString() })
                      .ilike("phone", `%${last8}`);
                  } catch (_) { /* ignore */ }
                } catch (_) { /* ignore */ }

                await logMessage({
                  direction: "incoming",
                  phone: from,
                  operator_name: opName,
                  operator_id: opId,
                  farm_id: opFarm,
                  message_type: transcribed ? "audio" : msgType,
                  message_body: text || (location ? `[location ${location.lat},${location.lng}]` : null),
                  message_id: msg?.id ?? null,
                  timestamp_meta: tsIso,
                  metadata: { msg, contacts: ch?.value?.contacts ?? null, transcribed: transcribed || undefined },
                  group_id: null,
                  original_type: transcribed ? "audio" : "text",
                  audio_duration_seconds: transcribed ? (audioDuration ?? null) : null,
                });
              }

              if (from && (text || location)) {
                console.log(`WEBHOOK RECEIVED - from: ${from} - body: ${text || "[location]"}`);

                // ── Rate limiting ──
                const rl = checkRateLimit(from, text ?? "");
                if (!rl.allowed) {
                  console.warn(`[rate-limit] blocked from=${normalizePhone(from)} reason=${rl.reason}`);
                  if (rl.reason === "hour" && rl.sendWarning) {
                    try {
                      await sendWhatsAppText(
                        from,
                        "⚠️ Limite de mensagens atingido. Tente novamente em alguns minutos.",
                        null,
                      );
                    } catch (_e) { /* ignore */ }
                  } else if (rl.reason === "day" && rl.notifySuperAdmin) {
                    const alert = `🚨 *Rate limit diário atingido*\nNúmero: ${normalizePhone(from)}\nLimite: ${RL_DAY_LIMIT} msg/dia\nHorário: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Bahia" })}`;
                    try {
                      const { data: supers } = await supabase
                        .from("whatsapp_operators")
                        .select("phone")
                        .eq("role", "super_admin")
                        .eq("is_active", true);
                      for (const s of ((supers ?? []) as any[])) {
                        const to = normalizePhone(s?.phone ?? "");
                        if (to) await sendWhatsAppDirect(to, alert, null);
                      }
                    } catch (e) {
                      console.error("[rate-limit] super_admin notify fail", (e as Error).message);
                    }
                  }
                  // Não processa a mensagem
                } else {
                  const responseMarker = recentOutgoingAttempt.get(normalizePhone(from)) ?? 0;
                  const successMarker = recentOutgoingSuccess.get(normalizePhone(from)) ?? 0;
                  try {
                    await processMessage(from, text, location);
                  } catch (e) {
                    console.error("WA processMessage err", e);
                  }
                  const responseAfter = recentOutgoingAttempt.get(normalizePhone(from)) ?? 0;
                  const successAfter = recentOutgoingSuccess.get(normalizePhone(from)) ?? 0;
                  if (responseAfter <= responseMarker || successAfter <= successMarker) {
                    console.warn("[WEBHOOK SAFETY] No successful response detected; sending fallback", {
                      from: normalizePhone(from),
                      attempted: responseAfter > responseMarker,
                      succeeded: successAfter > successMarker,
                    });
                    await sendWhatsAppText(from, "Estou processando sua solicitação. Um momento...", null);
                  }
                }
              }
            }
          }


        }
      }
    } catch (e) {
      console.error("WA webhook parse err", e);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response("method not allowed", {
    status: 405,
    headers: corsHeaders,
  });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("[WEBHOOK FATAL ERROR]", err.message, err.stack);
    // Always return 200 to Meta so it does not retry and flood the webhook.
    return new Response(JSON.stringify({ status: "error", message: err.message }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
