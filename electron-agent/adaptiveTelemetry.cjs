// ─────────────────────────────────────────────────────────────────────────────
// COMUNICAÇÃO ASSISTIDA — escalonador de LEITURA por poço.
//
// Módulo PURO: não abre serial, não fala com o Supabase, não conhece frame nem
// rádio. Recebe um retrato da rodada e devolve uma decisão. É assim que as
// regras da fila viram teste determinístico em vez de promessa.
//
// O que ele NUNCA faz, por construção:
//   • emitir Ligar/Desligar ou tocar desired_running — só existe leitura aqui;
//   • substituir uma leitura normal por um retry;
//   • devolver dois retries seguidos do mesmo poço;
//   • transmitir com RX em processamento, TX pendente ou silêncio obrigatório;
//   • encostar em poço com a função desligada.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

/** Faixas do perfil conservador. Espelham adaptive_telemetry_profiles. */
const PERFIL_CONSERVADOR = Object.freeze({
  attentionMin: 8, recoveryMin: 11, criticalMin: 13, offlineMin: 15,
  normalsAttention: 3, normalsRecovery: 2, normalsCritical: 1,
  retryBudgetPct: 20,
});

/**
 * Faixa de risco pela idade da ÚLTIMA RESPOSTA FÍSICA VÁLIDA.
 * Nunca pelo horário do último comando transmitido — é essa a diferença que
 * fazia um poço "recente" no TX parecer saudável enquanto não respondia.
 */
function classificarFaixa(msSemResposta, perfil = PERFIL_CONSERVADOR) {
  const min = msSemResposta / 60000;
  if (min >= perfil.offlineMin) return "offline";
  if (min >= perfil.criticalMin) return "critical";
  if (min >= perfil.recoveryMin) return "recovery";
  if (min >= perfil.attentionMin) return "attention";
  return "normal";
}

/** Quantas leituras normais bem-sucedidas devem separar dois retries. */
function normaisEntreRetries(faixa, perfil = PERFIL_CONSERVADOR) {
  switch (faixa) {
    case "attention": return perfil.normalsAttention;
    case "recovery":  return perfil.normalsRecovery;
    case "critical":  return perfil.normalsCritical;
    // Offline real: mantém o card Offline pela regra atual, mas segue tentando
    // no ritmo crítico até recuperar.
    case "offline":   return perfil.normalsCritical;
    default:          return Infinity;   // Normal não gera retry
  }
}

/**
 * Decide se cabe UM retry adaptativo agora, e de qual poço.
 *
 * @param {object} ctx
 *  @param {number} ctx.agora                     epoch ms
 *  @param {Array}  ctx.assistidos                [{ id, farmId, enabled, lastReplyAt,
 *                                                   normalsSinceRetry, lastRetryAt,
 *                                                   pendingCommand }]
 *  @param {boolean} ctx.rxEmProcessamento        frame chegando
 *  @param {boolean} ctx.txPendente               comando em transmissão
 *  @param {boolean} ctx.janelaSilencio           janela de TX espontâneo aberta
 *  @param {number}  ctx.msDesdeUltimoTx
 *  @param {number}  ctx.msDesdeUltimoRx
 *  @param {number}  ctx.txMinGapMs               intervalo seguro existente (não reduzir)
 *  @param {number}  ctx.rxAvoidGapMs
 *  @param {number}  ctx.txNaRodada               transmissões já feitas na rodada
 *  @param {number}  ctx.retriesNaRodada          retries adaptativos já feitos
 *  @param {number}  ctx.txPrevistosNaRodada      tamanho previsto da rodada
 *  @param {string}  ctx.ultimoRetryEquipmentId   para alternância justa
 *  @param {object}  [ctx.perfil]
 * @returns {{ enviar: boolean, equipmentId: string|null, faixa: string,
 *             motivo: string, orcamentoUsadoPct: number }}
 */
