// Store reativo do log de automação — fonte única para o Relatório principal
// e o Mini-Relatório do popover de cada bomba no Dashboard.
//
// Mensagem 2 (atual): cruzamento por `equipment_id` (UUID). O `equipment_name`
// é mantido para legibilidade no relatório, mas a chave canônica para histórico
// no Dashboard é o UUID. Logs antigos (sem equipment_id) caem no fallback por
// nome.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { PumpCommandLog, PumpStatusLog } from "@/components/dashboard/PumpTable";
import { supabase } from "@/integrations/supabase/client";
import type {
  Database,
} from "@/integrations/supabase/types";

export type AutomationOrigin = "Automático" | "Remoto" | "Manual" | "Sistema" | "WhatsApp";

export type AutomationAction =
  | "Ligada"
  | "Desligada"
  | "Sem resposta"
  | "Equipamento religado"
  | "Reinício do agente"
  | "Atualização OTA"
  | "Leitura OK";

export interface AutomationLogEntry {
  /** UUID local — usado como `client_event_id` para idempotência ao sincronizar com a nuvem */
  id: string;
  /** UUID da fazenda (tag de isolamento). Entradas legadas podem não ter. */
  farmId?: string;
  /** dd/MM/yyyy */
  date: string;
  /** HH:mm */
  time: string;
  /** ISO timestamp para ordenação confiável */
  ts: string;
  /** UUID do equipamento (preferencial). Logs antigos podem não ter. */
  equipmentId?: string;
  /** Nome amigável — usado no relatório principal e como fallback de cruzamento */
  pump: string;
  /** Tipo do evento — ações de bomba (Ligada/Desligada), comunicação (Sem
   *  resposta / Equipamento religado), ciclo de vida do agente (Reinício /
   *  Atualização OTA) e leituras de status (Leitura OK, ruidosa, oculta por padrão). */
  action: AutomationAction;
  origin: AutomationOrigin;
  user: string;
  /** Resultado do comando. Comandos "Manual" (acionamento físico no equipamento)
   *  nunca falham. Por padrão, sucesso. */
  result?: "success" | "fail";
  /** true = já confirmado pela nuvem (insert OK ou veio via Realtime). */
  synced?: boolean;
}

interface LogState {
  entries: AutomationLogEntry[];
  /** Fazenda atualmente ativa — usado para isolar dados ao mudar de fazenda. */
  activeFarmId: string | null;
  add: (entry: Omit<AutomationLogEntry, "id" | "date" | "time" | "ts">) => void;
  /** Insere/mescla um evento já formatado (usado pelo Realtime). Idempotente por id. */
  upsertRemote: (entry: AutomationLogEntry) => void;
  markSynced: (id: string) => void;
  /** Define a fazenda ativa e remove entradas de outras fazendas (isolamento de dados). */
  setActiveFarm: (farmId: string) => void;
  clear: () => void;
}

const uuid = () =>
  (crypto as Crypto & { randomUUID?: () => string }).randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const formatDate = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

