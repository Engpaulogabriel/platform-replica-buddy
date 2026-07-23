// ─────────────────────────────────────────────────────────────────────────────
// useRfMeasurement — cronômetro de latência RF para um equipamento
// ─────────────────────────────────────────────────────────────────────────────
// Fluxo de uma medição:
//   1. start(equipId)           → marca timestamp de envio
//   2. envia comando (RS-232 via serialAPI.write OU simulação no web)
//   3. aguarda resposta (onData) OU timeout 8s OU latência simulada
//   4. converte latency_ms → 0-4 barras via measureSignalBars
//   5. persiste em equipments: { last_signal_bars, last_communication=now() }
//   6. grava em automation_log: { action: status_read, origin: reading, details: { latency_ms, bars, command } }
//
// Modo SEM bridge (preview web): simula latência aleatória 1-10s.
// Modo COM bridge (Electron .exe): envia frame real e cronometra resposta.

import { useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  measureSignalBars,
  simulateLatency,
  RF_TIMEOUT_MS,
  type SignalBars,
} from "@/lib/rfSignal";

export type RfCommand = "turn_on" | "turn_off" | "status_read";

export interface RfMeasurementResult {
  bars: SignalBars;
  latencyMs: number;
  timedOut: boolean;
  simulated: boolean;
  error?: string;
}

interface UseRfMeasurementOpts {
  /** Override do farm_id; se omitido busca do profile do usuário logado */
  farmId?: string | null;
}

const isBridgePresent = (): boolean =>
  typeof window !== "undefined" && !!(window as any).serialAPI;

/** Persiste o resultado da medição no Supabase (equipments + automation_log). */
async function persistMeasurement(args: {
  equipmentId: string;
  equipmentName: string;
  farmId: string | null;
  userId: string | null;
  userEmail: string | null;
  command: RfCommand;
  result: RfMeasurementResult;
}): Promise<void> {
  const { equipmentId, equipmentName, farmId, userId, userEmail, command, result } = args;
  const nowIso = new Date().toISOString();

  // 1. Atualiza equipments com nova leitura de sinal + last_communication
  //    (Quando timed out, mantemos last_communication antigo? Não — o usuário
  //    quis tentar; salvamos a tentativa mas com bars=0 para refletir falha.)
  try {
    await supabase
      .from("equipments")
      .update({
        last_signal_bars: result.bars,
        // só atualiza last_communication se de fato houve resposta
        ...(result.timedOut ? {} : { last_communication: nowIso }),
      })
      .eq("id", equipmentId);
  } catch {
    /* silencioso — RLS pode bloquear se usuário não for admin/operator */
  }

  // 2. MODO CRU (validação): NÃO grava em automation_log.
  // O update do equipamento (last_signal_bars + last_communication) acima
  // já é suficiente para a UI mostrar a barra de sinal.
  if (!farmId) return;
  return;
  /* eslint-disable no-unreachable */
  try {
    await supabase.from("automation_log").insert({
      client_event_id: crypto.randomUUID(),
      farm_id: farmId,
      user_id: userId,
      user_email: userEmail,
      equipment_id: equipmentId,
      equipment_name: equipmentName,
      action: command === "status_read" ? "status_read" : command,
      origin: command === "status_read" ? "reading" : "remote",
      result: result.timedOut ? "timeout" : "success",
      occurred_at: nowIso,
      details: {
        latency_ms: result.latencyMs,
        bars: result.bars,
        simulated: result.simulated,
        command,
        ...(result.error ? { error: result.error } : {}),
      },
      source_device: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 80) : null,
    });
  } catch {
    /* silencioso */
  }
}

/**
 * Hook que mede a latência RF de um comando enviado a um equipamento.
 *
 * Uso típico:
 * ```ts
 * const { measure } = useRfMeasurement();
 * const r = await measure({ equipmentId, equipmentName, command: "turn_on" });
 * setPump(p => ({ ...p, signalRF: barsToPercent(r.bars), online: r.bars > 0 }));
 * ```
 */
