// ─────────────────────────────────────────────────────────────────────────────
// pumpStateMachine — deriva os 11 estados visuais a partir do `Pump`
// ─────────────────────────────────────────────────────────────────────────────
// CAMADA APENAS DE LEITURA: não toca em protocolo, frames, bridge ou Realtime.
// Mapeia `pump.pending` + `pump.running` + `pump.actuationOrigin` + timers para
// um enum nomeado, conforme a spec da máquina de estados (Manus).
//
// SENDING_*  : comando enviado, aguardando ACK do agente (≤ 8s, polling cancelado)
// VERIFYING_*: agente confirmou recepção, aguardando sensores (≤ 120s, polling rodando)
// COMM_FAIL  : 8s expiraram sem resposta do agente
//
// O backend já realiza grande parte do controle (cancela pollings ao receber
// manual; marca actuation_origin=local na RPC apply_pump_telemetry). Este módulo
// apenas dá nome e visual aos estados que o `Pump` já carrega.

import type { Pump } from "@/components/dashboard/PumpTable";

export type PumpState =
  | "IDLE_OFF"
  | "IDLE_ON"
  | "SENDING_ON"
  | "SENDING_OFF"
  | "VERIFYING_ON"
  | "VERIFYING_OFF"
  | "ON_REMOTE"
  | "OFF_REMOTE"
  | "ON_LOCAL"
  | "OFF_LOCAL"
  | "COMM_FAIL";

/** Janela em ms em que o comando ainda está aguardando ACK do agente.
 *  Após esse prazo, se não veio resposta, a UI marca COMM_FAIL. */
export const SENDING_WINDOW_MS = 8_000;

export interface PumpStateInfo {
  state: PumpState;
  /** Label curto p/ tooltip / aria. */
  label: string;
  /** Bombas em SENDING/VERIFYING devem bloquear AMBOS os botões (anti-spam). */
  bothButtonsDisabled: boolean;
  /** Convenience flags. */
  isSending: boolean;
  isVerifying: boolean;
  isCommFail: boolean;
  isLocal: boolean;
}

const labels: Record<PumpState, string> = {
  IDLE_OFF: "Desligada",
  IDLE_ON: "Ligada",
  SENDING_ON: "Enviando ligar…",
  SENDING_OFF: "Enviando desligar…",
  VERIFYING_ON: "Verificando ligamento…",
  VERIFYING_OFF: "Verificando desligamento…",
  ON_REMOTE: "Ligada (remoto)",
  OFF_REMOTE: "Desligada (remoto)",
  ON_LOCAL: "Ligada · Local",
  OFF_LOCAL: "Desligada · Local",
  COMM_FAIL: "Falha de comunicação",
};

/**
 * Deriva o estado visual a partir do snapshot atual do Pump.
 * COMM_FAIL é representado por `pump.pending === "comm_fail"` (setado pelo
 * Dashboard quando o waitForCommand de 8s estoura).
 */
export function derivePumpState(pump: Pump): PumpStateInfo {
  const pending = pump.pending;
  const running = pump.running;
  const isLocal = pump.actuationOrigin === "local";

  // 1) Falha de comunicação tem prioridade visual (operador precisa enxergar)
  if (pending === "comm_fail") {
    return mk("COMM_FAIL", false, false, true, isLocal);
  }

  // 2) Em transição: SENDING (≤ 8s) vs VERIFYING (até 120s)
  if (pending === "turning_on" || pending === "turning_off" || pending === "resetting") {
    const startedAt = pump.pendingStartedAt ?? 0;
    const elapsed = startedAt ? Date.now() - startedAt : 0;
    const isOn = pending === "turning_on";
    const isSending = elapsed < SENDING_WINDOW_MS;
    if (isSending) {
      return mk(isOn ? "SENDING_ON" : "SENDING_OFF", true, false, false, isLocal);
    }
    return mk(isOn ? "VERIFYING_ON" : "VERIFYING_OFF", false, true, false, isLocal);
  }

  // 3) Estados estáveis — usa actuationOrigin pra distinguir LOCAL vs REMOTE
  if (running) {
    if (isLocal) return mk("ON_LOCAL", false, false, false, true);
    // ON_REMOTE quando há rastro de origin=remote, IDLE_ON caso contrário.
    return mk(pump.actuationOrigin && pump.actuationOrigin !== "local" ? "ON_REMOTE" : "IDLE_ON", false, false, false, false);
  }
  if (isLocal) return mk("OFF_LOCAL", false, false, false, true);
  return mk(pump.actuationOrigin && pump.actuationOrigin !== "local" ? "OFF_REMOTE" : "IDLE_OFF", false, false, false, false);
}

function mk(
  state: PumpState,
  bothDisabled: boolean,
  isVerifying: boolean,
  isCommFail: boolean,
  isLocal: boolean,
): PumpStateInfo {
  return {
    state,
    label: labels[state],
    bothButtonsDisabled: bothDisabled,
    isSending: state === "SENDING_ON" || state === "SENDING_OFF",
    isVerifying,
    isCommFail,
    isLocal,
  };
}
