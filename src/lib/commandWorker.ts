// ─────────────────────────────────────────────────────────────────────────────
// commandWorker — fila TX + RX parser (rodando no cliente Electron)
// ─────────────────────────────────────────────────────────────────────────────
// Responsabilidades:
//  1. Escutar tabela `commands` via Supabase Realtime (status=pending)
//  2. Processar por prioridade (manual=1 > polling=5 > diag=10), respeitando
//     intervalo mínimo de 3s entre envios (limitação ESP_A)
//  3. Enviar frame pela Serial via window.serialAPI.write (que já anexa \r)
//  4. Atualizar status no Supabase: pending → sent → executed/timeout
//  5. RX listener: parsear linhas recebidas (delimiter \r), classificar e
//     chamar apply_pump_telemetry para respostas de bomba
//
// REQUER: rodando dentro do Electron (.exe) com window.serialAPI presente
// e porta COM aberta. Em modo web, este worker fica idle.

import { supabase } from "@/integrations/supabase/client";
import { measureSignalBars } from "@/lib/rfSignal";

const MIN_INTERVAL_BETWEEN_TX_MS = 3_000; // limitação física do ESP_A — NÃO REDUZIR
const POLL_FALLBACK_MS = 10_000;          // fallback (Realtime é primário) — mínimo 10s p/ cota Cloud

// ─── Retry/backoff para UPDATE no Supabase quando internet está lenta ───
// Starlink pode ter picos > 15s. Aumentamos o timeout local para 30s e
// fazemos até 3 tentativas com backoff. Se mesmo assim falhar, guardamos
// na fila `pendingConfirmations` e drenamos no próximo ciclo de polling.
// IMPORTANTE: NUNCA reenviar o comando à PLC — a PLC já confirmou execução.
const SUPABASE_UPDATE_TIMEOUT_MS = 30_000;
const SUPABASE_UPDATE_RETRIES = [5_000, 10_000, 30_000];

