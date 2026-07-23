// ─────────────────────────────────────────────────────────────────────────────
// Fila de escrita offline para Cadastros (PLCs / Setores / Equipamentos)
// ─────────────────────────────────────────────────────────────────────────────
// Persistência: localStorage (suficiente — payloads pequenos, alta latência tolerável).
// Drena automaticamente quando `navigator.onLine` vira true OU a cada 30s.

import { supabase } from "@/integrations/supabase/client";
import { notify } from "@/lib/notify";

type Table = "plc_groups" | "sectors" | "equipments";
type Op = "insert" | "update" | "delete";

export interface QueuedMutation {
  id: string;            // uuid local da mutation (não confundir com id do registro)
  table: Table;
  op: Op;
  payload: Record<string, unknown>; // pra insert/update: o objeto; pra delete: { id }
  matchId?: string;      // pra update/delete: id do registro alvo
  createdAt: string;
  attempts: number;
  lastError?: string;
}

const QUEUE_KEY = "cadastros_offline_queue_v1";
const MAX_ATTEMPTS = 5;

const read = (): QueuedMutation[] => {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]") as QueuedMutation[]; }
  catch { return []; }
};
const write = (q: QueuedMutation[]) => localStorage.setItem(QUEUE_KEY, JSON.stringify(q));

let draining = false;
let drainTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(count: number) => void>();

const notifyListeners = () => {
  const c = read().length;
  for (const l of listeners) l(c);
};

export const onQueueChange = (cb: (count: number) => void) => {
  listeners.add(cb);
  cb(read().length);
  return () => { listeners.delete(cb); };
};

export const queuedCount = () => read().length;

export const enqueue = (m: Omit<QueuedMutation, "id" | "createdAt" | "attempts">) => {
  const q = read();
  q.push({
    ...m,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    attempts: 0,
  });
  write(q);
  notifyListeners();
  void drain();
};

type RunResult = { ok: true; error?: undefined } | { ok: false; error: string };

const runOne = async (m: QueuedMutation): Promise<RunResult> => {
  try {
    if (m.op === "insert") {
      const { error } = await supabase.from(m.table).insert(m.payload as never);
      if (error) return { ok: false, error: error.message };
    } else if (m.op === "update") {
      if (!m.matchId) return { ok: false, error: "missing matchId for update" };
      const { error } = await supabase.from(m.table).update(m.payload as never).eq("id", m.matchId);
      if (error) return { ok: false, error: error.message };
    } else if (m.op === "delete") {
      if (!m.matchId) return { ok: false, error: "missing matchId for delete" };
      const { error } = await supabase.from(m.table).delete().eq("id", m.matchId);
      if (error) return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

export const drain = async (): Promise<{ processed: number; failed: number }> => {
  if (draining) return { processed: 0, failed: 0 };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { processed: 0, failed: 0 };
  }
  draining = true;
  let processed = 0;
  let failed = 0;
  try {
    let q = read();
    while (q.length > 0) {
      const m = q[0];
      const r = await runOne(m);
      if (r.ok) {
        q = q.slice(1);
        processed++;
      } else {
        const errMsg = r.error;
        m.attempts++;
        m.lastError = errMsg;
        if (m.attempts >= MAX_ATTEMPTS) {
          // descarta após N tentativas e avisa o usuário
          q = q.slice(1);
          failed++;
          notify.fail("Fila Offline", `Falha persistente ao sincronizar (${m.table}/${m.op}): ${errMsg}`);
        } else {
          // mantém na fila e para de tentar nesta rodada
          break;
        }
      }
      write(q);
    }
    notifyListeners();
    if (processed > 0) notify.ok("Fila Offline", `${processed} mudança(s) sincronizada(s) com a nuvem.`);
  } finally {
    draining = false;
  }
  return { processed, failed };
};

export const startOfflineQueueSync = () => {
  if (drainTimer) return;
  // tentativa imediata
  void drain();
  // re-tenta a cada 30s
  drainTimer = setInterval(() => { void drain(); }, 30_000);
  // dispara ao reconectar
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => { void drain(); });
  }
};

export const stopOfflineQueueSync = () => {
  if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
};

export const isOnline = (): boolean =>
  typeof navigator === "undefined" ? true : navigator.onLine !== false;
