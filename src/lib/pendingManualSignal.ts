// ─────────────────────────────────────────────────────────────────────────────
// pendingManualSignal — sinal global "há comando manual pendente?"
// ─────────────────────────────────────────────────────────────────────────────
// Publicado por usePendingManualCommands e consumido por hooks de polling
// (ex.: useCadastrosCloud) para acelerar refetch de 60s → 1.5s enquanto
// existe qualquer comando manual em andamento na fazenda ativa.

type Listener = (active: boolean) => void;

let active = false;
const listeners = new Set<Listener>();

export function setPendingManualActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const l of listeners) {
    try { l(next); } catch { /* ignore */ }
  }
}

export function isPendingManualActive(): boolean {
  return active;
}

export function subscribePendingManualActive(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
