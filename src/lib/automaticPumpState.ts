// automaticPumpState.ts — estados do indicador AUTO.
// ---------------------------------------------------------------------------
// O indicador AUTO tem estados PRÓPRIOS. Ele NUNCA altera a cor operacional da
// bomba: o estado físico continua sendo representado pelo estado físico. Foi
// erro cometido antes (falha técnica pintando o card) e não se repete aqui.
//
// Módulo PURO: sem React, sem Supabase, sem DOM.

export type AutoState =
  | "off"              // Modo Automático desativado para a fazenda
  | "idle"             // AUTO ativo, situação coerente
  | "waiting_start"    // na fila legítima de partida escalonada
  | "starting"         // comando de ligar em processamento
  | "no_comm"          // desired conhecido, estado físico não confiável
  | "failed";          // tentou de verdade e não confirmou após a tolerância

/** 15 minutos. Prazo para DECLARAR falha — não para desistir. */
export const AUTO_FAILURE_TOLERANCE_MS = 15 * 60_000;

export interface AutoInput {
  /** `automation_engine.enabled` da fazenda. */
  engineEnabled: boolean;
  /** Estado desejado pelo motor agora: 'on' | 'off' | null. */
  desired: "on" | "off" | null;
  /** Estado físico lido. `null` = sem leitura confiável. */
  physicalRunning: boolean | null;
  /** Há comando em processamento para esta bomba? */
  hasPendingCommand: boolean;
  /** `equipments.automatic_on_attempt_since` — início da tentativa real. */
  attemptSince: Date | null;
  /** Comunicação considerada saudável? */
  online: boolean;
  now?: Date;
}

/**
 * Ordem deliberada.
 *
 * `failed` exige TENTATIVA REAL: `attemptSince` só é preenchido quando o motor
 * efetivamente comandou. Bomba na fila tem `attemptSince = null` e por isso
 * NUNCA fica vermelha, por mais tempo que espere. Ausência de comunicação
 * também não é falha de ligamento — é `no_comm`.
 */
export function autoState(i: AutoInput): AutoState {
  if (!i.engineEnabled) return "off";

  // Sem estado físico confiável: não é falha, e não se comanda às cegas.
  if (!i.online || i.physicalRunning === null) {
    return i.desired ? "no_comm" : "idle";
  }

  if (i.desired !== "on") return "idle";
  if (i.physicalRunning) return "idle";        // já está como deveria

  if (i.hasPendingCommand) return "starting";

  // Houve tentativa real? Só então o relógio de falha corre.
  if (i.attemptSince) {
    const now = (i.now ?? new Date()).getTime();
    if (now - i.attemptSince.getTime() >= AUTO_FAILURE_TOLERANCE_MS) return "failed";
    return "starting";                          // tentando, dentro da tolerância
  }

  // Deveria estar ON, está OFF, nenhuma tentativa em curso → aguardando a vez.
  return "waiting_start";
}

export const AUTO_LABEL: Record<AutoState, string> = {
  off: "",
  idle: "AUTO",
  waiting_start: "AUTO · Aguardando partida",
  starting: "AUTO · Ligando",
  no_comm: "AUTO · Sem comunicação",
  failed: "AUTO",
};

/** Só o estado de falha pisca em vermelho. Fila e sem-comunicação, não. */
export const AUTO_IS_FAILURE: Record<AutoState, boolean> = {
  off: false, idle: false, waiting_start: false,
  starting: false, no_comm: false, failed: true,
};

// ── Configuração de partida escalonada, por fazenda ────────────────────────
export const STAGGER_DEFAULTS = {
  enabled: true,
  /** Conservador: nenhuma fazenda parte em grupo sem alguém decidir que aguenta. */
  batchSize: 1,
  /** Mesmo tempo que o safety da arquitetura já usa para encerrar um ON. */
  staggerSeconds: 60,
};

export const STAGGER_LIMITS = {
  batchMin: 1, batchMax: 20,
  /** 10s é o ciclo de polling do agente; abaixo disso não há como confirmar. */
  staggerMin: 10,
  /** 15 min: acima disso a recuperação demoraria mais que a tolerância de falha. */
  staggerMax: 900,
};

export function validateStaggerConfig(batchSize: number, staggerSeconds: number): string | null {
  if (!Number.isInteger(batchSize) || batchSize < STAGGER_LIMITS.batchMin || batchSize > STAGGER_LIMITS.batchMax) {
    return `Bombas por grupo deve ser um número inteiro entre ${STAGGER_LIMITS.batchMin} e ${STAGGER_LIMITS.batchMax}.`;
  }
  if (!Number.isInteger(staggerSeconds) || staggerSeconds < STAGGER_LIMITS.staggerMin || staggerSeconds > STAGGER_LIMITS.staggerMax) {
    return `Intervalo entre grupos deve ser um número inteiro entre ${STAGGER_LIMITS.staggerMin} e ${STAGGER_LIMITS.staggerMax} segundos.`;
  }
  return null;
}

export const STAGGER_HELP =
  "Limita quantas bombas podem partir simultaneamente durante recuperações " +
  "automáticas, reduzindo picos de demanda.";