export function useRfMeasurement(opts: UseRfMeasurementOpts = {}) {
  const { user } = useAuth();
  const farmIdRef = useRef<string | null>(opts.farmId ?? null);

  // Resolve farmId do profile uma vez
  const resolveFarmId = useCallback(async (): Promise<string | null> => {
    if (farmIdRef.current) return farmIdRef.current;
    if (!user?.id) return null;
    const { data } = await supabase
      .from("profiles")
      .select("default_farm_id")
      .eq("id", user.id)
      .maybeSingle();
    farmIdRef.current = data?.default_farm_id ?? null;
    return farmIdRef.current;
  }, [user?.id]);

  /**
   * Aguarda primeira resposta válida da bridge OU timeout de 8s.
   * Se `expectedHwId` for passado, ignora linhas que não contenham `[<hwId>_`
   * ou `_[<hwId>_` (formato do `isBombaResponseLine`) — assim outras bombas
   * respondendo no mesmo barramento não roubam a medição.
   */
  const waitForRealResponse = useCallback(
    (expectedHwId?: string): Promise<{ latencyMs: number; timedOut: boolean }> => {
      return new Promise((resolve) => {
        const api = (window as any).serialAPI;
        const start = performance.now();
        let off: (() => void) | null = null;
        let done = false;

        const finish = (timedOut: boolean) => {
          if (done) return;
          done = true;
          try { off?.(); } catch { /* ignore */ }
          clearTimeout(timer);
          resolve({ latencyMs: Math.round(performance.now() - start), timedOut });
        };

        const timer = setTimeout(() => finish(true), RF_TIMEOUT_MS + 200);

        try {
          off = api?.onData?.((line: string) => {
            // Sem filtro ou primeira linha qualquer → aceita
            if (!expectedHwId) return finish(false);
            // Aceita só se a linha mencionar o ID alvo (formato [TSNN_ ou _[TSNN_)
            if (line.includes(`[${expectedHwId}_`) || line.includes(`_[${expectedHwId}_`)) {
              finish(false);
            }
            // Caso contrário ignora — outra bomba respondendo
          }) ?? null;
        } catch {
          finish(true);
        }
      });
    },
    [],
  );

  /** Simula latência (modo web) — resolve após N ms. */
  const waitForSimulatedResponse = useCallback((): Promise<{ latencyMs: number; timedOut: boolean }> => {
    const latency = simulateLatency(800, 9_500);
    return new Promise((resolve) => {
      setTimeout(
        () => resolve({ latencyMs: latency, timedOut: latency > RF_TIMEOUT_MS }),
        Math.min(latency, RF_TIMEOUT_MS + 200),
      );
    });
  }, []);

  const measure = useCallback(
    async (args: {
      equipmentId: string;
      equipmentName: string;
      command: RfCommand;
      /** Frame RS-232 a enviar (já formatado por buildLoRaFrame/buildDirectToServer). Opcional no modo simulado. */
      frame?: string;
      /** hw_id do equipamento (4 chars hex). Usado para filtrar resposta certa no barramento. */
      expectedHwId?: string;
    }): Promise<RfMeasurementResult> => {
      const bridge = isBridgePresent();
      const api = (window as any).serialAPI;
      let error: string | undefined;
      let simulated = !bridge;

      // 1. Envia comando (real OU simulado)
      // Bridge presente + frame montado + porta aberta → modo real
      const portOpen = bridge && typeof api?.isOpen === "function" ? !!api.isOpen() : false;
      const realMode = bridge && !!args.frame && portOpen;
      if (!realMode) simulated = true;

      if (realMode) {
        try {
          await api.write(args.frame!);
        } catch (e: any) {
          error = e?.message ?? String(e);
          // se write falhou, considera timeout imediato sem esperar
          const result: RfMeasurementResult = {
            bars: 0, latencyMs: 0, timedOut: true, simulated: false, error,
          };
          const farmId = await resolveFarmId();
          await persistMeasurement({
            equipmentId: args.equipmentId,
            equipmentName: args.equipmentName,
            farmId,
            userId: user?.id ?? null,
            userEmail: user?.email ?? null,
            command: args.command,
            result,
          });
          return result;
        }
      }

      // 2. Aguarda resposta (real com filtro por hw_id, ou simulado por timer)
      const { latencyMs, timedOut } = realMode
        ? await waitForRealResponse(args.expectedHwId)
        : await waitForSimulatedResponse();

      // 3. Converte para barras
      const bars = timedOut ? 0 : measureSignalBars(latencyMs);

      const result: RfMeasurementResult = { bars, latencyMs, timedOut, simulated, error };

      // 4. Persiste (não bloqueia a UI — fire-and-forget)
      const farmId = await resolveFarmId();
      void persistMeasurement({
        equipmentId: args.equipmentId,
        equipmentName: args.equipmentName,
        farmId,
        userId: user?.id ?? null,
        userEmail: user?.email ?? null,
        command: args.command,
        result,
      });

      return result;
    },
    [resolveFarmId, user?.id, user?.email, waitForRealResponse, waitForSimulatedResponse],
  );

  return { measure, bridgePresent: isBridgePresent() };
}