const formatTime = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export const useAutomationLog = create<LogState>()(
  persist(
    (set, get) => ({
      entries: [],
      activeFarmId: null,
      add: (entry) => {
        const d = new Date();
        const farmId = entry.farmId ?? get().activeFarmId ?? cachedFarmId ?? undefined;
        const newEntry: AutomationLogEntry = {
          id: uuid(),
          date: formatDate(d),
          time: formatTime(d),
          ts: d.toISOString(),
          synced: false,
          ...entry,
          farmId,
        };
        set((s) => ({ entries: [newEntry, ...s.entries].slice(0, 20000) }));
        void pushEntryToCloud(newEntry);
      },
      upsertRemote: (entry) => {
        set((s) => {
          // Isolamento: ignora eventos de outras fazendas que cheguem por algum
          // canal residual (defesa em profundidade — Realtime já filtra por farm).
          if (s.activeFarmId && entry.farmId && entry.farmId !== s.activeFarmId) return s;
          if (s.entries.some((e) => e.id === entry.id)) return s;
          const merged = [entry, ...s.entries].sort((a, b) =>
            b.ts.localeCompare(a.ts),
          );
          return { entries: merged.slice(0, 20000) };
        });
      },
      markSynced: (id) => {
        set((s) => ({
          entries: s.entries.map((e) =>
            e.id === id ? { ...e, synced: true } : e,
          ),
        }));
      },
      setActiveFarm: (farmId) => {
        set((s) => {
          if (s.activeFarmId === farmId) {
            // mesma fazenda — apenas garante que entradas órfãs (sem farmId ou
            // de outra fazenda) sejam descartadas
            return {
              activeFarmId: farmId,
              entries: s.entries.filter((e) => !e.farmId || e.farmId === farmId),
            };
          }
          // troca de fazenda — descarta tudo que não pertence à nova
          return {
            activeFarmId: farmId,
            entries: s.entries.filter((e) => e.farmId === farmId),
          };
        });
      },
      clear: () => set({ entries: [] }),
    }),
    {
      name: "automation_log_v2",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/**
 * Helper imperativo para registrar um evento de qualquer lugar do app.
 * Sempre passe `equipmentId` (UUID) quando disponível — é a chave canônica.
 */
export function logEvent(entry: Omit<AutomationLogEntry, "id" | "date" | "time" | "ts">) {
  useAutomationLog.getState().add(entry);
}

/** "Manual" no relatório = acionamento físico (Local) no equipamento. */
export const isLocalOrigin = (origin: AutomationOrigin) => origin === "Manual";

/** Formata data+hora curta para o mini-relatório: "DD/MM HH:mm" */
const shortTime = (e: AutomationLogEntry) => {
  const [dd, mm] = e.date.split("/");
  return `${dd}/${mm} ${e.time}`;
};

/** Filtra entradas por equipamento. Cruza por equipmentId quando presente,
 *  cai no nome para entradas antigas. */
const matchEquipment = (e: AutomationLogEntry, equipmentId: string, pumpName: string) =>
  e.equipmentId ? e.equipmentId === equipmentId : e.pump === pumpName;

/** Só comandos reais entram no mini-relatório do card. Leitura OK / Sem
 *  resposta / eventos de sistema (OTA, reinício) são ruído e ficam de fora. */
const isCommandAction = (a: AutomationAction) => a === "Ligada" || a === "Desligada";

export function buildCommandHistory(
  equipmentId: string,
  pumpName: string,
  entries: AutomationLogEntry[],
  limit = 3,
): PumpCommandLog[] {
  return entries
    .filter((e) => isCommandAction(e.action) && matchEquipment(e, equipmentId, pumpName))
    .slice(0, limit)
    .map((e) => {
      const isLocal = isLocalOrigin(e.origin);
      const verb = e.action === "Ligada" ? "Ligar" : "Desligar";
      const sourceLabel = isLocal ? "local" : "remoto";
      const result: "success" | "fail" = isLocal ? "success" : (e.result ?? "success");
      return {
        action: `${verb} ${sourceLabel}`,
        time: shortTime(e),
        result,
      };
    });
}

export function buildStatusHistory(
  equipmentId: string,
  pumpName: string,
  entries: AutomationLogEntry[],
  limit = 3,
): PumpStatusLog[] {
  return entries
    .filter(
      (e) =>
        isCommandAction(e.action) &&
        matchEquipment(e, equipmentId, pumpName) &&
        (e.result ?? "success") === "success",
    )
    .slice(0, limit)
    .map((e) => ({
      status: e.action === "Ligada" ? "Ligado" : "Desligado",
      source: isLocalOrigin(e.origin) ? "local" : "remoto",
      time: shortTime(e),
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sincronização com o backend
// ─────────────────────────────────────────────────────────────────────────────

type DbRow = Database["public"]["Tables"]["automation_log"]["Row"];
type DbInsert = Database["public"]["Tables"]["automation_log"]["Insert"];
type DbAction = Database["public"]["Enums"]["event_action"];
type DbOrigin = Database["public"]["Enums"]["event_origin"];

let cachedFarmId: string | null = null;
let cachedUserId: string | null = null;
let cachedUserEmail: string | null = null;
let cachedUserName: string | null = null;
let realtimeStarted = false;
let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;

const originToDb = (o: AutomationOrigin): DbOrigin =>
  o === "Manual" ? "local"
  : o === "Automático" ? "auto"
  : o === "Sistema" ? "system"
  : "remote";

const originFromDb = (o: DbOrigin): AutomationOrigin =>
  o === "local" ? "Manual"
  : o === "auto" ? "Automático"
  : o === "system" ? "Sistema"
  : "Remoto";
  // 'remote' e 'reading' caem como "Remoto"

const actionToDb = (a: AutomationAction): DbAction =>
  a === "Ligada" ? "turn_on" : "turn_off";

const getActorLabel = (r: DbRow): string | null => {
  const actorLabel = (r as DbRow & { actor_label?: string | null }).actor_label;
  return actorLabel && actorLabel.trim() ? actorLabel.trim() : null;
};

/**
 * Resolve o autor exibido no relatório.
 * - actor_label do banco (já calculado pelo trigger) tem prioridade
 * - Usuário identificado → nome do perfil / email
 * - origin=auto / source cloud-automation → "Automação"
 * - origin=local sem usuário → "Local (painel)" (acionamento físico anônimo)
 * - Sem nada acima → "Sistema" (será filtrado no relatório)
 */
const resolveUser = (r: DbRow): string => {
  const actorLabel = getActorLabel(r);
  if (actorLabel) return actorLabel;

  const explicitName = (r.details as { user_name?: string } | null)?.user_name;
  if (explicitName) return explicitName;
  if (r.user_email) return r.user_email;
  if (r.user_id) return "Usuário";

  const src = r.source_device ?? "";
  if (src === "cloud-automation" || src === "cloud-protective-off" || r.origin === "auto") {
    return "Automação";
  }
  if (src === "agent-restart" || src === "ota-update") return "Agente";
  if (r.origin === "local") return "Local (painel)";
  return "Sistema";
};

/** Classifica a linha do banco em uma das ações apresentadas no Relatório.
 *  Cobre: comandos (Ligada/Desligada), comunicação (Sem resposta /
 *  Equipamento religado), ciclo de vida do agente (Reinício do agente /
 *  Atualização OTA) e leituras de status periódicas (Leitura OK — oculta por
 *  padrão por ser ruidosa). */
const classifyAction = (r: DbRow): { action: AutomationAction; origin: AutomationOrigin } => {
  const src = (r.source_device ?? "").toLowerCase();
  const details = (r.details ?? {}) as { tipo_evento?: string; kind?: string };
  const tipo = details.tipo_evento ?? details.kind ?? "";

  // Ciclo de vida do agente
  if (src === "agent-restart" || tipo === "agent_restart") {
    return { action: "Reinício do agente", origin: "Sistema" };
  }
  if (src === "ota-update" || tipo === "ota_update_start" || tipo === "ota_update") {
    return { action: "Atualização OTA", origin: "Sistema" };
  }

  // Eventos de comunicação (logCommEventToAutomationLog no agente)
  if (tipo === "equipamento_offline") {
    return { action: "Sem resposta", origin: "Sistema" };
  }
  if (tipo === "equipamento_online") {
    return { action: "Equipamento religado", origin: "Sistema" };
  }

  // Leituras periódicas
  if (r.action === "status_read") {
    if (r.result === "timeout" || r.result === "fail") {
      return { action: "Sem resposta", origin: "Sistema" };
    }
    return { action: "Leitura OK", origin: "Sistema" };
  }

  // Comandos reais de bomba
  const isOff = r.action === "turn_off" || r.action === "pump_off";
  // Origem WhatsApp: detectada via source_device ou details.tipo_evento
  if (src.startsWith("whatsapp") || tipo === "whatsapp") {
    return { action: isOff ? "Desligada" : "Ligada", origin: "WhatsApp" };
  }
  return { action: isOff ? "Desligada" : "Ligada", origin: originFromDb(r.origin) };
};

const rowToEntry = (r: DbRow): AutomationLogEntry => {
  const d = new Date(r.occurred_at);
  const { action, origin } = classifyAction(r);
  return {
    id: r.client_event_id,
    farmId: r.farm_id,
    date: formatDate(d),
    time: formatTime(d),
    ts: d.toISOString(),
    equipmentId: r.equipment_id ?? undefined,
    pump: r.equipment_name,
    action,
    origin,
    user: resolveUser(r),
    result: (r.result === "fail" || r.result === "timeout" ? "fail" : "success"),
    synced: true,
  };
};

async function ensureContext(): Promise<{ farmId: string; userId: string; email: string | null; name: string | null } | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const u = sessionData.session?.user;
  if (!u) return null;

  // Respeita impersonate/demo (platform admin operando como outra fazenda).
  const impersonate = typeof sessionStorage !== "undefined"
    ? (sessionStorage.getItem("impersonate_farm_id") ?? sessionStorage.getItem("demo_farm_id"))
    : null;

  if (cachedFarmId && cachedUserId === u.id && (!impersonate || impersonate === cachedFarmId)) {
    return { farmId: cachedFarmId, userId: cachedUserId, email: cachedUserEmail, name: cachedUserName };
  }

  cachedUserId = u.id;
  cachedUserEmail = u.email ?? null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("default_farm_id, full_name")
    .eq("id", u.id)
    .maybeSingle();
  const fid = impersonate ?? profile?.default_farm_id ?? null;
  if (!fid) return null;
  cachedFarmId = fid;
  cachedUserName = profile?.full_name ?? null;
  return { farmId: cachedFarmId, userId: cachedUserId, email: cachedUserEmail, name: cachedUserName };
}

async function pushEntryToCloud(entry: AutomationLogEntry): Promise<void> {
  try {
    const ctx = await ensureContext();
    if (!ctx) return;
    const dbOrigin = originToDb(entry.origin);
    const isRemote = dbOrigin === "remote";
    const payload: DbInsert = {
      client_event_id: entry.id,
      farm_id: ctx.farmId,
      user_id: isRemote ? ctx.userId : null,
      user_email: isRemote ? ctx.email : null,
      equipment_id: entry.equipmentId ?? null,
      equipment_name: entry.pump,
      action: actionToDb(entry.action),
      origin: dbOrigin,
      result: entry.result === "fail" ? "fail" : "success",
      occurred_at: entry.ts,
      source_device: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 80) : null,
      details: isRemote && ctx.name ? { user_name: ctx.name } : null,
    };
    const { error } = await supabase
      .from("automation_log")
      .upsert(payload, { onConflict: "farm_id,client_event_id", ignoreDuplicates: true });
    if (!error) {
      useAutomationLog.getState().markSynced(entry.id);
    }
  } catch {
    // silencioso
  }
}

async function flushPending(): Promise<void> {
  const pending = useAutomationLog
    .getState()
    .entries.filter((e) => !e.synced)
    .slice(0, 100);
  for (const e of pending) {
    await pushEntryToCloud(e);
  }
}

function scheduleFlush() {
  if (pendingFlushTimer) clearTimeout(pendingFlushTimer);
  pendingFlushTimer = setTimeout(() => {
    void flushPending();
  }, 1500);
}

export async function startAutomationLogSync(): Promise<void> {
  const ctx = await ensureContext();
  if (!ctx) return;

  // Isolamento de fazenda: ao (re)iniciar a sincronização, marca a fazenda
  // ativa e remove do store local quaisquer entradas de outras fazendas
  // (ex.: troca de conta, impersonate, login num PC compartilhado).
  useAutomationLog.getState().setActiveFarm(ctx.farmId);

  if (realtimeStarted) return;
  realtimeStarted = true;

  // Carrega só COMANDOS reais (turn_on/turn_off) recentes. O log é dominado
  // por status_read (leituras periódicas de todos os equipamentos) — sem esse
  // filtro, 500 rows podem cobrir só as últimas horas da fazenda inteira e
  // equipamentos menos ativos ficam sem histórico no mini-relatório.
  // Comandos reais são ~2 ordens de grandeza mais raros, então 500 cobre
  // meses de operação por equipamento.
  const { data: rows } = await supabase
    .from("automation_log")
    .select("*")
    .eq("farm_id", ctx.farmId)
    .in("action", ["turn_on", "turn_off", "pump_on", "pump_off"])
    .order("occurred_at", { ascending: false })
    .limit(500);


  if (rows) {
    const upsert = useAutomationLog.getState().upsertRemote;
    for (const r of rows) upsert(rowToEntry(r));
  }

  try {
    supabase
      .channel(`automation_log:${ctx.farmId}:${Math.random().toString(36).slice(2, 8)}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "automation_log",
          filter: `farm_id=eq.${ctx.farmId}`,
        },
        (payload) => {
          const row = payload.new as DbRow;
          useAutomationLog.getState().upsertRemote(rowToEntry(row));
        },
      )
      .subscribe();
  } catch (e) {
    console.warn("[automationLog] realtime subscribe falhou:", e);
    realtimeStarted = false;
  }

  scheduleFlush();
}

/**
 * Carrega eventos do banco dentro de um intervalo arbitrário (sem cap de mês).
 * Usado pelo Relatório de Automação para histórico completo conforme o período
 * selecionado pelo usuário. Pode ser chamado várias vezes — entradas duplicadas
 * são ignoradas pelo upsertRemote (idempotência por id/client_event_id).
 */
export async function loadAutomationLogRange(
  farmId: string,
  fromIso: string,
  toIso: string,
): Promise<void> {
  if (!farmId || !fromIso || !toIso) return;
  try {
    const PAGE = 1000;
    const MAX_PAGES = 20; // até 20.000 eventos por intervalo (suficiente p/ meses)
    const upsert = useAutomationLog.getState().upsertRemote;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data: rows, error } = await supabase
        .from("automation_log")
        .select("*")
        .eq("farm_id", farmId)
        .gte("occurred_at", fromIso)
        .lte("occurred_at", toIso)
        .order("occurred_at", { ascending: false })
        .range(page * PAGE, (page + 1) * PAGE - 1);
      if (error || !rows || rows.length === 0) break;
      for (const r of rows) upsert(rowToEntry(r));
      if (rows.length < PAGE) break;
    }
  } catch (e) {
    console.warn("[automationLog] loadAutomationLogRange falhou:", e);
  }
}

export function resetAutomationLogSync() {
  cachedFarmId = null;
  cachedUserId = null;
  cachedUserEmail = null;
  cachedUserName = null;
  realtimeStarted = false;
  // Limpa entradas locais para evitar vazamento entre contas/fazendas no logout.
  useAutomationLog.getState().clear();
}
