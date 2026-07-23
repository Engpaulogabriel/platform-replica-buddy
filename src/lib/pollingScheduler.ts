// ─────────────────────────────────────────────────────────────────────────────
// pollingScheduler — chama RPC enqueue_polling_for_due_equipments a cada N segundos
// ─────────────────────────────────────────────────────────────────────────────
// Roda em qualquer cliente autenticado (web ou Electron). Não envia frames —
// apenas insere registros pending na tabela commands para que o worker do
// Electron processe.
//
// Uso típico (em App.tsx ou Dashboard):
//   useEffect(() => {
//     if (!farmId) return;
//     return startPollingScheduler(farmId);
//   }, [farmId]);

import { supabase } from "@/integrations/supabase/client";
import { getSystemTimingConfig, onSystemTimersUpdated } from "@/lib/systemTimers";

let activeFarmId: string | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let timeoutTimer: ReturnType<typeof setInterval> | null = null;
let stopTimersSubscription: (() => void) | null = null;

async function tickEnqueue(farmId: string) {
  try {
    const { data, error } = await supabase.rpc("enqueue_polling_for_due_equipments", {
      _farm_id: farmId,
    });
    if (error) {
      // Silencioso — pode ser RLS (viewer sem can_write_farm)
      if (import.meta.env.DEV) console.debug("[pollingScheduler] enqueue:", error.message);
    } else if (data && (data as number) > 0) {
      console.info(`[pollingScheduler] ${data} comando(s) de polling enfileirado(s)`);
    }
  } catch (e) {
    if (import.meta.env.DEV) console.debug("[pollingScheduler] enqueue exception:", e);
  }
}

async function tickTimeout(farmId: string) {
  try {
    await supabase.rpc("mark_commands_timeout", { _farm_id: farmId });
  } catch {
    /* silencioso */
  }
}

/**
 * Inicia o agendador para a fazenda dada. Retorna função de cleanup.
 * Idempotente: se já estiver rodando para a mesma farm, não duplica.
 */
export function startPollingScheduler(farmId: string): () => void {
  if (activeFarmId === farmId && schedulerTimer) {
    return () => stopPollingScheduler();
  }
  stopPollingScheduler();
  activeFarmId = farmId;

  const startTimers = () => {
    if (!activeFarmId) return;
    const { commSystemMs } = getSystemTimingConfig();
    const timeoutTickMs = Math.max(5_000, Math.min(commSystemMs, 15_000));

    if (schedulerTimer) clearInterval(schedulerTimer);
    if (timeoutTimer) clearInterval(timeoutTimer);

    schedulerTimer = setInterval(() => tickEnqueue(activeFarmId as string), commSystemMs);
    timeoutTimer = setInterval(() => tickTimeout(activeFarmId as string), timeoutTickMs);
  };

  // Tick imediato + recorrente
  void tickEnqueue(farmId);
  void tickTimeout(farmId);
  startTimers();
  stopTimersSubscription = onSystemTimersUpdated(() => startTimers());

  return () => stopPollingScheduler();
}

export function stopPollingScheduler() {
  if (stopTimersSubscription) { stopTimersSubscription(); stopTimersSubscription = null; }
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
  if (timeoutTimer) { clearInterval(timeoutTimer); timeoutTimer = null; }
  activeFarmId = null;
}

export function isPollingSchedulerRunning(): boolean {
  return !!schedulerTimer;
}