interface PendingConfirmation {
  commandId: string;
  patch: Record<string, unknown>;
  guard?: { column: string; values: string[] };
  queuedAt: number;
}
const pendingConfirmations: PendingConfirmation[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Executa UPDATE em commands com timeout local + retry/backoff.
 *  Em caso de falha total, enfileira para drenar depois. NÃO lança. */
async function updateCommandWithRetry(
  commandId: string,
  patch: Record<string, unknown>,
  guard?: { column: string; values: string[] },
): Promise<boolean> {
  for (let attempt = 0; attempt <= SUPABASE_UPDATE_RETRIES.length; attempt++) {
    try {
      let q: any = supabase.from("commands").update(patch as any).eq("id", commandId);
      if (guard) q = q.in(guard.column as any, guard.values);
      const result = await Promise.race([
        q.then((r) => r),
        new Promise<{ error: { message: string } }>((_, reject) =>
          setTimeout(() => reject(new Error(`timeout local ${SUPABASE_UPDATE_TIMEOUT_MS}ms`)), SUPABASE_UPDATE_TIMEOUT_MS),
        ),
      ]);
      if ((result as any).error) throw new Error((result as any).error.message);
      return true;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.warn(`[commandWorker] tentativa ${attempt + 1} falhou ao atualizar comando ${commandId}: ${msg}`);
      if (attempt < SUPABASE_UPDATE_RETRIES.length) {
        await sleep(SUPABASE_UPDATE_RETRIES[attempt]);
      }
    }
  }
  pendingConfirmations.push({ commandId, patch, guard, queuedAt: Date.now() });
  console.error(`[commandWorker] comando ${commandId} executado mas não confirmado no banco — adicionado à fila (${pendingConfirmations.length} pendentes)`);
  return false;
}

/** Drena confirmações pendentes (chamado no início de cada processNext). */
async function drainPendingConfirmations() {
  if (pendingConfirmations.length === 0) return;
  const batch = pendingConfirmations.splice(0, pendingConfirmations.length);
  for (const item of batch) {
    try {
      let q: any = supabase.from("commands").update(item.patch as any).eq("id", item.commandId);
      if (item.guard) q = q.in(item.guard.column as any, item.guard.values);
      const result = await Promise.race([
        q.then((r) => r),
        new Promise<{ error: { message: string } }>((_, reject) =>
          setTimeout(() => reject(new Error("timeout drenagem")), SUPABASE_UPDATE_TIMEOUT_MS),
        ),
      ]);
      if ((result as any).error) throw new Error((result as any).error.message);
      if (import.meta.env.DEV) console.info(`[commandWorker] drenou confirmação pendente ${item.commandId}`);
    } catch (err: any) {
      // Volta para a fila para próxima tentativa
      pendingConfirmations.push(item);
      if (import.meta.env.DEV) console.debug(`[commandWorker] falha ao drenar ${item.commandId}: ${err?.message ?? err}`);
      break; // sem internet ainda — para o batch
    }
  }
}

interface PendingCommand {
  id: string;
  farm_id: string;
  equipment_id: string | null;
  plc_hw_id: string | null;
  type: string;
  priority: number;
  frame: string;
  timeout_ms: number;
  created_at: string;
  source_device: string | null;
}

interface InflightCommand {
  id: string;
  sentAt: number;
  timeoutMs: number;
  expectedTsnn: string | null;
  equipmentId: string | null;
  farmId: string;
  type: string; // 'manual' | 'polling' | 'config' | 'server' | 'repeater' | 'diagnostic'
  responseLines: string[]; // acumula multi-linha (STATUS/DUMP)
}

let activeFarmId: string | null = null;
let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;
let pollFallbackTimer: ReturnType<typeof setInterval> | null = null;
let processing = false;
let lastTxAt = 0;
const inflight = new Map<string, InflightCommand>();
let unsubData: (() => void) | null = null;

const isBridgePresent = (): boolean =>
  typeof window !== "undefined" && !!(window as any).serialAPI;

const isPortOpen = (): boolean => {
  try {
    return !!(window as any).serialAPI?.isOpen?.();
  } catch {
    return false;
  }
};

/** Extrai TSNN do frame `[TSNN_X_]{...}[TSNN_ETX_]\r`. TSNN são 4 dígitos. */
function extractTsnnFromFrame(frame: string): string | null {
  const m = frame.match(/^\[(\d{4})_/);
  return m ? m[1] : null;
}

/** Extrai TSNN da resposta `_[TSNN_0_]{...}[TSNN_ETX_]` ou frame espontâneo
 *  com mesmo formato. TSNN são 4 dígitos exatos. */
function extractTsnnFromResponse(line: string): string | null {
  const m = line.match(/\[(\d{4})_/);
  return m ? m[1] : null;
}

/** Extrai payload `{XXXXXX}` da resposta. Aceita 1-6 bits (firmware
 *  pode responder com 1 bit quando só uma saída está em uso). */
function extractPayloadFromResponse(line: string): string | null {
  const m = line.match(/\{([01]{1,6})\}/);
  return m ? m[1] : null;
}

function isUnsafePollingActuation(cmd: PendingCommand): boolean {
  if (cmd.type !== "polling") return false;
  if (!/\{[01]{1,6}\}/.test(cmd.frame || "")) return false;
  return cmd.source_device !== "platform-scheduler";
}

async function fetchNextPending(farmId: string): Promise<PendingCommand | null> {
  const { data, error } = await supabase
    .from("commands")
    .select("id,farm_id,equipment_id,plc_hw_id,type,priority,frame,timeout_ms,created_at,source_device")
    .eq("farm_id", farmId)
    .eq("status", "pending")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (import.meta.env.DEV) console.debug("[commandWorker] fetch pending:", error.message);
    return null;
  }
  return data as PendingCommand | null;
}

async function markSent(commandId: string): Promise<boolean> {
  const { error } = await supabase
    .from("commands")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", commandId)
    .eq("status", "pending"); // evita race
  return !error;
}

async function markError(commandId: string, message: string) {
  await supabase
    .from("commands")
    .update({
      status: "error",
      responded_at: new Date().toISOString(),
      error_message: message,
    })
    .eq("id", commandId);
}

async function processNext() {
  // Sempre tenta drenar confirmações pendentes — independente de TX/porta.
  // Falhas aqui NÃO interrompem o polling.
  void drainPendingConfirmations().catch((e) =>
    import.meta.env.DEV && console.debug("[commandWorker] drain falhou:", e),
  );
  if (processing) return;
  if (!activeFarmId) return;
  if (!isBridgePresent() || !isPortOpen()) return;

  const sinceLastTx = Date.now() - lastTxAt;
  if (sinceLastTx < MIN_INTERVAL_BETWEEN_TX_MS) {
    setTimeout(processNext, MIN_INTERVAL_BETWEEN_TX_MS - sinceLastTx + 50);
    return;
  }

  processing = true;
  try {
    const cmd = await fetchNextPending(activeFarmId);
    if (!cmd) return;

    if (isUnsafePollingActuation(cmd)) {
      await supabase
        .from("commands")
        .update({
          status: "cancelled",
          responded_at: new Date().toISOString(),
          error_message: "Polling com payload de acionamento bloqueado localmente para evitar comando oculto de ligar/desligar",
        })
        .eq("id", cmd.id)
        .eq("status", "pending");
      console.error("[commandWorker] BLOQUEADO polling inseguro antes do TX", {
        id: cmd.id,
        frame: cmd.frame,
        source_device: cmd.source_device,
      });
      return;
    }

    // Reserva (status pending → sent) atomicamente
    const claimed = await markSent(cmd.id);
    if (!claimed) return;

    const api = (window as any).serialAPI;
    try {
      await api.write(cmd.frame);
      lastTxAt = Date.now();
      const tsnn = cmd.plc_hw_id ?? extractTsnnFromFrame(cmd.frame);
      inflight.set(cmd.id, {
        id: cmd.id,
        sentAt: lastTxAt,
        timeoutMs: cmd.timeout_ms ?? 10_000,
        expectedTsnn: tsnn,
        equipmentId: cmd.equipment_id,
        farmId: cmd.farm_id,
        type: cmd.type,
        responseLines: [],
      });
      // Agenda timeout local. Manual usa 120s; polling/config continuam curtos.
      const timeoutMs = cmd.timeout_ms ?? 10_000;
      setTimeout(() => { void timeoutInflight(cmd.id); }, timeoutMs + 200);
      if (import.meta.env.DEV) console.info("[commandWorker] TX", cmd.type, cmd.frame.replace("\r", "\\r"));
    } catch (e: any) {
      await markError(cmd.id, e?.message ?? String(e));
    }
  } finally {
    processing = false;
    // Encadeia próximo
    setTimeout(processNext, MIN_INTERVAL_BETWEEN_TX_MS);
  }
}

/** Marca inflight como timeout se ainda estiver na fila após o tempo limite. */
async function timeoutInflight(commandId: string) {
  const info = inflight.get(commandId);
  if (!info) return; // já respondeu
  inflight.delete(commandId);
  await updateCommandWithRetry(
    commandId,
    {
      status: "timeout",
      responded_at: new Date().toISOString(),
      error_message: "Sem resposta dentro do timeout",
      response: info.responseLines.length ? info.responseLines.join("\n") : null,
    },
    { column: "status", values: ["sent"] },
  );
}

/** Procura o primeiro inflight que casa com o predicado, em ordem de envio. */
function findInflight(predicate: (c: InflightCommand) => boolean): InflightCommand | null {
  let oldest: InflightCommand | null = null;
  for (const info of inflight.values()) {
    if (!predicate(info)) continue;
    if (!oldest || info.sentAt < oldest.sentAt) oldest = info;
  }
  return oldest;
}

async function finalizeInflight(
  cmd: InflightCommand,
  status: "executed" | "error",
  responseLine: string,
) {
  inflight.delete(cmd.id);
  cmd.responseLines.push(responseLine);
  // PLC já confirmou — nunca reenviar. Se Supabase falhar, vai para fila pendente.
  await updateCommandWithRetry(cmd.id, {
    status,
    responded_at: new Date().toISOString(),
    response: cmd.responseLines.join("\n"),
  });
}

/** RX: classifica linha e atualiza Supabase. */
async function handleSerialLine(rawLine: string) {
  const line = rawLine.trim();
  if (!line) return;

  // ─────────────────────────────────────────────────────────────────────
  // 1. Resposta/FRAME ESPONTÂNEO de OPERAÇÃO de bomba (cmd=0).
  //    Formato real do firmware: `_[TSNN_0_]{XXXXXX}[TSNN_ETX_]` OU
  //    com sufixos de leitura entre payload e ETX, ex.:
  //      `_[1107_0_]{1}_N10N1__N20N2_[1107_ETX_]`
  //    O `_` inicial pode estar ausente em alguns frames espontâneos.
  //    Aceita payload de 1 a 6 bits e qualquer texto entre `}` e `[..._ETX_]`.
  //    REGRA OBRIGATÓRIA: qualquer frame com TSNN+_0_+payload deve sempre
  //    ser entregue ao backend, mesmo SEM comando inflight (espontâneo).
  // ─────────────────────────────────────────────────────────────────────
  const isPumpOpResponse = /\[\d{4}_0_\]\{[01]{1,6}\}.*\[\d{4}_ETX_\]/.test(line);
  if (isPumpOpResponse) {
    const tsnn = extractTsnnFromResponse(line);
    const payload = extractPayloadFromResponse(line);
    if (!tsnn || !payload) {
      if (import.meta.env.DEV) console.warn("[commandWorker] RX bomba op: tsnn/payload inválido", line);
      return;
    }

    const matched = findInflight((c) => c.expectedTsnn === tsnn && (c.type === "manual" || c.type === "polling"));
    let signalBars: number | null = null;
    let matchedCmdId: string | null = null;
    let matchedType: string | null = null;
    let farmId = activeFarmId;
    if (matched) {
      signalBars = measureSignalBars(Date.now() - matched.sentAt);
      matchedCmdId = matched.id;
      matchedType = matched.type;
      farmId = matched.farmId;
      inflight.delete(matched.id);
    }
    if (!farmId) {
      if (import.meta.env.DEV) console.warn("[commandWorker] RX bomba op IGNORADO sem farm ativa", line);
      return;
    }

    try {
      await supabase.rpc("apply_pump_telemetry", {
        _farm_id: farmId,
        _tsnn: tsnn,
        _payload: payload,
        _signal_bars: signalBars,
        _command_id: matchedCmdId,
        _raw_response: line,
      });
      if (import.meta.env.DEV) {
        const tag = matched ? "(resposta)" : "(ESPONTÂNEO)";
        console.info("[commandWorker] RX bomba op", tag, tsnn, payload, "bars=", signalBars);
      }
      // Comando manual NÃO vira executed só por receber eco/estado antigo.
      // apply_pump_telemetry só conclui quando a telemetria confirmar o bit esperado;
      // caso contrário mantém a janela física de 120s aberta.
    } catch (e) {
      console.error("[commandWorker] apply_pump_telemetry FALHOU — frame perdido!", line, e);
    }
    return;
  }

  // 2. Resposta de CFG de bomba: `_[TSNN_CFG_]{OK:...}[TSNN_ETX_]`
  const cfgMatch = line.match(/_\[(\w+)_CFG_\]\{([^}]*)\}\[\w+_ETX_\]/);
  if (cfgMatch) {
    const tsnn = cfgMatch[1];
    const matched = findInflight((c) => c.type === "config" && c.expectedTsnn === tsnn);
    if (matched) {
      const isErr = cfgMatch[2].startsWith("ERR");
      await finalizeInflight(matched, isErr ? "error" : "executed", line);
      if (import.meta.env.DEV) console.info("[commandWorker] RX bomba CFG", tsnn, cfgMatch[2]);
    }
    return;
  }

  // 3. Resposta do REPETIDOR: começa com `REP_RESP:` ou `RCR_RESP:` ou contém `~RCR_RESP~`
  const isRepResp = line.startsWith("REP_RESP:") || line.startsWith("RCR_RESP:") || line.includes("~RCR_RESP~");
  if (isRepResp) {
    const matched = findInflight((c) => c.type === "repeater");
    if (matched) {
      matched.responseLines.push(line);
      // Multi-linha STATUS/DUMP termina em `===` — finaliza nesse caso, senão finaliza imediato
      const isMultiLineEnd = /===\s*$/.test(line);
      const isFirstAndSingle = matched.responseLines.length === 1 && !line.includes("===");
      if (isMultiLineEnd || isFirstAndSingle) {
        const isErr = line.includes("ERR:");
        await finalizeInflight(matched, isErr ? "error" : "executed", "");
      }
    }
    return;
  }

  // 4. Resposta do SERVIDOR local: `OK:...` / `ERR:...` (single) ou multi-linha terminando em `===`
  const isServerSingle = line.startsWith("OK:") || line.startsWith("ERR:");
  const isServerHeader = line.startsWith("===") || line.startsWith("---");
  if (isServerSingle || isServerHeader) {
    const matched = findInflight((c) => c.type === "server");
    if (matched) {
      matched.responseLines.push(line);
      // Heurística: STATUS/DUMP do servidor terminam com uma linha === final.
      // Se primeira linha é OK:/ERR: e curta, finaliza imediato; senão espera === final.
      const isMultiLineEnd = matched.responseLines.length > 1 && /===\s*$/.test(line);
      const isSingleOk = matched.responseLines.length === 1 && isServerSingle;
      if (isMultiLineEnd || isSingleOk) {
        const isErr = matched.responseLines.some((l) => l.startsWith("ERR:"));
        await finalizeInflight(matched, isErr ? "error" : "executed", "");
      }
    }
    return;
  }

  // 5. Linha não classificada — anexa à última resposta server/repeater inflight para multi-linha
  const fallback = findInflight((c) => c.type === "server" || c.type === "repeater");
  if (fallback && fallback.responseLines.length > 0) {
    fallback.responseLines.push(line);
    return;
  }

  // 6. Frame totalmente desconhecido — registrar em DEV para depuração
  //    (NUNCA descartar silenciosamente — política de zero-perda de frames).
  if (import.meta.env.DEV) {
    console.warn("[commandWorker] RX não classificado (preservado em log):", line);
  }
}

export interface CommandWorkerStatus {
  running: boolean;
  farmId: string | null;
  inflightCount: number;
  lastTxAt: number;
}

export function getCommandWorkerStatus(): CommandWorkerStatus {
  return {
    running: !!realtimeChannel,
    farmId: activeFarmId,
    inflightCount: inflight.size,
    lastTxAt,
  };
}

/**
 * Inicia o worker para a fazenda. Idempotente.
 * Em modo web (sem bridge), retorna no-op.
 */
export function startCommandWorker(farmId: string): () => void {
  if (!isBridgePresent()) {
    if (import.meta.env.DEV) console.info("[commandWorker] bridge ausente — worker não iniciado (modo web)");
    return () => {};
  }
  if (activeFarmId === farmId && realtimeChannel) {
    return () => stopCommandWorker();
  }
  stopCommandWorker();
  activeFarmId = farmId;

  // 1. Realtime: dispara processamento ao surgir novo pending (nome único por start)
  try {
    realtimeChannel = supabase
      .channel(`commands-${farmId}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "commands", filter: `farm_id=eq.${farmId}` },
        () => { void processNext(); },
      )
      .subscribe();
  } catch (e) {
    console.warn("[commandWorker] realtime subscribe falhou:", e);
    realtimeChannel = null;
  }

  // 2. RX listener
  const api = (window as any).serialAPI;
  unsubData = api?.onData?.((line: string) => { void handleSerialLine(line); }) ?? null;

  // 2b. Watchdog de comunicação serial (2 min sem RX → alerta admin)
  try {
    api?.configureWatchdog?.({
      farmId,
      supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
      anonKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    });
  } catch (e) { console.warn("[commandWorker] configureWatchdog falhou:", e); }

  // 3. Fallback poll (caso Realtime caia)
  pollFallbackTimer = setInterval(() => { void processNext(); }, POLL_FALLBACK_MS);

  // 4. Tick inicial
  void processNext();

  return () => stopCommandWorker();
}

export function stopCommandWorker() {
  if (realtimeChannel) {
    try { supabase.removeChannel(realtimeChannel); } catch { /* ignore */ }
    realtimeChannel = null;
  }
  if (pollFallbackTimer) { clearInterval(pollFallbackTimer); pollFallbackTimer = null; }
  if (unsubData) { try { unsubData(); } catch { /* ignore */ } unsubData = null; }
  inflight.clear();
  activeFarmId = null;
}
