// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// Caminho REAL do comando físico — testes de integração
// ─────────────────────────────────────────────────────────────────────────────
// Escritos ANTES da correção, de propósito, para falharem contra a v10 e só
// então serem usados como prova. Os testes anteriores — 156 verdes — não
// impediram três bugs porque procuravam strings no arquivo e executavam
// helpers puros. Um deles chegou a afirmar que a desambiguação existia, e
// existia mesmo: dentro de `createAutomacaoFromText`, função que nenhuma
// mensagem de comando alcança.
//
// Aqui a mensagem entra por `processMessage` e atravessa parser, pendência,
// handleParsedFlow, resolução de fazenda e de equipamento. Só infraestrutura
// é falsificada.

import { describe, it, expect } from "vitest";
import {
  enviarMensagem, bancoDeTeste, comandosCriados, pendenciasCriadas, juntou,
  urlsInesperadas,
} from "./helpers/whatsappHarness";

const pediuFazenda = (t: string) =>
  /em qual fazenda|qual fazenda/i.test(t);

describe("TEST A — 'Desligar Poço 11' sem fazenda", () => {
  it("não escolhe a fazenda padrão: pergunta qual, e não cria nada", async () => {
    const r = await enviarMensagem({ texto: "Desligar Poço 11", banco: bancoDeTeste() });
    const txt = juntou(r);

    expect(pediuFazenda(txt)).toBe(true);
    // as três fazendas com Poço 11 precisam ser oferecidas
    expect(txt).toMatch(/Semear/);
    expect(txt).toMatch(/Sykue/);
    expect(txt).toMatch(/Terra Norte/);
    // e nenhuma confirmação física pode ter sido aberta
    expect(txt).not.toMatch(/Confirmar comando/);
    expect(pendenciasCriadas(r)).toHaveLength(0);
    expect(comandosCriados(r)).toHaveLength(0);
  });
});

describe("TEST B — 'Desligar Poço 11 Semear'", () => {
  it("resolve Semear, abre confirmação nomeando a fazenda, sem comando", async () => {
    const r = await enviarMensagem({ texto: "Desligar Poço 11 Semear", banco: bancoDeTeste() });
    const txt = juntou(r);

    expect(txt).toMatch(/Confirmar comando/);
    expect(txt).toMatch(/Fazenda:\s*Semear/);
    expect(txt).toMatch(/POÇO 11 R4/);
    expect(txt).not.toMatch(/Terra Norte/);

    const pend = pendenciasCriadas(r);
    expect(pend).toHaveLength(1);
    expect(pend[0].linhas[0].farm_id).toBe("f-semear");
    expect(pend[0].linhas[0].equipment_id).toBe("e-semear-11");
    expect(pend[0].linhas[0].action_type).toBe("desliga");
    expect(comandosCriados(r)).toHaveLength(0);
  });
});

describe("TEST C — 'desligar todas' sem fazenda", () => {
  it("não trata 'todas' como equipamento e pergunta a fazenda", async () => {
    const r = await enviarMensagem({ texto: "desligar todas", banco: bancoDeTeste() });
    const txt = juntou(r);

    expect(txt).not.toMatch(/Equipamento "todas" não encontrado/);
    expect(pediuFazenda(txt)).toBe(true);
    expect(pendenciasCriadas(r)).toHaveLength(0);
    expect(comandosCriados(r)).toHaveLength(0);
  });
});

describe("TEST D — 'desligar todas semear'", () => {
  it("reconhece lote, usa Semear e abre confirmação com os alvos", async () => {
    const r = await enviarMensagem({ texto: "desligar todas semear", banco: bancoDeTeste() });
    const txt = juntou(r);

    expect(txt).not.toMatch(/não encontrado/);
    expect(txt).toMatch(/Fazenda:\s*Semear/);
    expect(txt).toMatch(/Confirmar comando/);

    const pend = pendenciasCriadas(r);
    expect(pend.length).toBeGreaterThan(0);
    const linhas = pend.flatMap((p: any) => p.linhas);
    // só equipamentos da Semear, nenhum de outra fazenda
    for (const l of linhas) expect(l.farm_id).toBe("f-semear");
    expect(linhas.every((l: any) => String(l.equipment_id).startsWith("e-semear"))).toBe(true);
    expect(comandosCriados(r)).toHaveLength(0);
  });
});