function decidirProximoRetry(ctx) {
  const perfil = ctx.perfil || PERFIL_CONSERVADOR;
  const nada = (motivo, faixa = "normal") => ({
    enviar: false, equipmentId: null, faixa, motivo,
    orcamentoUsadoPct: orcamentoPct(ctx),
  });

  // ── Regra 5: nunca transmitir por cima de RX, TX ou silêncio obrigatório ──
  if (ctx.rxEmProcessamento) return nada("rx_em_processamento");
  if (ctx.txPendente)        return nada("tx_pendente");
  if (ctx.janelaSilencio)    return nada("janela_tx_espontaneo");

  // ── Regra 4: respeitar integralmente os intervalos que já existem ────────
  if (ctx.msDesdeUltimoTx < ctx.txMinGapMs)   return nada("intervalo_tx");
  if (ctx.msDesdeUltimoRx < ctx.rxAvoidGapMs) return nada("janela_rx");

  // ── Regra 6: orçamento conservador. Estourou, normais têm prioridade ─────
  const usado = orcamentoPct(ctx);
  if (usado >= perfil.retryBudgetPct) return nada("orcamento_esgotado");

  // Candidatos: só poços ATIVADOS e fora da faixa normal.
  const candidatos = (ctx.assistidos || [])
    .filter((e) => e.enabled)
    .map((e) => ({
      ...e,
      faixa: classificarFaixa(ctx.agora - (e.lastReplyAt ?? 0), perfil),
    }))
    .filter((e) => e.faixa !== "normal")
    // ── Regra 3: retry só se ENCAIXA entre leituras normais ───────────────
    .filter((e) => e.normalsSinceRetry >= normaisEntreRetries(e.faixa, perfil))
    // ── Regra 2: nunca dois retries consecutivos do mesmo poço ────────────
    .filter((e) => e.id !== ctx.ultimoRetryEquipmentId);

  if (candidatos.length === 0) return nada("sem_candidato");

  // ── Regra 8: alternância justa. Mais antigo sem retry primeiro; empate
  //    desempata pela maior idade sem resposta.
  candidatos.sort((a, b) => {
    const ra = a.lastRetryAt ?? 0, rb = b.lastRetryAt ?? 0;
    if (ra !== rb) return ra - rb;
    return (a.lastReplyAt ?? 0) - (b.lastReplyAt ?? 0);
  });

  const alvo = candidatos[0];
  return {
    enviar: true,
    equipmentId: alvo.id,
    faixa: alvo.faixa,
    // ── Regra 9 fica explícita no motivo: é leitura, nunca acionamento ────
    motivo: alvo.pendingCommand ? "confirmacao_comando_prioritaria" : `retry_leitura_${alvo.faixa}`,
    orcamentoUsadoPct: usado,
  };
}

function orcamentoPct(ctx) {
  const total = Math.max(1, ctx.txPrevistosNaRodada || ctx.txNaRodada || 1);
  return Math.round(((ctx.retriesNaRodada || 0) / total) * 100);
}

/**
 * Atualiza o estado do poço depois de uma leitura NORMAL bem-sucedida.
 * É o que "abre" a próxima janela de encaixe (regra 3).
 */
function registrarLeituraNormal(estado) {
  return { ...estado, normalsSinceRetry: (estado.normalsSinceRetry || 0) + 1 };
}

/** Depois de um retry: zera o contador de encaixe e marca o horário. */
function registrarRetry(estado, agora) {
  return { ...estado, normalsSinceRetry: 0, lastRetryAt: agora };
}

/**
 * Regra 7: resposta física válida zera tudo e devolve o poço ao ciclo normal
 * imediatamente — sem esperar a rodada terminar.
 */
function registrarRespostaFisica(estado, agora) {
  return {
    ...estado,
    lastReplyAt: agora,
    consecutiveFailures: 0,
    normalsSinceRetry: 0,
    lastRetryAt: estado.lastRetryAt ?? null,
  };
}

function registrarFalha(estado) {
  return { ...estado, consecutiveFailures: (estado.consecutiveFailures || 0) + 1 };
}

module.exports = {
  PERFIL_CONSERVADOR,
  classificarFaixa,
  normaisEntreRetries,
  decidirProximoRetry,
  registrarLeituraNormal,
  registrarRetry,
  registrarRespostaFisica,
  registrarFalha,
};
