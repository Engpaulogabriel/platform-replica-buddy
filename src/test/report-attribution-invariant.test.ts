// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// A invariante do par ORIGEM × NOME
// ─────────────────────────────────────────────────────────────────────────────
// "Remoto · Acionamento local" apareceu em produção na Fazenda Sykue. O banco
// estava certo — origin='local', actor_label='Acionamento local' — e a tela
// mentiu: o componente resolvia a origem DUAS vezes, e a segunda passada
// recebia "Local", que não era nem "Manual" nem "Sistema" e caía no else.
//
// A suíte anterior não pegou isso porque testava a origem e o nome em
// funções separadas, e nunca aplicava a função sobre a própria saída.

import { describe, it, expect } from "vitest";
import { deriveReportAttribution, resolveReportOrigin } from "@/lib/reportOrigin";

/** Formato real das entradas, como o relatório as monta. */
const linha = (origin: string, user: string | null) => ({ origin, user });

// ── as linhas REAIS que falharam na tela ───────────────────────────────────
// Copiadas do NEW: Fazenda Sykue, 22/09/2026, auto-trigger, sem command_id,
// origin='local', actor_label='Acionamento local'. Depois de rowToEntry o
// origin interno vira "Manual".
const SYKUE_REAIS = [
  { eq: "POÇO 18 R9", hora: "14:02:37", acao: "Desligada" },
  { eq: "POÇO 12 R6", hora: "09:37:48", acao: "Ligada" },
  { eq: "POÇO 12 R6", hora: "09:36:37", acao: "Desligada" },
  { eq: "POÇO 12 R6", hora: "09:33:18", acao: "Ligada" },
  { eq: "POÇO 12 R6", hora: "09:32:45", acao: "Desligada" },
  { eq: "POÇO 12 R6", hora: "09:31:36", acao: "Ligada" },
  { eq: "POÇO 12 R6", hora: "09:30:42", acao: "Desligada" },
];

describe("as linhas da Sykue que apareceram erradas em produção", () => {
  for (const r of SYKUE_REAIS) {
    it(`${r.eq} ${r.hora} ${r.acao} → Local · Acionamento local`, () => {
      const a = deriveReportAttribution(linha("Manual", "Acionamento local"));
      expect(a).toEqual({ origin: "Local", name: "Acionamento local" });
    });
  }

  it("e continuam corretas se a derivação for aplicada duas vezes", () => {
    const uma = deriveReportAttribution(linha("Manual", "Acionamento local"));
    const duas = deriveReportAttribution({ origin: uma.origin, user: uma.name });
    expect(duas).toEqual(uma);
    expect(duas.origin).toBe("Local");
  });
});

// ── o estado impossível ────────────────────────────────────────────────────
describe("combinações proibidas não são representáveis", () => {
  const entradas: Array<[string, string | null]> = [
    ["Manual", "Acionamento local"], ["Manual", "Yuri Seibert"], ["Manual", null],
    ["Sistema", "Sistema"], ["Sistema", "Telemetria RF"], ["Sistema", null],
    ["Remoto", "Yuri Seibert"], ["Remoto", "Acionamento local"], ["Remoto", null],
    ["Remoto", "Telemetria RF"], ["WhatsApp", "Alcione"], ["WhatsApp", "Acionamento local"],
    ["Automático", "Desligamento 17h Semear"], ["Modo Automático", "Automação"],
    ["Local", "Acionamento local"], ["Remoto", "Jonatan poczwardowski"],
    ["QualquerCoisaNova", "seja o que for"],
  ];

  it("NUNCA Remoto com nome 'Acionamento local'", () => {
    for (const [o, u] of entradas) {
      const a = deriveReportAttribution(linha(o, u));
      expect(`${o}|${u} → ${a.origin}·${a.name}`)
        .not.toMatch(/→ Remoto·Acionamento local/);
    }
  });

  it("NUNCA Local com nome de pessoa ou de automação", () => {
    for (const [o, u] of entradas) {
      const a = deriveReportAttribution(linha(o, u));
      if (a.origin === "Local") expect(a.name).toBe("Acionamento local");
    }
  });

  it("toda saída é um dos dois estados válidos", () => {
    for (const [o, u] of entradas) {
      const a = deriveReportAttribution(linha(o, u));
      const valido = (a.origin === "Local" && a.name === "Acionamento local")
                  || (a.origin === "Remoto" && a.name !== "Acionamento local");
      expect(`${o}|${u}: ${a.origin}·${a.name}`).toBe(`${o}|${u}: ${a.origin}·${a.name}`);
      expect(valido).toBe(true);
    }
  });

  it("a derivação é idempotente para toda entrada", () => {
    for (const [o, u] of entradas) {
      const um = deriveReportAttribution(linha(o, u));
      const dois = deriveReportAttribution({ origin: um.origin, user: um.name });
      expect(dois).toEqual(um);
    }
  });
});

