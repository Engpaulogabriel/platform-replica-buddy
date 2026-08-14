// @vitest-environment node
// As 9 regras inegociáveis da fila adaptativa, provadas de forma determinística.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
const require_ = createRequire(import.meta.url);
const S = require_(path.resolve(__dirname, "../../electron-agent/adaptiveTelemetry.cjs"));

const MIN = 60_000;
const AGORA = 1_760_000_000_000;

/** contexto de rodada saudável: nada bloqueando a transmissão */
const ctx = (over: Record<string, unknown> = {}) => ({
  agora: AGORA,
  assistidos: [],
  rxEmProcessamento: false, txPendente: false, janelaSilencio: false,
  msDesdeUltimoTx: 10_000, msDesdeUltimoRx: 10_000,
  txMinGapMs: 3000, rxAvoidGapMs: 2000,
  txNaRodada: 10, retriesNaRodada: 0, txPrevistosNaRodada: 20,
  ultimoRetryEquipmentId: null,
  ...over,
});

/** poço assistido, com N leituras normais desde o último retry */
const poco = (id: string, minSemResposta: number, over: Record<string, unknown> = {}) => ({
  id, farmId: "sykue", enabled: true,
  lastReplyAt: AGORA - minSemResposta * MIN,
  normalsSinceRetry: 99, lastRetryAt: 0, pendingCommand: false,
  ...over,
});

describe("1. função desligada mantém o ciclo atual", () => {
  it("poço com enabled=false nunca é candidato, mesmo em 14 min", () => {
    const d = S.decidirProximoRetry(ctx({ assistidos: [poco("p2", 14, { enabled: false })] }));
    expect(d.enviar).toBe(false);
    expect(d.motivo).toBe("sem_candidato");
  });

  it("lista vazia (frota inteira fora do piloto) não gera nada", () => {
    expect(S.decidirProximoRetry(ctx()).enviar).toBe(false);
  });
});

describe("2. escalonamento por idade da última RESPOSTA física", () => {
  it("as quatro faixas caem onde devem", () => {
    expect(S.classificarFaixa(5 * MIN)).toBe("normal");
    expect(S.classificarFaixa(8 * MIN)).toBe("attention");
    expect(S.classificarFaixa(11 * MIN)).toBe("recovery");
    expect(S.classificarFaixa(13 * MIN)).toBe("critical");
    expect(S.classificarFaixa(15 * MIN)).toBe("offline");
    expect(S.classificarFaixa(40 * MIN)).toBe("offline");
  });

  it("o encaixe aperta conforme piora: 3 → 2 → 1 leituras normais", () => {
    expect(S.normaisEntreRetries("attention")).toBe(3);
    expect(S.normaisEntreRetries("recovery")).toBe(2);
    expect(S.normaisEntreRetries("critical")).toBe(1);
    expect(S.normaisEntreRetries("normal")).toBe(Infinity);
  });

  it("offline real continua tentando no ritmo crítico", () => {
    const d = S.decidirProximoRetry(ctx({ assistidos: [poco("p2", 20)] }));
    expect(d.enviar).toBe(true);
    expect(d.faixa).toBe("offline");
  });

  it("Poço 02 em 8, 11, 13 e 15 min recebe a faixa correta", () => {
    for (const [min, faixa] of [[8,"attention"],[11,"recovery"],[13,"critical"],[15,"offline"]] as const) {
      const d = S.decidirProximoRetry(ctx({ assistidos: [poco("p2", min)] }));
      expect(d.faixa, `${min} min`).toBe(faixa);
    }
  });

  it("em Atenção, 2 leituras normais ainda NÃO liberam o retry (precisa de 3)", () => {
    const d = S.decidirProximoRetry(ctx({ assistidos: [poco("p2", 9, { normalsSinceRetry: 2 })] }));
    expect(d.enviar).toBe(false);
  });
});

