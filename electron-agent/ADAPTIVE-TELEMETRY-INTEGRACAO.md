# Comunicação Assistida — pontos de integração no agente

O escalonador vive em `electron-agent/adaptiveTelemetry.cjs`, módulo **puro**
(sem serial, sem Supabase, sem frame). O agente só o consulta. Isso mantém a
lógica testável e limita o toque em `main.cjs` a quatro pontos pequenos.

**Nenhuma alteração foi aplicada em `main.cjs`.** O patch abaixo é a proposta,
para você revisar antes de qualquer bump.

## Versão

`electron-agent/package.json`: `3.25.66` → **`3.25.67`** (piloto). Só a Sykue
recebe target dessa versão, e somente após aprovação explícita.

## Ponto 1 — carregar quem está ativado

Onde o agente já lê `equipments` da fazenda, incluir as colunas novas:

```js
.select("... , adaptive_telemetry_enabled, adaptive_telemetry_profile")
```

Poço com `adaptive_telemetry_enabled !== true` **não entra** na lista passada ao
escalonador. Toda a frota fora do piloto segue o ciclo atual sem desvio.

## Ponto 2 — estado por poço (memória, não disco)

```js
const ADAPT = require("./adaptiveTelemetry.cjs");
const adaptState = new Map();   // equipmentId -> { lastReplyAt, normalsSinceRetry, ... }
let ultimoRetryEquipmentId = null;
let retriesNaRodada = 0;
```

`lastReplyAt` é alimentado **apenas** por RX físico válido — nunca pelo horário
do TX. É essa distinção que faz o poço mudo ser detectado.

## Ponto 3 — encaixe após cada leitura normal bem-sucedida

Logo após o agente concluir uma leitura normal (o mesmo lugar onde hoje ele
segue para o próximo PLC da rodada):

```js
for (const [id, st] of adaptState) adaptState.set(id, ADAPT.registrarLeituraNormal(st));

const d = ADAPT.decidirProximoRetry({
  agora: Date.now(),
  assistidos: [...adaptState.entries()].map(([id, st]) => ({ id, ...st })),
  rxEmProcessamento: isProcessingRxFrame(),
  txPendente: txQueue.length > 0,
  janelaSilencio: isSpontaneousTxWindowOpen(),
  msDesdeUltimoTx: Date.now() - lastTxTimestamp,
  msDesdeUltimoRx: Date.now() - lastRxTimestamp,
  txMinGapMs: TX_MIN_GAP_MS,      // 3000, inalterado
  rxAvoidGapMs: RX_AVOID_GAP_MS,  // 2000, inalterado
  txNaRodada, retriesNaRodada, txPrevistosNaRodada,
  ultimoRetryEquipmentId,
});

if (d.enviar) {
  // MESMO frame de polling já usado hoje. Nada de comando, nada de relé.
  enqueuePollingFrameFor(d.equipmentId);
  adaptState.set(d.equipmentId, ADAPT.registrarRetry(adaptState.get(d.equipmentId), Date.now()));
  ultimoRetryEquipmentId = d.equipmentId;
  retriesNaRodada++;
}
logAdaptiveDecision(d);   // sempre, inclusive quando não envia
```

O retry é **encaixado**, nunca substitui a leitura normal: a decisão acontece
*depois* de a leitura normal já ter sido despachada.

## Ponto 4 — RX físico válido

Onde o agente processa um frame de telemetria válido:

```js
adaptState.set(eqId, ADAPT.registrarRespostaFisica(adaptState.get(eqId), Date.now()));
```

Isso zera falhas e devolve o poço ao Normal na hora (regra 7).

## Log técnico

`logAdaptiveDecision` faz INSERT em `adaptive_telemetry_log` com
`equipment_id`, `risk_band`, `reason`, `attempt_sent`, `outcome`,
`seconds_since_reply`, `budget_used_pct`, `had_pending_command` e
`agent_version`. Sem log local. Sem WhatsApp por retry — os alertas existentes
não mudam.

## Reinício da rodada

No início de cada rodada de polling: `retriesNaRodada = 0`. O
`ultimoRetryEquipmentId` **não** é zerado — é ele que impede dois retries
seguidos do mesmo poço na virada da rodada.

## Rollback

`UPDATE public.equipments SET adaptive_telemetry_enabled = false;` devolve toda
a frota ao ciclo atual na hora, sem OTA e sem reiniciar o agente.