// ── os pares permitidos ────────────────────────────────────────────────────
describe("pares permitidos", () => {
  it("Local · Acionamento local", () => {
    expect(deriveReportAttribution(linha("Manual", "Acionamento local")))
      .toEqual({ origin: "Local", name: "Acionamento local" });
  });
  it("Remoto · Yuri Seibert", () => {
    expect(deriveReportAttribution(linha("Remoto", "Yuri Seibert")))
      .toEqual({ origin: "Remoto", name: "Yuri Seibert" });
  });
  it("Remoto · Jonatan poczwardowski", () => {
    expect(deriveReportAttribution(linha("Remoto", "Jonatan poczwardowski")))
      .toEqual({ origin: "Remoto", name: "Jonatan poczwardowski" });
  });
  it("Remoto · Alcione (WhatsApp é canal, não origem)", () => {
    expect(deriveReportAttribution(linha("WhatsApp", "Alcione")))
      .toEqual({ origin: "Remoto", name: "Alcione" });
  });
  it("Remoto · nome da automação", () => {
    expect(deriveReportAttribution(linha("Automático", "Desligamento 17h Semear")))
      .toEqual({ origin: "Remoto", name: "Desligamento 17h Semear" });
  });
  it("Remoto sem ator comprovável → nome vazio, nunca 'Acionamento local'", () => {
    const a = deriveReportAttribution(linha("Remoto", "Telemetria RF"));
    expect(a.origin).toBe("Remoto");
    expect(a.name).toBe("");          // a tela mostra travessão
  });
});

describe("resolveReportOrigin é a mesma decisão, não uma segunda heurística", () => {
  it("concorda com deriveReportAttribution em toda entrada", () => {
    for (const o of ["Manual","Sistema","Remoto","WhatsApp","Automático",
                     "Modo Automático","Local","Coisa nova"]) {
      expect(resolveReportOrigin(o)).toBe(deriveReportAttribution({ origin: o }).origin);
    }
  });
  it("é idempotente", () => {
    for (const o of ["Manual","Sistema","Remoto","WhatsApp","Local","Remoto"]) {
      expect(resolveReportOrigin(resolveReportOrigin(o))).toBe(resolveReportOrigin(o));
    }
  });
});

// ── o universo REAL das cinco fazendas ─────────────────────────────────────
// 20 pares (origin interno × actor_label) distintos, extraídos do NEW, que
// cobrem as 7.701 linhas operacionais de Pérola, Sykue, Semear, Terra Norte e
// Sossego. Se algum par real produzir combinação proibida, este teste cai.
import pares from "./fixtures/report-attribution-pairs.json";

describe("universo real das cinco fazendas", () => {
  it("os 20 pares reais cobrem todas as linhas operacionais", () => {
    expect(pares.length).toBe(20);
    expect(pares.reduce((s: number, p: any) => s + p.n, 0)).toBe(7701);
  });

  for (const p of pares as Array<{ origin: string; user: string; n: number }>) {
    it(`${p.origin} · ${p.user || "(vazio)"} (${p.n} linhas) → par válido`, () => {
      const a = deriveReportAttribution({ origin: p.origin, user: p.user });
      if (a.origin === "Local") {
        expect(a.name).toBe("Acionamento local");
      } else {
        expect(a.name).not.toBe("Acionamento local");
      }
      // e aplicar de novo não muda nada
      expect(deriveReportAttribution({ origin: a.origin, user: a.name })).toEqual(a);
    });
  }

  it("nenhum par real produz Remoto · Acionamento local", () => {
    const proibidos = (pares as Array<{ origin: string; user: string }>)
      .map((p) => deriveReportAttribution({ origin: p.origin, user: p.user }))
      .filter((a) => a.origin === "Remoto" && a.name === "Acionamento local");
    expect(proibidos).toEqual([]);
  });
});
