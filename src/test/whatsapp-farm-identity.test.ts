// ─────────────────────────────────────────────────────────────────────────────
// Identidade operacional: FARM_ID + EQUIPMENT_ID + ACTION
// ─────────────────────────────────────────────────────────────────────────────
// Em 22/09/2026, "Desligar Poço 11" — sem fazenda no texto — abriu confirmação
// para o Poço 11 da TERRA NORTE, embora as sete mensagens anteriores fossem
// todas sobre a Semear. A fazenda veio do default_farm_id do operador, em
// silêncio. "Poço 11" existe em três fazendas acessíveis ao mesmo telefone:
//
//   Semear       POÇO 11 R4    desligado
//   Sykue        POÇO 11 R06   LIGADO
//   Terra Norte  Poço 11       LIGADO
//
// Um "SIM" teria desligado bomba em produção na fazenda errada. Pior: a
// mensagem seguinte, "Desligar Poço 11 Semear" — com a fazenda escrita — foi
// respondida com "ainda tem um comando pendente" referente à Terra Norte.
// A instrução explícita do operador foi perdida.
//
// A lógica de resolução é extraída do arquivo real e EXECUTADA aqui. Nenhum
// comando é criado: o que se testa é a decisão, antes de qualquer enqueue.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = "supabase/functions/whatsapp-webhook/index.ts";
const src = readFileSync(SRC, "utf8");

const bloco = (assinatura: string) => {
  const i = src.indexOf(assinatura);
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf("\n}", i) + 2);
};
const constBases = src.match(/const BASES_DE_IDENTIDADE =\s*\n?\s*"[^"]+";/)![0];