describe("TEST E — instrução explícita durante pendência", () => {
  it("não responde 'ainda tem um comando pendente' e troca o alvo", async () => {
    const banco = bancoDeTeste();
    // pendência aberta para a Terra Norte, como no caso real
    banco.whatsapp_pending_actions = [{
      id: "pend-tn", operator_phone: "5577999608294", action_type: "desliga",
      equipment_id: "e-tn-11", equipment_name: "Poço 11", farm_id: "f-terranorte",
      operator_id: "op-1", created_at: new Date().toISOString(),
    }];

    const r = await enviarMensagem({
      texto: "Desligar Poço 11 Semear",
      banco,
      // reproduz o comportamento real: o Gemini não devolveu classificação
    });
    const txt = juntou(r);

    expect(txt).not.toMatch(/Ainda tem um comando pendente/i);
    expect(txt).toMatch(/Fazenda:\s*Semear/);
    expect(txt).toMatch(/POÇO 11 R4/);

    // a pendência da Terra Norte não pode sobreviver nem ter sido executada
    const viva = (banco.whatsapp_pending_actions ?? [])
      .filter((p: any) => p.farm_id === "f-terranorte");
    expect(viva).toHaveLength(0);
    expect(comandosCriados(r)).toHaveLength(0);
  });
});

describe("TEST G — lote nunca dispensa confirmação", () => {
  it("super_admin pedindo 'desligar todas semear' ainda precisa confirmar", async () => {
    const banco = bancoDeTeste();
    for (const o of banco.whatsapp_operators) { o.role = "super_admin"; o.skip_confirmation = true; }

    const r = await enviarMensagem({ texto: "desligar todas semear", banco });
    const txt = juntou(r);

    expect(txt).toMatch(/Confirmar comando/);
    expect(comandosCriados(r)).toHaveLength(0);
  });
});

describe("TEST F — o 'sim' continua confirmando", () => {
  it("resposta de confirmação não é tratada como comando novo", async () => {
    const banco = bancoDeTeste();
    banco.whatsapp_pending_actions = [{
      id: "pend-sem", operator_phone: "5577999608294", action_type: "desliga",
      equipment_id: "e-semear-11", equipment_name: "POÇO 11 R4", farm_id: "f-semear",
      operator_id: "op-2", created_at: new Date().toISOString(),
    }];

    const r = await enviarMensagem({
      texto: "sim", banco,
      decisaoDoLLM: { decision: "confirm", confidence: 1 },
    });
    const txt = juntou(r);

    expect(txt).not.toMatch(/foi descartada/i);
    expect(txt).not.toMatch(/Em qual fazenda/i);
    // o "sim" executa o que já estava confirmado, no alvo já resolvido
    const cmds = comandosCriados(r).flatMap((c: any) => c.linhas);
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) expect(c.farm_id).toBe("f-semear");
  });
});

// ── regressão do primeiro bug, agora pelo caminho real ────────────────────
describe("regressão — sufixo de rádio não é identidade", () => {
  it("'Desligar Poço 03 Semear' escolhe POÇO 03 R2", async () => {
    const r = await enviarMensagem({ texto: "Desligar Poço 03 Semear", banco: bancoDeTeste() });
    const txt = juntou(r);
    expect(txt).toMatch(/POÇO 03 R2/);
    for (const errado of ["POÇO 05 R3", "POÇO 14 R3", "POÇO 15 R3"]) {
      expect(txt).not.toMatch(new RegExp(errado));
    }
    expect(comandosCriados(r)).toHaveLength(0);
  });
});

