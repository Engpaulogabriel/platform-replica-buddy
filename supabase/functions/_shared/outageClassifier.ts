// _shared/outageClassifier.ts — classificação de perda simultânea de comunicação.
// ---------------------------------------------------------------------------
// A regra antiga chamava de "Possível falta de energia" qualquer caso de 4+
// poços cuja `last_communication` caísse na mesma janela de 60s. Isso descreve
// igualmente bem agente offline, bridge travada, internet caída e rádio ruim —
// nenhum deles é energia. Perda simultânea de comunicação é, aliás, MAIS
// compatível com falha de ponto único do que com blecaute.
//
// PRINCÍPIO: falta de comunicação nunca é prova de energia. Só há "indício de
// energia" quando VÁRIAS BOMBAS QUE ESTAVAM LIGADAS foram lidas como DESLIGADAS
// em sequência curta, sem comando que as explique.
//
// Módulo PURO: sem rede, sem Deno, sem Supabase. É isso que torna as seis
// classificações testáveis de verdade.

export type IncidentType =
  | "agent_offline"        // sem heartbeat do agente
  | "bridge_down"          // agente vivo, bridge sem RX/TX ou inativa
  | "rf_degraded"          // agente e bridge vivos, só parte dos poços muda
  | "indeterminate"        // vários poços mudos, evidência insuficiente
  | "power_suspected"      // transições OFF físicas múltiplas, sem comando
  | "power_confirmed";     // sensor físico de energia confirma

export const INCIDENT_TITLE: Record<IncidentType, string> = {
  agent_offline:   "Conexão agente-servidor interrompida",
  bridge_down:     "Bridge serial indisponível",
  rf_degraded:     "Comunicação RF degradada",
  indeterminate:   "Comunicação simultânea interrompida — causa indeterminada",
  power_suspected: "Possível falta de energia",
  power_confirmed: "Queda de energia confirmada",
};

/**
 * Um desligamento FÍSICO CONFIRMADO de bomba: leitura anterior dizia LIGADO,
 * a leitura seguinte diz DESLIGADO.
 *
 * Quem produz essa lista é o trigger `log_equipment_state_change`, que já
 * garante, ANTES de gravar a linha em `automation_log`:
 *   • `type IN ('poco','bombeamento')`  → nível/repetidor/sensor não entram;
 *   • o bit de `last_outputs_state` REALMENTE mudou de '1' para '0';
 *   • `origin <> 'remote'`;
 *   • não há comando manual/automação para a bomba nos 120s anteriores.
 * Por isso `origin='reading' AND action='turn_off'` é exatamente
 * "bomba desligou sozinha". Perder comunicação NÃO gera linha alguma, porque
 * `last_outputs_state` não é tocado quando nada é recebido.
 */
export interface PumpOffTransition {
  equipmentId: string;
  /** epoch ms da leitura que confirmou o DESLIGADO. */
  atMs: number;
}

/** Limiares conservadores. Mexer aqui muda a política sem tocar no resto. */
export const THRESHOLDS = {
  agentDeadMs: 5 * 60_000,      // sem heartbeat há 5 min = agente fora
  bridgeIdleMs: 5 * 60_000,     // bridge sem RX/TX há 5 min = suspeita
  rfPartialMax: 0.7,            // até 70% dos poços = parcial (RF), não geral
  // Os dois abaixo NÃO são valores novos: são os mesmos `BLACKOUT_MIN_EQUIPS`
  // e `BLACKOUT_WINDOW_S` que a regra antiga já usava em critical-alerts-tick.
  // O que muda é O QUE eles contam — antes, equipamentos que emudeceram; agora,
  // bombas distintas que foram lidas como desligadas.
  powerMinPumps: 4,
  powerWindowMs: 60_000,
};

export interface PowerPattern {
  /** o padrão compatível com queda de energia se sustenta? */
  qualifies: boolean;
  /** maior nº de BOMBAS DISTINTAS desligadas dentro de uma mesma janela. */
  pumps: number;
  /** duração da melhor janela encontrada, em ms. */
  spanMs: number;
  /** epoch ms do primeiro desligamento dessa janela. */
  startedAtMs: number | null;
}

/**
 * Janela deslizante sobre os desligamentos confirmados. Procura o maior número
 * de BOMBAS DISTINTAS que desligaram dentro de `windowMs`.
 *
 * Distintas importa: três leituras repetidas da mesma bomba não são três
 * bombas. Sequência importa: o padrão de blecaute é A, B, C, D em poucos
 * segundos — não quatro desligamentos espalhados pela manhã.
 */
export function detectPowerPattern(
  transitions: PumpOffTransition[],
  minPumps: number = THRESHOLDS.powerMinPumps,
  windowMs: number = THRESHOLDS.powerWindowMs,
): PowerPattern {
  const vazio: PowerPattern = { qualifies: false, pumps: 0, spanMs: 0, startedAtMs: null };
  if (!transitions || transitions.length === 0) return vazio;

  const ord = [...transitions].sort((a, b) => a.atMs - b.atMs);
  let melhor = vazio;

  for (let i = 0; i < ord.length; i++) {
    const ini = ord[i].atMs;
    const bombas = new Set<string>();
    let fim = ini;
    for (let j = i; j < ord.length && ord[j].atMs - ini <= windowMs; j++) {
      bombas.add(ord[j].equipmentId);
      fim = ord[j].atMs;
    }
    if (bombas.size > melhor.pumps) {
      melhor = { qualifies: bombas.size >= minPumps, pumps: bombas.size,
                 spanMs: fim - ini, startedAtMs: ini };
    }
  }
  return melhor;
}