describe("3. o poço ruim não atrasa ninguém e não substitui leitura normal", () => {
  it("a decisão é sempre sobre ENCAIXE — nunca devolve 'pule o próximo poço'", () => {
    const d = S.decidirProximoRetry(ctx({ assistidos: [poco("p2", 14)] }));
    // o contrato só tem enviar/equipmentId: não existe forma de suprimir outro poço
    expect(Object.keys(d).sort()).toEqual(
      ["enviar","equipmentId","faixa","motivo","orcamentoUsadoPct"]);
  });

  it("sequência real: 01 → 02 falha → 03 → 04 → retry 02 → 05 → 06 → retry 02 → 07", () => {
    const normais = ["p1","p3","p4","p5","p6","p7"];
    let estado = poco("p2", 12, { normalsSinceRetry: 0 });   // Recuperação: 2 normais
    let ultimoRetry: string | null = null;
    const linha: string[] = [];

    for (const n of normais) {
      linha.push(n);
      estado = S.registrarLeituraNormal(estado);
      const d = S.decidirProximoRetry(ctx({
        assistidos: [estado], ultimoRetryEquipmentId: ultimoRetry,
      }));
      if (d.enviar) {
        linha.push(`retry:${d.equipmentId}`);
        estado = S.registrarRetry(estado, AGORA);
        ultimoRetry = null;    // a próxima leitura normal reabre a alternância
      }
    }
    expect(linha).toEqual([
      "p1","p3","retry:p2","p4","p5","retry:p2","p6","p7","retry:p2",
    ]);
    // nenhum poço normal foi removido da rodada
    expect(linha.filter((x) => !x.startsWith("retry:"))).toEqual(normais);
  });
});

describe("4. nunca dois retries consecutivos do mesmo poço", () => {
  it("o poço que acabou de tentar é excluído da rodada seguinte", () => {
    const p2 = poco("p2", 14, { normalsSinceRetry: 5 });
    const d = S.decidirProximoRetry(ctx({ assistidos: [p2], ultimoRetryEquipmentId: "p2" }));
    expect(d.enviar).toBe(false);
  });

  it("depois de um retry o contador de encaixe zera", () => {
    const depois = S.registrarRetry(poco("p2", 14, { normalsSinceRetry: 9 }), AGORA);
    expect(depois.normalsSinceRetry).toBe(0);
    expect(S.decidirProximoRetry(ctx({ assistidos: [depois] })).enviar).toBe(false);
  });
});

describe("5. intervalo seguro e janela de RX/TX espontâneo são invioláveis", () => {
  const p2 = [poco("p2", 14)];
  it("RX em processamento bloqueia", () =>
    expect(S.decidirProximoRetry(ctx({ assistidos: p2, rxEmProcessamento: true })).motivo)
      .toBe("rx_em_processamento"));
  it("TX pendente bloqueia", () =>
    expect(S.decidirProximoRetry(ctx({ assistidos: p2, txPendente: true })).motivo)
      .toBe("tx_pendente"));
  it("janela de TX espontâneo bloqueia", () =>
    expect(S.decidirProximoRetry(ctx({ assistidos: p2, janelaSilencio: true })).motivo)
      .toBe("janela_tx_espontaneo"));
  it("intervalo mínimo entre TX é respeitado (não encurta para 3s arbitrário)", () =>
    expect(S.decidirProximoRetry(ctx({ assistidos: p2, msDesdeUltimoTx: 2999 })).motivo)
      .toBe("intervalo_tx"));
  it("janela de guarda após RX é respeitada", () =>
    expect(S.decidirProximoRetry(ctx({ assistidos: p2, msDesdeUltimoRx: 1999 })).motivo)
      .toBe("janela_rx"));
});

describe("6. orçamento conservador de 20%", () => {
  it("no teto, os poços normais têm prioridade", () => {
    const d = S.decidirProximoRetry(ctx({
      assistidos: [poco("p2", 14)], retriesNaRodada: 4, txPrevistosNaRodada: 20,
    }));
    expect(d.enviar).toBe(false);
    expect(d.motivo).toBe("orcamento_esgotado");
    expect(d.orcamentoUsadoPct).toBe(20);
  });

  it("abaixo do teto, o retry passa", () => {
    const d = S.decidirProximoRetry(ctx({
      assistidos: [poco("p2", 14)], retriesNaRodada: 3, txPrevistosNaRodada: 20,
    }));
    expect(d.enviar).toBe(true);
    expect(d.orcamentoUsadoPct).toBe(15);
  });
});

