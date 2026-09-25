// ─────────────────────────────────────────────────────────────────────────────
// realtimeDeliveryHealth — SUBSCRIBED não é prova de entrega
// ─────────────────────────────────────────────────────────────────────────────
// LÓGICA PURA. Sem React, sem Supabase, sem timers. Recebe fatos, devolve
// decisão. Existe para ser testada fora do navegador.
//
// O DEFEITO QUE ISTO CORRIGE
//
// `useCadastrosCloud` desligava a rede de segurança de 30 s assim que o canal
// respondia SUBSCRIBED:
//
//     if (ok) { reconnectAttempts = 0; stopDegradedSafetyNet(); … }
//
// SUBSCRIBED significa apenas que o socket abriu e o servidor aceitou os
// bindings. Não significa que algum evento vai chegar. Medido no NEW em
// 25/09/2026: a publicação `supabase_realtime` estava VAZIA — nenhuma tabela.
// Um canal nessas condições conecta e nunca entrega nada, e a tela ficava sem
// Realtime E sem rede de segurança: só atualizava ao voltar o foco da aba.
//
// A REGRA
//
// A rede de segurança só pode ser desligada depois de UM EVENTO REAL. Conexão é
// promessa; evento é prova.
//
//     CONNECTING ──SUBSCRIBED──▶ PROBATION ──evento──▶ CONNECTED
//          │                          │                    │
//          └────erro/fechado──────────┴────────────────────┘
//                          ▼
//                    RECONNECTING ──(≥ maxBeforeDegraded)──▶ DEGRADED
//
// `safetyNet` é true em tudo menos CONNECTED. Isso não cria polling agressivo:
// com Realtime funcionando, a rede desliga no primeiro evento e não volta
// enquanto o canal viver.
//
// Por que não medir "silêncio" com um timer: numa fazenda parada pode não haver
// nenhuma mudança de estado por horas, e silêncio legítimo viraria polling
// permanente — exatamente a carga que não queremos. Prova de entrega uma vez é
// suficiente para distinguir "canal mudo" de "nada aconteceu".

/** Estados expostos. Os três primeiros mapeiam nos valores que a UI já usa. */
export type DeliveryHealth = "connected" | "reconnecting" | "degraded" | "probation";

export interface DeliveryState {
  /** Saúde para o indicador da tela. */
  health: DeliveryHealth;
  /** A rede de segurança (refetch periódico) deve estar LIGADA? */
  safetyNet: boolean;
  /** Socket aceito pelo servidor. NÃO implica entrega. */
  subscribed: boolean;
  /** Pelo menos um evento real chegou neste canal. */
  deliveryProven: boolean;
  /**
   * Existe Realtime utilizável para esta fazenda?
   *
   * false é o ÚNICO caso em que a rede fica desligada sem prova de entrega, e é
   * deliberado: a fazenda tem poller dedicado. Separado de `health` porque
   * "degradado" também ocorre com Realtime utilizável mas caindo — e aí a rede
   * PRECISA estar ligada.
   */
  realtimeUsable: boolean;
  /** Tentativas de reinscrição desde a última conexão boa. */
  reconnectAttempts: number;
}

/**
 * Estado ao montar: nenhuma prova de entrega, portanto rede LIGADA.
 *
 * Custa um refetch aos 30 s no caminho saudável, até o primeiro evento provar a
 * entrega. É o mesmo custo que a tela já paga hoje (a rede degradada roda a 30 s
 * em produção) e desaparece no primeiro evento — diferente de hoje, em que
 * desligava cedo por SUBSCRIBED e nunca mais voltava.
 */
export const initialDeliveryState = (): DeliveryState => ({
  health: "reconnecting",
  safetyNet: true,
  subscribed: false,
  deliveryProven: false,
  realtimeUsable: true,
  reconnectAttempts: 0,
});

/** Status que o `subscribe()` do supabase-js pode devolver. */
export type ChannelStatus = "SUBSCRIBED" | "TIMED_OUT" | "CHANNEL_ERROR" | "CLOSED" | string;

const ERROR_STATUSES = new Set(["TIMED_OUT", "CHANNEL_ERROR", "CLOSED"]);

/**
 * Transição por mudança de status do canal.
 *
 * `maxBeforeDegraded` é o mesmo teto que o hook já usava (4) — só passa a
 * governar o rótulo, não mais o desligamento da rede.
 */
export function onChannelStatus(
  prev: DeliveryState,
  status: ChannelStatus,
  maxBeforeDegraded: number,
): DeliveryState {
  if (status === "SUBSCRIBED") {
    // PROBATION: conectado, entrega ainda NÃO provada. A rede continua ligada.
    // Se este canal já provou entrega antes (reinscrição do mesmo hook), a prova
    // não vale para o canal novo — bindings podem ter mudado.
    return {
      health: "probation",
      safetyNet: true,
      subscribed: true,
      deliveryProven: false,
      realtimeUsable: true,
      reconnectAttempts: 0,
    };
  }

  if (ERROR_STATUSES.has(status)) {
    const attempts = prev.reconnectAttempts + 1;
    return {
      health: attempts >= maxBeforeDegraded ? "degraded" : "reconnecting",
      safetyNet: true,
      subscribed: false,
      deliveryProven: false,
      realtimeUsable: true,
      reconnectAttempts: attempts,
    };
  }

  // Status desconhecido (ex.: "JOINING"): não muda nada além de não afirmar
  // entrega. Fail-safe: mantém a rede.
  return { ...prev, safetyNet: !prev.deliveryProven };
}

/**
 * Transição por EVENTO recebido. É a única forma de provar entrega e, portanto,
 * a única forma de desligar a rede de segurança.
 */
export function onChannelEvent(prev: DeliveryState): DeliveryState {
  if (prev.deliveryProven && prev.health === "connected") return prev; // idempotente
  return {
    health: "connected",
    safetyNet: false,
    subscribed: true,           // chegou evento ⇒ o canal está vivo
    deliveryProven: true,
    realtimeUsable: true,
    reconnectAttempts: 0,
  };
}

/**
 * Fazenda sem Realtime utilizável (ex.: migrada, cujo canal não representa as
 * linhas dela). Declara degradado sem ligar a rede: quem atualiza é o poller
 * dedicado, e duplicar requisição no mesmo backend não ajuda ninguém.
 */
export function onRealtimeUnavailable(): DeliveryState {
  return {
    health: "degraded",
    safetyNet: false,
    subscribed: false,
    deliveryProven: false,
    realtimeUsable: false,
    reconnectAttempts: 0,
  };
}

/** Valor para o campo `realtimeHealth` da UI, que não conhece "probation". */
export function uiHealth(s: DeliveryState): "connected" | "reconnecting" | "degraded" {
  if (s.health === "connected") return "connected";
  if (s.health === "degraded") return "degraded";
  // PROBATION aparece como "reconnecting": honesto — ainda não há prova de
  // fluxo. Dizer "connected" era justamente a mentira que escondia o defeito.
  return "reconnecting";
}