const semTipos = (js: string) =>
  js
    .replace("function numeroLogicoDoEquipamento(nome: string): number | null {",
             "function numeroLogicoDoEquipamento(nome) {")
    .replace("function basePrimariaDoEquipamento(nome: string): string | null {",
             "function basePrimariaDoEquipamento(nome) {")
    .replace("function casaNumeroLogico(nome: string, n: number, base?: string | null): boolean {",
             "function casaNumeroLogico(nome, n, base) {")
    .replace(/function fazendaExplicitaNoTexto\([\s\S]*?\)\s*:\s*\{ id: string; name: string \} \| null \{/,
             "function fazendaExplicitaNoTexto(texto, acessiveis) {")
    .replace(/: \{ id: string; name: string \} \| null/g, "")
    .replace(/: string\b/g, "").replace(/: number\b/g, "").replace(/: boolean\b/g, "");

const { casaNumeroLogico, fazendaExplicitaNoTexto } = new Function(`
  const stripAccents = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
  ${constBases}
  ${semTipos(bloco("function numeroLogicoDoEquipamento("))}
  ${semTipos(bloco("function basePrimariaDoEquipamento("))}
  ${semTipos(bloco("function casaNumeroLogico("))}
  ${semTipos(bloco("function fazendaExplicitaNoTexto("))}
  return { casaNumeroLogico, fazendaExplicitaNoTexto };
`)() as any;

// Dados reais das três fazendas envolvidas.
const ACESSIVEIS = [
  { id: "f-semear", name: "Semear" },
  { id: "f-sykue", name: "Fazenda Sykue" },
  { id: "f-terranorte", name: "Fazenda Terra Norte" },
];
const POCO11 = [
  { farm: "f-semear", name: "POÇO 11 R4" },
  { farm: "f-sykue", name: "POÇO 11 R06" },
  { farm: "f-terranorte", name: "Poço 11" },
];
/** Onde existe o "poço N" entre as fazendas acessíveis. */
const entreFazendas = (pool: typeof POCO11, n: number) =>
  pool.filter((e) => casaNumeroLogico(e.name, n, "poço"));

// ── CASO A — sem fazenda no texto, equipamento em três fazendas ───────────
describe("CASO A — ambiguidade entre fazendas", () => {
  it('"Desligar Poço 11" existe em três fazendas acessíveis', () => {
    expect(entreFazendas(POCO11, 11)).toHaveLength(3);
  });

  it("nenhuma fazenda é escrita no texto", () => {
    expect(fazendaExplicitaNoTexto("Desligar Poço 11", ACESSIVEIS)).toBeNull();
  });

  it("o código pede desambiguação e não envia comando", () => {
    expect(src).toMatch(/Em qual fazenda deseja executar o comando\? Nenhum comando foi enviado\./);
    // o retorno acontece ANTES de qualquer criação de pendência ou comando
    const i = src.indexOf("Em qual fazenda deseja executar o comando?");
    const trecho = src.slice(i, i + 200);
    expect(trecho).toMatch(/return true;/);
  });
});

// ── CASOS B, C, D — fazenda explícita resolve cada uma ────────────────────
describe("fazenda explícita tem prioridade", () => {
  const casos: Array<[string, string, string]> = [
    ["Desligar Poço 11 Semear", "f-semear", "POÇO 11 R4"],
    ["Desligar Poço 11 Terra Norte", "f-terranorte", "Poço 11"],
    ["Desligar Poço 11 Sykue", "f-sykue", "POÇO 11 R06"],
  ];
  for (const [texto, farmId, equip] of casos) {
    it(`"${texto}" → ${equip}`, () => {
      const f = fazendaExplicitaNoTexto(texto, ACESSIVEIS);
      expect(f?.id).toBe(farmId);
      const naFazenda = entreFazendas(POCO11.filter((e) => e.farm === farmId), 11);
      expect(naFazenda).toHaveLength(1);
      expect(naFazenda[0].name).toBe(equip);
    });
  }

  // A ordem de resolução (explícita > alvo único > pergunta, e nunca o
  // default) é provada por comportamento em whatsapp-real-path.integration,
  // TESTs A e B. A asserção de regex que existia aqui passava em verde
  // enquanto a v10 comandava a fazenda errada em produção.

  it("nome parcial não casa dentro de outra palavra", () => {
    // "semeadura" não pode ativar a fazenda "Semear".
    expect(fazendaExplicitaNoTexto("ligar poço 3 semeadura", ACESSIVEIS)).toBeNull();
  });

  it("o nome mais específico vence quando dois casam", () => {
    const f = fazendaExplicitaNoTexto("desligar poço 11 fazenda terra norte", ACESSIVEIS);
    expect(f?.name).toBe("Fazenda Terra Norte");
  });
});

// ── CASO E — pendência não engole comando explícito novo ──────────────────
describe("CASO E — nova instrução física substitui pendência", () => {
  it("comando físico explícito descarta a pendência anterior", () => {
    expect(src).toMatch(/nova instrução física explícita — substituindo pendência/);
    expect(src).toMatch(/A confirmação anterior \(\*\$\{desc\}\*\) foi descartada/);
  });

  it("a pendência é apagada ANTES de reprocessar, o que encerra a recursão", () => {
    const i = src.indexOf("nova instrução física explícita");
    const trecho = src.slice(i, i + 600);
    expect(trecho.indexOf("deleteAllPending(phone)"))
      .toBeLessThan(trecho.indexOf("processMessage(from, text, null)"));
  });

  // "só ligar/desligar substituem" é provado por comportamento em
  // whatsapp-real-path.integration (TEST E substitui; TEST F mantém o "sim").
});

// ── CASO F — o SIM executa os IDs já confirmados ──────────────────────────
describe("CASO F — confirmação usa IDs armazenados", () => {
  it("a pendência guarda farm_id, equipment_id e action_type", () => {
    expect(src).toMatch(/action_type: turnOn \? "liga" : "desliga"/);
    expect(src).toMatch(/equipment_id: t\.eq\.id/);
    expect(src).toMatch(/farm_id: farmId/);
  });

  it("o SIM reutiliza os IDs, sem refazer resolução por texto", () => {
    expect(src).toMatch(/const farmIdExec = pending\.farm_id \?\? op\.farm_id/);
    expect(src).toMatch(/equipmentIds: \[pending\.equipment_id as string\]/);
  });
});

// ── CASOS G e H — resolução única versus ambígua ──────────────────────────
describe("resolução automática só quando é única", () => {
  it("CASO G: único no universo acessível resolve e mostra a fazenda", () => {
    const so_semear = [{ farm: "f-semear", name: "POÇO 03 R2" }];
    expect(entreFazendas(so_semear, 3)).toHaveLength(1);
    expect(src).toMatch(/matches\.push\(entre\[0\]\.eq\);\s*\n\s*farmId = entre\[0\]\.farm\.id;/);
  });

  it("CASO H: presente em várias exige desambiguação", () => {
    const varias = [
      { farm: "f-semear", name: "POÇO 03 R2" },
      { farm: "f-terranorte", name: "Poço 03" },
    ];
    expect(entreFazendas(varias, 3)).toHaveLength(2);
  });
});

// ── CASO I — o sufixo R continua fora da identidade ───────────────────────
describe("CASO I — regressão do primeiro bug", () => {
  it('"Poço 03" na Semear não casa com R3 de outros poços', () => {
    const semear = [
      { farm: "f-semear", name: "POÇO 03 R2" },
      { farm: "f-semear", name: "POÇO 05 R3" },
      { farm: "f-semear", name: "POÇO 14 R3" },
      { farm: "f-semear", name: "POÇO 15 R3" },
    ];
    const achados = entreFazendas(semear, 3);
    expect(achados).toHaveLength(1);
    expect(achados[0].name).toBe("POÇO 03 R2");
  });
});

// ── 5 — a confirmação nomeia a fazenda ────────────────────────────────────
describe("confirmação mostra FAZENDA + EQUIPAMENTO + AÇÃO", () => {
  it("alvo único", () => {
    expect(src).toMatch(/lines\.push\(`Fazenda: \$\{__nomeFazenda\}`\)/);
    expect(src).toMatch(/lines\.push\(`Equipamento: \$\{actionableTargets\[0\]\.eq\.name\}`\)/);
    expect(src).toMatch(/lines\.push\(`Ação: \$\{verbo\}`\)/);
  });

  it("vários alvos também nomeiam a fazenda", () => {
    const i = src.indexOf('lines.push("⚠️ Confirmar comandos:", "");');
    expect(src.slice(i, i + 300)).toMatch(/Fazenda: \$\{__nomeFazenda\}/);
  });

  it("o texto antigo, sem fazenda, não existe mais", () => {
    expect(src).not.toMatch(/lines\.push\(`• \$\{verbo\} \$\{actionableTargets\[0\]\.eq\.name\}`\)/);
  });
});

// ── default_farm_id não decide alvo físico ambíguo ────────────────────────
describe("default_farm_id", () => {
  it("continua existindo para consulta/navegação", () => {
    expect(src).toMatch(/op\.default_farm_id \?\? op\.farm_id/);
  });

  it("a busca entre fazendas só acontece quando NÃO há fazenda explícita", () => {
    expect(src).toMatch(
      /if \(__ehComandoFisico && !__fazendaExplicita && __acessiveis\.length > 1\)/,
    );
  });

  it("a checagem multi-fazenda vale só para comando físico", () => {
    expect(src).toMatch(
      /const __ehComandoFisico = cmd\.kind === "ops"[\s\S]{0,140}turn_on" \|\| o\.action === "turn_off"/,
    );
  });
});

// ── LOTE — regra mais restritiva que a do alvo único ───────────────────────
// "desligar todas" não tem número que desempate: atinge tudo o que estiver
// ligado na fazenda escolhida. Se a fazenda viesse do default_farm_id, um
// operador multi-fazenda desligaria uma fazenda inteira sem ter escrito o
// nome dela.
describe("comando em lote", () => {
  it("sem fazenda no texto e multi-fazenda: pergunta, não executa", () => {
    expect(src).toMatch(/Em qual fazenda deseja \$\{verbo\.toLowerCase\(\)\} os equipamentos\?/);
    expect(src).toMatch(/Repita o comando com o nome da fazenda\. Nenhum comando foi enviado\./);
  });

  it("a pergunta acontece ANTES de montar os alvos", () => {
    const iPergunta = src.indexOf("Em qual fazenda deseja ${verbo.toLowerCase()} os equipamentos?");
    const iMatches = src.indexOf("matches.push(...pool);");
    expect(iPergunta).toBeGreaterThan(-1);
    expect(iPergunta).toBeLessThan(iMatches);
  });

  it("a guarda do lote exige as três condições", () => {
    const i = src.indexOf("// LOTE. Aqui não existe número que desempate");
    const trecho = src.slice(i, i + 900);
    expect(trecho).toMatch(/__ehComandoFisico && !__fazendaExplicita && __acessiveis\.length > 1/);
  });

  it("operador de uma fazenda só segue resolvendo — e a confirmação nomeia", () => {
    // __acessiveis.length > 1 é falso, então não pergunta; a confirmação
    // continua exibindo "Fazenda: …".
    expect(src).toMatch(/lines\.push\(`Fazenda: \$\{__nomeFazenda\}`\)/);
  });

  it("fazenda explícita no lote dispensa a pergunta", () => {
    const f = fazendaExplicitaNoTexto("desligar todas as bombas da Semear", ACESSIVEIS);
    expect(f?.name).toBe("Semear");
  });

  it("e resolve Terra Norte quando é ela a escrita", () => {
    const f = fazendaExplicitaNoTexto("desligar todas da Terra Norte", ACESSIVEIS);
    expect(f?.name).toBe("Fazenda Terra Norte");
  });
});

// ── manutenção: fazenda vem da pendência ──────────────────────────────────
describe("lote de manutenção", () => {
  it("usa o farm_id da pendência, não op.farm_id", () => {
    expect(src).toMatch(/if \(pendMP\?\.farm_id\) farmIdMP = pendMP\.farm_id;/);
  });

  it("os alvos sempre foram equipment_ids explícitos, nunca busca por fazenda", () => {
    expect(src).toMatch(/equipmentIds: runningIds/);
    expect(src).toMatch(/if \(eqMap\.get\(eid\)\?\.desired_running === true\) runningIds\.push\(eid\)/);
  });
});

// ── a porta física é única e vinculada ao equipamento ──────────────────────
describe("produtores físicos", () => {
  it("existe UMA função que cria comando físico", () => {
    expect([...src.matchAll(/async function enqueueManualPumpCommandSrv\(/g)].length).toBe(1);
  });

  it("e ela é chamada de UM único lugar", () => {
    expect([...src.matchAll(/enqueueManualPumpCommandSrv\(/g)].length).toBe(2); // definição + 1 chamada
  });

  it("o comando nasce com a fazenda DO EQUIPAMENTO, não a resolvida", () => {
    // Mesmo que farmId estivesse errado, o alvo físico seria coerente.
    expect(src).toMatch(/farm_id: eq\.farm_id,\s*\n\s*equipment_id: eq\.id,/);
  });

  it("desired_running é escrito por equipment_id, nunca por fazenda", () => {
    expect(src).toMatch(/desired_running: turnOn,[\s\S]{0,200}\.eq\("id", eq\.id\)/);
  });

  it("não há outra porta lateral: zero rpc, zero enqueue_remote_command", () => {
    expect(src).not.toMatch(/enqueue_remote_command/);
    expect(src).not.toMatch(/\.rpc\(/);
  });
});
