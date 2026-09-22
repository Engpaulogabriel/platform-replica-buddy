// ─────────────────────────────────────────────────────────────────────────────
// Identidade numérica do equipamento — bug crítico de atuação física
// ─────────────────────────────────────────────────────────────────────────────
// Em 22/09/2026, de madrugada, TRÊS bombas erradas foram LIGADAS na Semear:
//
//   "Ligar poço 01"           → comandou POÇO 02 R1   (pegou o 1 do sufixo R1)
//   "Ligar poço 03, 12, 13…"  → comandou POÇO 15 R3   (pegou o 3 do sufixo R3)
//   "Ligar poço 4"            → comandou POÇO 16 R4   (pegou o 4 do sufixo R4)
//
// O casamento usava `extractNumbers(nome).includes(n)` — QUALQUER número em
// QUALQUER posição. "POÇO 15 R3" devolve [15, 3] e casava com o pedido "3".
// Quem escolhia era `pool.find`, o primeiro da lista: no pool da Semear,
// POÇO 15 R3 está na posição 2 e POÇO 03 R2 na 16.
//
// A lógica testada aqui é copiada do arquivo real e exercitada de verdade —
// não é só leitura de texto. Nenhum comando é criado: o que se testa é a
// RESOLUÇÃO, antes de qualquer enqueue.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = "supabase/functions/whatsapp-webhook/index.ts";
const src = readFileSync(SRC, "utf8");

// ── extrai as funções reais do arquivo e as executa ────────────────────────
const bloco = (assinatura: string) => {
  const i = src.indexOf(assinatura);
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf("\n}", i) + 2);
};
const constBases = src.match(/const BASES_DE_IDENTIDADE =\s*\n?\s*"[^"]+";/)![0];

