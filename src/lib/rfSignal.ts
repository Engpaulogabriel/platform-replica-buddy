// ─────────────────────────────────────────────────────────────────────────────
// rfSignal — utilidades para conversão de latência (ms) → barras (0-4)
// ─────────────────────────────────────────────────────────────────────────────
// Tabela canônica (ver mem://features/rf-signal-measurement):
//   ≤ 4000 ms → 4 barras (100%)
//   ≤ 5000 ms → 3 barras (75%)
//   ≤ 6000 ms → 2 barras (50%)
//   ≤ 8000 ms → 1 barra  (25%)
//   > 8000 ms ou sem resposta → 0 barras (sem sinal)
//
// Reusável tanto pelo mock (modo web sem bridge) quanto pelo cronômetro real
// quando o protocolo RS-485 chegar via electronAPI.serialAPI.

export type SignalBars = 0 | 1 | 2 | 3 | 4;

/** Janela máxima para considerar resposta (ms). Acima disso → 0 barras. */
export const RF_TIMEOUT_MS = 8_000;

/** Converte latência (ms) em 0-4 barras seguindo a tabela canônica. */
export function measureSignalBars(latencyMs: number): SignalBars {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return 0;
  if (latencyMs <= 4_000) return 4;
  if (latencyMs <= 5_000) return 3;
  if (latencyMs <= 6_000) return 2;
  if (latencyMs <= RF_TIMEOUT_MS) return 1;
  return 0;
}

/** Converte 0-4 barras em percentual (0/25/50/75/100). */
export function barsToPercent(bars: SignalBars): number {
  return bars * 25;
}

/**
 * Simula uma latência aleatória entre min e max ms (default 1-10s) — usado no
 * preview web onde a bridge Electron não está disponível.
 * Distribuição: Math.random uniforme. ~20% de chance de timeout (>8s) para
 * exercitar todos os casos da UI.
 */
export function simulateLatency(minMs = 1_000, maxMs = 10_000): number {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}