export interface OutageEvidence {
  /** ms desde o último heartbeat do agente. Infinity = nunca/sem dado. */
  agentHeartbeatAgeMs: number;
  /** `site_health.com_connected`. */
  bridgeConnected: boolean;
  /** ms desde o último RX/TX da bridge, quando houver. */
  bridgeIoAgeMs?: number;
  /** poços da fazenda que estão ativos. */
  totalEquipments: number;
  /** poços cuja comunicação caiu na janela. */
  affectedEquipments: number;
  /**
   * Desligamentos FÍSICOS CONFIRMADOS de bomba, não comandados, na janela.
   * Lista — não contagem: a sequência temporal faz parte do critério.
   */
  confirmedPumpOffs: PumpOffTransition[];
  /** existe comando remoto ou automação que explique os desligamentos? */
  hasCompatibleCommandOrAutomation: boolean;
  /** sensor físico de energia, quando existir. `null` = sem sensor. */
  powerSensorDown?: boolean | null;
}

export interface Classification {
  type: IncidentType;
  title: string;
  confidence: "alta" | "media" | "baixa";
  reason: string;
  /** o que a janela deslizante encontrou — para auditoria do alerta. */
  power: PowerPattern;
}

/**
 * Ordem deliberada.
 *
 * TRANSIÇÃO FÍSICA VEM ANTES DE INFRAESTRUTURA. Um blecaute real desliga as
 * bombas E derruba o PC do agente; se `agent_offline` tivesse precedência, o
 * caso verdadeiro de energia seria sempre reclassificado como problema de
 * agente. As transições já foram observadas e gravadas ANTES da queda — elas
 * são evidência positiva, e evidência positiva ganha de ausência de sinal.
 *
 * Abaixo disso, as causas de INFRAESTRUTURA explicam a perda sem envolver
 * energia. Silêncio, sozinho, nunca vira energia.
 */
export function classifyOutage(ev: OutageEvidence): Classification {
  const power = detectPowerPattern(ev.confirmedPumpOffs ?? []);

  // Sensor físico manda em tudo — é a única evidência direta de energia.
  if (ev.powerSensorDown === true) {
    return { type: "power_confirmed", title: INCIDENT_TITLE.power_confirmed,
             confidence: "alta", reason: "sensor físico de energia acusou queda", power };
  }

  // Indício de energia exige TRANSIÇÃO FÍSICA de várias bombas em sequência
  // curta, e nenhum comando/automação que as explique.
  if (power.qualifies && !ev.hasCompatibleCommandOrAutomation) {
    const seg = Math.max(1, Math.round(power.spanMs / 1000));
    return { type: "power_suspected", title: INCIDENT_TITLE.power_suspected,
             confidence: "media",
             reason: `${power.pumps} bombas desligaram sozinhas em ${seg}s, sem comando ou automação`,
             power };
  }

  // Agente fora: o servidor não fala com o PC. Nada abaixo é observável.
  if (ev.agentHeartbeatAgeMs >= THRESHOLDS.agentDeadMs) {
    return { type: "agent_offline", title: INCIDENT_TITLE.agent_offline,
             confidence: "alta", reason: "sem heartbeat do agente na janela", power };
  }

  // Agente vivo, mas a porta serial não responde.
  if (!ev.bridgeConnected ||
      (ev.bridgeIoAgeMs !== undefined && ev.bridgeIoAgeMs >= THRESHOLDS.bridgeIdleMs)) {
    return { type: "bridge_down", title: INCIDENT_TITLE.bridge_down,
             confidence: "alta", reason: "agente vivo, bridge inativa ou sem RX/TX", power };
  }

  // Só uma parte da fazenda emudeceu: cheira a rádio, não a energia.
  const fracao = ev.totalEquipments > 0
    ? ev.affectedEquipments / ev.totalEquipments : 1;
  if (fracao <= THRESHOLDS.rfPartialMax) {
    return { type: "rf_degraded", title: INCIDENT_TITLE.rf_degraded,
             confidence: "media",
             reason: `${ev.affectedEquipments} de ${ev.totalEquipments} poços sem resposta`,
             power };
  }

  // Vários poços mudos, agente e bridge vivos, nenhuma transição física.
  // Isso NÃO é energia — é indeterminado, e assim deve ser dito.
  return { type: "indeterminate", title: INCIDENT_TITLE.indeterminate,
           confidence: "baixa",
           reason: "perda simultânea de comunicação sem evidência física de causa",
           power };
}

/**
 * Chave determinística do incidente. Substitui o `crypto.randomUUID()` que
 * fazia o mesmo evento virar um alerta novo a cada 5 minutos, para sempre.
 * Formato: `<farm_id>:<tipo>:<bucket de início>`.
 *
 * O chamador converte isto em UUID (a coluna `farm_notifications.source_ref` é
 * uuid) com o `uuidFromString()` que já existe em critical-alerts-tick.
 */
export function incidentRef(farmId: string, type: IncidentType, startedAtMs: number,
                            bucketMinutes = 30): string {
  const bucket = Math.floor(startedAtMs / (bucketMinutes * 60_000));
  return `${farmId}:${type}:${bucket}`;
}

/** Mensagem de recuperação, com o que o operador precisa saber. */
export function recoveryMessage(c: Classification, startedAtMs: number,
                                endedAtMs: number, pocos: string[]): string {
  const min = Math.max(1, Math.round((endedAtMs - startedAtMs) / 60_000));
  return `Comunicação restabelecida. Causa classificada: ${c.title}. ` +
         `Duração: ${min} min. Poços afetados: ${pocos.length}` +
         (pocos.length ? ` (${pocos.join(", ")})` : "") + ".";
}