// ── identidade: autorização é do whatsapp_operators, autoria é do vínculo ──
describe("TEST H — Yuri autorizado sem user_id", () => {
  it("o comando sai, created_by é null e o source_device identifica o Yuri", async () => {
    const banco = bancoDeTeste();
    for (const o of banco.whatsapp_operators) { o.user_id = null; o.name = "Yuri Seibert"; }
    // a fazenda TEM admin — era exatamente esse que o fallback usava
    banco.user_roles = [{ user_id: "u-admin", role: "admin", farm_id: "f-semear" }];
    banco.whatsapp_pending_actions = [{
      id: "p1", operator_phone: "5577999608294", action_type: "desliga",
      equipment_id: "e-semear-11", equipment_name: "POÇO 11 R4", farm_id: "f-semear",
      operator_id: "op-2", created_at: new Date().toISOString(),
    }];

    const r = await enviarMensagem({
      texto: "sim", banco, decisaoDoLLM: { decision: "confirm", confidence: 1 },
    });

    const cmds = comandosCriados(r).flatMap((c: any) => c.linhas);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].created_by).toBeNull();
    expect(cmds[0].source_device).toMatch(/^whatsapp:Yuri Seibert\|/);
    expect(cmds[0].farm_id).toBe("f-semear");
    // e em nenhuma hipótese no nome do admin
    expect(cmds[0].created_by).not.toBe("u-admin");
  });
});

describe("TEST I — Alcione com vínculo real", () => {
  it("created_by é o user_id dela, não nulo", async () => {
    const banco = bancoDeTeste();
    for (const o of banco.whatsapp_operators) { o.user_id = null; o.name = "Alcione Costa"; }
    // só a linha da fazenda alvo tem vínculo
    banco.whatsapp_operators.find((o: any) => o.farm_id === "f-semear").user_id = "u-alcione";
    banco.whatsapp_pending_actions = [{
      id: "p1", operator_phone: "5577999608294", action_type: "desliga",
      equipment_id: "e-semear-11", equipment_name: "POÇO 11 R4", farm_id: "f-semear",
      operator_id: "op-2", created_at: new Date().toISOString(),
    }];

    const r = await enviarMensagem({
      texto: "sim", banco, decisaoDoLLM: { decision: "confirm", confidence: 1 },
    });
    const cmds = comandosCriados(r).flatMap((c: any) => c.linhas);
    expect(cmds[0].created_by).toBe("u-alcione");
    expect(cmds[0].source_device).toMatch(/^whatsapp:Alcione Costa\|/);
  });
});

describe("TEST J — mesmo telefone em várias fazendas", () => {
  const cenario = (ordem: number[]) => {
    const banco = bancoDeTeste();
    // Terra Norte tem vínculo; Semear e Sykue não — como em produção
    const porFazenda: Record<string, string | null> = {
      "f-terranorte": "u-gabriel", "f-semear": null, "f-sykue": null,
    };
    for (const o of banco.whatsapp_operators) o.user_id = porFazenda[o.farm_id];
    banco.whatsapp_operators = ordem.map((i) => banco.whatsapp_operators[i]);
    banco.whatsapp_pending_actions = [{
      id: "p1", operator_phone: "5577999608294", action_type: "desliga",
      equipment_id: "e-semear-11", equipment_name: "POÇO 11 R4", farm_id: "f-semear",
      operator_id: "op-2", created_at: new Date().toISOString(),
    }];
    return banco;
  };

  it("o comando na Semear nunca herda o user_id da Terra Norte", async () => {
    // toda permutação das linhas precisa dar o MESMO resultado
    for (const ordem of [[0,1,2],[1,2,0],[2,0,1],[2,1,0]]) {
      const r = await enviarMensagem({
        texto: "sim", banco: cenario(ordem),
        decisaoDoLLM: { decision: "confirm", confidence: 1 },
      });
      const cmds = comandosCriados(r).flatMap((c: any) => c.linhas);
      expect(cmds).toHaveLength(1);
      expect(cmds[0].farm_id).toBe("f-semear");
      expect(cmds[0].created_by).toBeNull();           // determinístico
      expect(cmds[0].created_by).not.toBe("u-gabriel"); // sem vazamento entre fazendas
    }
  });
});

// ── o teste não alcança produção ──────────────────────────────────────────
describe("isolamento", () => {
  it("nenhuma chamada sai para Supabase, Meta ou Gemini de verdade", async () => {
    const r = await enviarMensagem({ texto: "Desligar Poço 11 Semear", banco: bancoDeTeste() });
    // o cliente do banco é objeto em memória; só sobram os dois destinos
    // falsificados, que respondem sem rede.
    expect(urlsInesperadas(r)).toEqual([]);
    expect(r.urls.every((u) => u.startsWith("https://"))).toBe(true);
  });
});
