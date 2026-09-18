// ─────────────────────────────────────────────────────────────────────────────
// Finalização ÚNICA de comando manual de bomba
// ─────────────────────────────────────────────────────────────────────────────
// O problema que este módulo existe para resolver:
//
// O toast de sucesso era emitido no ACK do comando (`commands.status='executed'`
// — o agente transmitiu o frame e a serial respondeu), enquanto o card só saía
// de "Desligando…" na CONFIRMAÇÃO FÍSICA (`last_outputs_state` refletindo o
// estado esperado). Dois critérios diferentes para o mesmo evento produziam a
// tela impossível: "POÇO 19 desligou com sucesso" com o card ainda em
// "DESLIGANDO…". Depois um segundo toast, esse sim na confirmação real.
//
// Aqui existe UMA definição de "acabou": a confirmação física. O ACK deixa de
// notificar — ele não prova que a bomba obedeceu. Quem fecha a transição fecha
// também o toast, uma vez só, e qualquer evento posterior do MESMO comando é
// silenciosamente ignorado.
//
// Timeout e erro NÃO passam por aqui: encerram a transição com erro, e erro
// nunca vira sucesso.

import { notifyCommand } from "@/lib/notify";

interface InFlight {
  commandId: string;
  /** true = o operador pediu LIGAR; false = DESLIGAR. */
  expectOn: boolean;
  equipmentName: string;
}

/** equipmentId → comando manual em voo. Um por equipamento, por desenho. */
const inFlight = new Map<string, InFlight>();
/** command_id já finalizados — a trava de idempotência. */
const finalized = new Set<string>();

/** Registra o comando recém-enfileirado. Chamado logo após o INSERT. */
export function beginPumpCommand(
  equipmentId: string,
  commandId: string,
  expectOn: boolean,
  equipmentName: string,
): void {
  if (!equipmentId || !commandId) return;
  inFlight.set(equipmentId, { commandId, expectOn, equipmentName });
}

/**
 * Encerra o comando SEM sucesso (timeout, erro, cancelamento). Nenhum toast é
 * emitido aqui — quem trata o erro já notifica o operador com a mensagem certa.
 * Marca como finalizado para que uma confirmação atrasada não vire sucesso.
 */
export function failPumpCommand(equipmentId: string): void {
  const f = inFlight.get(equipmentId);
  if (!f) return;
  finalized.add(f.commandId);
  inFlight.delete(equipmentId);
}

/**
 * CONFIRMAÇÃO FÍSICA. Chamada quando a transição do equipamento termina — isto
 * é, quando `pending` some porque a telemetria real confirmou o estado.
 *
 * Emite exatamente UM toast, e só se o estado confirmado for o que o operador
 * pediu. Devolve true se finalizou agora (útil em teste).
 *
 * Confirmação de OUTRO equipamento não fecha este comando: o mapa é por
 * equipmentId e a busca é exata.
 */
export function finalizePumpCommandIfConfirmed(
  equipmentId: string,
  running: boolean,
): boolean {
  const f = inFlight.get(equipmentId);
  if (!f) return false;                       // nada em voo: evento espontâneo
  if (finalized.has(f.commandId)) {           // já finalizado: silêncio
    inFlight.delete(equipmentId);
    return false;
  }
  if (running !== f.expectOn) return false;   // chegou o estado ANTIGO — segue verificando

  finalized.add(f.commandId);
  inFlight.delete(equipmentId);
  if (f.expectOn) notifyCommand.turnedOn(f.equipmentName);
  else notifyCommand.turnedOff(f.equipmentName);
  return true;
}

/** Há comando manual em voo para este equipamento? */
export function hasInFlightPumpCommand(equipmentId: string): boolean {
  return inFlight.has(equipmentId);
}

/** Este comando já foi finalizado (por sucesso ou falha)? */
export function isPumpCommandFinalized(commandId: string): boolean {
  return finalized.has(commandId);
}

/** Apenas para testes — o estado é de módulo, de propósito. */
export function __resetPumpCommandFinalizationForTests(): void {
  inFlight.clear();
  finalized.clear();
}
