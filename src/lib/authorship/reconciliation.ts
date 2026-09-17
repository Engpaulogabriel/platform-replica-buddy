// Regras de reconciliação de autoria remota — espelho, em TypeScript, das regras
// aplicadas no banco (enqueue_remote_reconciliation / apply_remote_reconciliation).
// Mantido puro (sem I/O) para ser testável na infra de testes do projeto (vitest).

export type EvidenceStrength = "strong" | "corroborated_batch";

/** Fontes que comprovam autoria DIRETA do evento. Só elas geram `strong`. */
export const STRONG_SOURCES = [
  "command_audit",
  "commands",
  "details_json",
  "details.user_id",
  "details.user_email",
  "whatsapp_operator",
  "batch_reconciliation",
] as const;

export type StrongSource = (typeof STRONG_SOURCES)[number];

export const isStrongSource = (fonte?: string | null): boolean =>
  !!fonte && (STRONG_SOURCES as readonly string[]).includes(fonte);

export interface RemoteEvent {
  id: string;
  farm_id: string;
  occurred_at: string; // ISO
  action: "turn_on" | "pump_on" | "turn_off" | "pump_off";
  user_id: string | null;
  /** details->>'authorship_source' do evento já nomeado (quando houver). */
  authorship_source?: string | null;
  noise_reason?: string | null;
}

export interface DirectCandidate {
  user_id: string;
  fonte: string;
}

export interface Batch {
  batch_id: string;
  farm_id: string;
  intent: "ligar" | "desligar";
  started_at: string;
  ended_at: string;
  event_ids: string[];
  events_total: number;
  events_unnamed: number;
  /** ids ainda sem autor — os únicos que a reconciliação pode tocar. */
  unnamed_ids: string[];
  in_batch_user_id: string | null;
  in_batch_name_source: string;
  distinct_named_users: number;
}

const intentOf = (a: RemoteEvent["action"]): Batch["intent"] =>
  a === "turn_on" || a === "pump_on" ? "ligar" : "desligar";

/** Agrupa eventos remotos por (fazenda, intenção) usando janela de gap. */
export function buildBatches(events: RemoteEvent[], gapMs = 5 * 60_000): Batch[] {
  const usable = events.filter((e) => !e.noise_reason);
  const groups = new Map<string, RemoteEvent[]>();
  for (const e of usable) {
    const key = `${e.farm_id}|${intentOf(e.action)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }

  const batches: Batch[] = [];
  for (const [key, list] of groups) {
    const [farm_id, intent] = key.split("|") as [string, Batch["intent"]];
    list.sort((a, b) => +new Date(a.occurred_at) - +new Date(b.occurred_at));
    let current: RemoteEvent[] = [];
    const flush = () => {
      if (!current.length) return;
      const named = current.filter((e) => e.user_id);
      const users = Array.from(new Set(named.map((e) => e.user_id!)));
      const sources = Array.from(
        new Set(named.map((e) => e.authorship_source || "legado_sem_fonte")),
      );
      batches.push({
        batch_id: `${farm_id}-${current[0].occurred_at}-${intent}`,
        farm_id,
        intent,
        started_at: current[0].occurred_at,
        ended_at: current[current.length - 1].occurred_at,
        event_ids: current.map((e) => e.id),
        events_total: current.length,
        events_unnamed: current.length - named.length,
        unnamed_ids: current.filter((e) => !e.user_id).map((e) => e.id),
        in_batch_user_id: users.length === 1 ? users[0] : null,
        in_batch_name_source: sources.length ? sources.sort().join(", ") : "legado_sem_fonte",
        distinct_named_users: users.length,
      });
      current = [];
    };
    for (const e of list) {
      if (current.length && +new Date(e.occurred_at) - +new Date(current[current.length - 1].occurred_at) > gapMs) flush();
      current.push(e);
    }
    flush();
  }
  return batches.filter((b) => b.events_unnamed > 0);
}

export interface Suggestion {
  suggested_user: string | null;
  suggestion_strength: EvidenceStrength | null;
  /** Fonte ORIGINAL do nome sugerido, sempre explicitada na tela. */
  suggestion_source: string | null;
}

/**
 * Classifica a sugestão de um lote.
 * `strong` só com trilha direta (ou nome do lote que já veio de trilha direta).
 * Nome herdado de outro evento do lote com fonte indireta/legada ⇒ `corroborated_batch`.
 */
export function classifySuggestion(batch: Batch, direct: DirectCandidate[] = []): Suggestion {
  const strong = direct.find((c) => c.user_id && isStrongSource(c.fonte));
  if (strong) {
    return { suggested_user: strong.user_id, suggestion_strength: "strong", suggestion_source: strong.fonte };
  }
  if (batch.distinct_named_users === 1 && batch.in_batch_user_id) {
    const src = batch.in_batch_name_source;
    const derivedStrong = /batch_reconciliation|command_audit/i.test(src);
    return {
      suggested_user: batch.in_batch_user_id,
      suggestion_strength: derivedStrong ? "strong" : "corroborated_batch",
      suggestion_source: `nome_ja_presente_no_lote:${src}`,
    };
  }
  return { suggested_user: null, suggestion_strength: null, suggestion_source: null };
}

export type Role = "platform_admin" | "owner" | "admin" | "operator" | "viewer";

export interface QueueRowState {
  id: string;
  farm_id: string;
  status: "pending" | "applied" | "dismissed";
  event_ids: string[];
  suggested_user: string | null;
  suggestion_strength: EvidenceStrength | null;
  suggestion_source: string | null;
}

export interface ApplyInput {
  queue: QueueRowState;
  /** ids congelados na conferência da tela. */
  expectedIds: string[];
  /** ids ainda sem autor no momento da aplicação. */
  currentUnnamedIds: string[];
  userId: string;
  executor: string;
  caller: string | null;
  role: Role;
  confirmCorroborated?: boolean;
}

export interface ApplyResult {
  updatedIds: string[];
  confidence: EvidenceStrength | "admin_decision";
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Mesmas travas da RPC — usado nos testes e como pré-validação da tela. */
export function applyReconciliation(input: ApplyInput): ApplyResult {
  const { queue, expectedIds, currentUnnamedIds, userId, executor, caller, role } = input;
  if (!executor) throw new Error("ABORTADO: executor obrigatório");
  if (!caller) throw new Error("ABORTADO: chamada não autenticada");
  if (executor !== caller) throw new Error("ABORTADO: executor informado difere do usuário autenticado");
  if (!["platform_admin", "owner", "admin"].includes(role))
    throw new Error("ABORTADO: sem autorização para reconciliar autoria nesta fazenda");
  if (queue.status !== "pending") throw new Error(`ABORTADO: lote já ${queue.status} (anti-replay)`);
  if (!sameSet(expectedIds, currentUnnamedIds))
    throw new Error("ABORTADO: conjunto mudou desde a conferência. Nada alterado.");

  const confidence: ApplyResult["confidence"] =
    userId === queue.suggested_user ? queue.suggestion_strength ?? "corroborated_batch" : "admin_decision";

  if (confidence === "corroborated_batch" && !input.confirmCorroborated)
    throw new Error(
      `ABORTADO: sugestão apenas corroborada pelo lote (fonte: ${queue.suggestion_source ?? "indeterminada"}). Confirmação explícita obrigatória.`,
    );

  return { updatedIds: [...expectedIds], confidence };
}