describe("7. resposta física encerra a prioridade na hora", () => {
  it("zera falhas, sai de Crítico e volta ao Normal", () => {
    const antes = S.registrarFalha(S.registrarFalha(poco("p2", 14)));
    expect(antes.consecutiveFailures).toBe(2);
    const depois = S.registrarRespostaFisica(antes, AGORA);
    expect(depois.consecutiveFailures).toBe(0);
    expect(S.classificarFaixa(AGORA - depois.lastReplyAt)).toBe("normal");
    expect(S.decidirProximoRetry(ctx({ assistidos: [depois] })).enviar).toBe(false);
  });
});

describe("8. dois poços assistidos dividem o rádio com justiça", () => {
  it("alternam; nenhum monopoliza", () => {
    let a = poco("p02", 14, { normalsSinceRetry: 0, lastRetryAt: 0 });
    let b = poco("p14", 14, { normalsSinceRetry: 0, lastRetryAt: 0 });
    let ultimo: string | null = null;
    const ordem: string[] = [];

    for (let i = 0; i < 6; i++) {
      a = S.registrarLeituraNormal(a); b = S.registrarLeituraNormal(b);
      const d = S.decidirProximoRetry(ctx({
        assistidos: [a, b], ultimoRetryEquipmentId: ultimo, agora: AGORA + i,
      }));
      if (!d.enviar) continue;
      ordem.push(d.equipmentId);
      if (d.equipmentId === "p02") a = S.registrarRetry(a, AGORA + i);
      else                          b = S.registrarRetry(b, AGORA + i);
      ultimo = d.equipmentId;
    }
    expect(ordem.length).toBeGreaterThanOrEqual(4);
    // alternância estrita: nunca o mesmo duas vezes seguidas
    for (let i = 1; i < ordem.length; i++) expect(ordem[i]).not.toBe(ordem[i - 1]);
    const p02 = ordem.filter((x) => x === "p02").length;
    expect(Math.abs(p02 - (ordem.length - p02))).toBeLessThanOrEqual(1);
  });
});

describe("9. retry é LEITURA — nunca aciona relé", () => {
  it("a decisão não tem campo de comando nem de estado desejado", () => {
    const d = S.decidirProximoRetry(ctx({ assistidos: [poco("p2", 14)] }));
    const chaves = JSON.stringify(d).toLowerCase();
    for (const proibido of ["turn_on","turn_off","desired","relay","rele","frame","ligar","desligar"])
      expect(chaves).not.toContain(proibido);
  });

  it("comando remoto pendente muda só a PRIORIDADE, não o tipo de ação", () => {
    const d = S.decidirProximoRetry(ctx({
      assistidos: [poco("p2", 9, { pendingCommand: true })],
    }));
    expect(d.enviar).toBe(true);
    expect(d.motivo).toBe("confirmacao_comando_prioritaria");
    expect(d.faixa).toBe("attention");
  });

  it("confirmação prioritária não altera as faixas nem os intervalos", () => {
    const comCmd = S.decidirProximoRetry(ctx({
      assistidos: [poco("p2", 14, { pendingCommand: true })], msDesdeUltimoTx: 2999 }));
    expect(comCmd.enviar).toBe(false);          // intervalo continua valendo
    expect(comCmd.motivo).toBe("intervalo_tx");
  });
});

describe("12. a regra de Offline de 15 min não é tocada", () => {
  it("o escalonador nunca antecipa nem adia o Offline", () => {
    expect(S.classificarFaixa(14.9 * MIN)).toBe("critical");
    expect(S.classificarFaixa(15 * MIN)).toBe("offline");
    // e continua tentando depois disso, sem mudar o que a tela mostra
    expect(S.decidirProximoRetry(ctx({ assistidos: [poco("p2", 30)] })).enviar).toBe(true);
  });
});
