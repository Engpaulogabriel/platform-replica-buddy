// ─────────────────────────────────────────────────────────────────────────────
// equipmentRefreshBus — força refetch dos equipamentos após um comando
// ─────────────────────────────────────────────────────────────────────────────
// Realtime está desligado globalmente (kill switch). Depois de enfileirar um
// comando (ex.: desligamento forçado), disparamos um "burst" de refetch em
// 5s / 15s / 30s para capturar a mudança de `desired_running` mesmo sem
// WebSocket e sem refresh manual do usuário.

type Listener = () => void;

const listeners = new Set<Listener>();
const BURST_DELAYS_MS = [5_000, 15_000, 30_000];

export function subscribeEquipmentRefresh(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emit(): void {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

/** Dispara refetch imediato + 5s / 15s / 30s. */
export function triggerEquipmentRefreshBurst(): void {
  emit();
  for (const delay of BURST_DELAYS_MS) {
    setTimeout(emit, delay);
  }
}