// Tipos são removidos por substituição EXPLÍCITA das assinaturas: regex
// genérica sobre TypeScript quebra no tipo de retorno em objeto.
const semTipos = (js: string) =>
  js
    .replace("function numeroLogicoDoEquipamento(nome: string): number | null {",
             "function numeroLogicoDoEquipamento(nome) {")
    .replace("function basePrimariaDoEquipamento(nome: string): string | null {",
             "function basePrimariaDoEquipamento(nome) {")
    .replace("function casaNumeroLogico(nome: string, n: number, base?: string | null): boolean {",
             "function casaNumeroLogico(nome, n, base) {")
    .replace(/function resolverPorNumeroLogico\([\s\S]*?\): \{ eq: any \| null; ambiguos: any\[\] \} \{/,
             "function resolverPorNumeroLogico(pool, n, base) {")
    .replace(/const cands = \(pool \?\? \[\]\)/, "const cands = (pool ?? [])")
    .replace(/: string\b/g, "").replace(/: number\b/g, "").replace(/: boolean\b/g, "");

const fonte = `
  const stripAccents = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  ${constBases}
  ${semTipos(bloco("function numeroLogicoDoEquipamento("))}
  ${semTipos(bloco("function basePrimariaDoEquipamento("))}
  ${semTipos(bloco("function casaNumeroLogico("))}
  ${semTipos(bloco("function resolverPorNumeroLogico("))}
  return { numeroLogicoDoEquipamento, casaNumeroLogico, resolverPorNumeroLogico };
`;
const { numeroLogicoDoEquipamento, casaNumeroLogico, resolverPorNumeroLogico } =
  new Function(fonte)() as any;

const SEMEAR = [
  "POÇO 01 R1", "POÇO 02 R1", "POÇO 03 R2", "POÇO 04 R1/R4", "POÇO 05 R3",
  "POÇO 06 R2", "POÇO 07 R1", "POÇO 08 R1", "POÇO 09 R4", "POÇO 10 R4",
  "POÇO 11 R4", "POÇO 12 R2", "POÇO 13 R2", "POÇO 14 R3", "POÇO 15 R3",
  "POÇO 16 R4",
].map((name, i) => ({ id: `eq-${i}`, name }));

const resolver = (pool: any[], n: number, base = "poço") =>
  resolverPorNumeroLogico(pool, n, base);

// ── 1 — REGRESSÃO DO INCIDENTE ─────────────────────────────────────────────
describe("o caso que ligou bomba errada", () => {
  it('"poço 3" NUNCA pode selecionar POÇO 15 R3', () => {
    const r = resolver(SEMEAR, 3);
    expect(r.eq?.name).toBe("POÇO 03 R2");
    expect(r.eq?.name).not.toBe("POÇO 15 R3");
  });

  it('"poço 1" não seleciona POÇO 02 R1 (o 1 do sufixo)', () => {
    expect(resolver(SEMEAR, 1).eq?.name).toBe("POÇO 01 R1");
  });

  it('"poço 4" não seleciona POÇO 16 R4 (o 4 do sufixo)', () => {
    expect(resolver(SEMEAR, 4).eq?.name).toBe("POÇO 04 R1/R4");
  });

  it("o sufixo de rádio nunca é identidade", () => {
    // Os quatro nomes que contêm "3" em algum lugar; só um é o poço 3.
    const com3 = SEMEAR.filter((e) => /3/.test(e.name)).map((e) => e.name);
    expect(com3).toEqual([
      "POÇO 03 R2", "POÇO 05 R3", "POÇO 13 R2", "POÇO 14 R3", "POÇO 15 R3",
    ]);
    expect(com3.filter((n) => casaNumeroLogico(n, 3, "poço"))).toEqual(["POÇO 03 R2"]);
  });
});

// ── 2 — número lógico por nome real ────────────────────────────────────────
describe("numeroLogicoDoEquipamento", () => {
  const casos: Array<[string, number | null]> = [
    ["POÇO 03 R2", 3],
    ["POÇO 15 R3", 15],
    ["POÇO 04 R1/R4", 4],
    ["POÇO 01 R1", 1],
    ["POÇO 17 NV15/16", 17],          // Pérola
    ["POÇO 02 R02", 2],               // Sykue
    ["POÇO 04 R3 R2", 4],             // Sykue
    ["RESERVATÓRIO 02 POÇO 02", 2],   // São Miguel: a base é a primeira
    ["Bomba 1", 1],
    ["Conjunto 01", 1],
    ["Booster 02", 2],
    ["Reservatório 03", 3],
    ["Canal Velho - Pivô 18", 18],    // identidade adiante, mas única
  ];
  for (const [nome, esperado] of casos) {
    it(`"${nome}" → ${esperado}`, () => {
      expect(numeroLogicoDoEquipamento(nome)).toBe(esperado);
    });
  }
});

// ── 3 — anti-substring: 1 não pode virar 10, 11, 15, 16 ────────────────────
describe("sem substring matching", () => {
  for (const [pedido, esperado] of [[1, "POÇO 01 R1"], [2, "POÇO 02 R1"],
                                     [3, "POÇO 03 R2"], [10, "POÇO 10 R4"],
                                     [11, "POÇO 11 R4"], [15, "POÇO 15 R3"],
                                     [16, "POÇO 16 R4"]] as Array<[number, string]>) {
    it(`"poço ${pedido}" → ${esperado}`, () => {
      expect(resolver(SEMEAR, pedido).eq?.name).toBe(esperado);
    });
  }

  it('"poço 1" não casa com nenhum dos de dois dígitos', () => {
    for (const n of ["POÇO 10 R4", "POÇO 11 R4", "POÇO 15 R3", "POÇO 16 R4"]) {
      expect(casaNumeroLogico(n, 1, "poço")).toBe(false);
    }
  });

  it("zero à esquerda é irrelevante: 03 e 3 são o mesmo poço", () => {
    expect(numeroLogicoDoEquipamento("POÇO 03 R2")).toBe(3);
    expect(casaNumeroLogico("POÇO 03 R2", 3, "poço")).toBe(true);
  });
});

// ── 4 — FAIL CLOSED ────────────────────────────────────────────────────────
describe("falha fechada", () => {
  it("poço inexistente não resolve nada", () => {
    const r = resolver(SEMEAR, 99);
    expect(r.eq).toBeNull();
    expect(r.ambiguos).toEqual([]);
  });

  it("dois equipamentos com o mesmo número lógico não elegem vencedor", () => {
    const pool = [{ id: "a", name: "POÇO 03 R2" }, { id: "b", name: "POÇO 03 R5" }];
    const r = resolver(pool, 3);
    expect(r.eq).toBeNull();                 // nada é comandado
    expect(r.ambiguos.map((e: any) => e.name))
      .toEqual(["POÇO 03 R2", "POÇO 03 R5"]); // devolve para desambiguar
  });

  it("o resolvedor nunca devolve 'o primeiro parecido'", () => {
    // Ordem invertida de propósito: se houvesse viés de ordem, apareceria.
    const invertido = [...SEMEAR].reverse();
    expect(resolver(invertido, 3).eq?.name).toBe("POÇO 03 R2");
  });
});

// ── 5 — base primária separa poço de nível ─────────────────────────────────
describe("identidade é (base, número)", () => {
  it("nível com 'poço' no nome não disputa o número do poço", () => {
    // São Miguel e Terra Norte têm nomes assim; um deles é sensor de nível.
    expect(casaNumeroLogico("RESERVATÓRIO 02 POÇO 02", 2, "poço")).toBe(false);
    expect(casaNumeroLogico("RESERVATÓRIO 02 POÇO 02", 2, "reservatório")).toBe(true);
  });

  it("poço e bomba continuam intercambiáveis na fala do operador", () => {
    expect(casaNumeroLogico("Bomba 1", 1, "poço")).toBe(true);
    expect(casaNumeroLogico("Poço 01", 1, "bomba")).toBe(true);
  });
});

// ── 6 — o código não voltou ao casamento antigo ────────────────────────────
describe("o casamento antigo não existe mais", () => {
  it("nenhum sítio decide equipamento por extractNumbers", () => {
    // Ignora comentários: o cabeçalho do helper cita o padrão antigo de
    // propósito, para explicar o incidente.
    const codigo = src.split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(codigo).not.toMatch(/extractNumbers\([^)]*\)\.includes\(/);
    expect(codigo).not.toMatch(/ns\.includes\(n\)/);
  });

  it("os sítios que escolhem equipamento usam casaNumeroLogico", () => {
    expect([...src.matchAll(/casaNumeroLogico\(/g)].length).toBeGreaterThanOrEqual(7);
  });

  it("ambiguidade no caminho de atuação não vira comando", () => {
    expect(src).toMatch(/if \(ambiguidades\.length\) \{/);
    expect(src).toMatch(/Nenhum comando foi enviado/);
  });
});
