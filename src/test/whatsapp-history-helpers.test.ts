// @vitest-environment node
// Histórico de Conversas WhatsApp. O bug: a lista lateral era derivada da MESMA
// janela de datas das mensagens, então um período com 6 mensagens de uma pessoa
// escondia os outros 26 contatos — parecia exclusão. Nada foi apagado: o banco
// tem 19.622 mensagens e 27 contatos.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import {
  DEFAULT_RANGE_DAYS, PAGE_SIZE, CONTACT_PAGE_SIZE, MAX_ROWS,
  localDateString, startOfLocalDay, endOfLocalDay, dateRangeToIso,
  buildContacts, canonPhone, phoneSuffix8, formatPhone,
  pageRange, hasMorePages, mergeUnique, createRequestGuard,
  type ContactSeed,
} from "../lib/whatsappHistory.ts";

/** Os 27 contatos reais de produção, com os volumes informados. */
const PRODUCAO: Array<[string, string, number]> = [
  ["5577999608294", "Sistema", 8454],
  ["5577981503951", "Sistema", 3201],
  ["5577999997128", "Alcione Costa", 1345],
  ["5577981503429", "RENOV", 1330],
  ["5577999498723", "Kennedy Souza Luz", 1206],
  ["5577998654782", "Yuri Seibert", 932],
  ["5577988120550", "Jonatan poczwardowski", 908],
];

const seed = (phone: string, name: string, at: string, farm: string | null = "farm-1"): ContactSeed =>
  ({ phone, operator_name: name, created_at: at, farm_id: farm });

/** Histórico completo: cada contato com uma mensagem antiga (junho). */
const historico = (): ContactSeed[] =>
  PRODUCAO.map(([p, n], i) => seed(p, n, `2026-06-25T06:5${i}:00.000Z`));

// ── 1, 2 e 4: a lista lateral não depende do período ───────────────────────
describe("1, 2 e 4. lista lateral independe do filtro de datas", () => {
  it("todos os contatos históricos aparecem, mesmo sem mensagem no período", () => {
    const contatos = buildContacts(historico());
    expect(contatos).toHaveLength(PRODUCAO.length);
    expect(contatos.map((c) => c.name).sort()).toEqual(
      PRODUCAO.map(([, n]) => n).sort());
  });

  it("2 e 4. o Jonatan ter as únicas 6 mensagens do período não apaga os outros 26", () => {
    // Simula o cenário real: histórico completo + tráfego recente só do Jonatan.
    const seeds = [
      ...historico(),
      ...Array.from({ length: 6 }, (_, i) =>
        seed("5577988120550", "Jonatan poczwardowski", `2026-08-27T18:1${i}:00.000Z`)),
    ];
    const contatos = buildContacts(seeds);
    expect(contatos).toHaveLength(PRODUCAO.length);
    expect(contatos.find((c) => c.phone === "5577988120550")?.count).toBe(7);
    // e os demais continuam listados com sua mensagem antiga
    expect(contatos.find((c) => c.phone === "5577999608294")).toBeTruthy();
    expect(contatos.find((c) => c.phone === "5577999997128")).toBeTruthy();
  });

  it("a conversa mais recente vem primeiro", () => {
    const seeds = [
      seed("5577999608294", "Sistema", "2026-06-25T06:56:00.000Z"),
      seed("5577988120550", "Jonatan poczwardowski", "2026-08-27T18:18:00.000Z"),
    ];
    expect(buildContacts(seeds)[0].phone).toBe("5577988120550");
  });

  it("variantes do mesmo número viram UM contato (com/sem 9º dígito, com/sem +)", () => {
    const seeds = [
      seed("+55 77 99999-7128", "Alcione Costa", "2026-07-01T10:00:00.000Z"),
      seed("557799997128", "Alcione Costa", "2026-07-02T10:00:00.000Z"),
      seed("5577999997128", null, "2026-07-03T10:00:00.000Z"),
    ];
    const c = buildContacts(seeds);
    expect(c).toHaveLength(1);
    expect(c[0].count).toBe(3);
    expect(c[0].name).toBe("Alcione Costa");
  });
});

// ── 16: farm_id NULL ───────────────────────────────────────────────────────
describe("16. farm_id NULL é preservado", () => {
  it("contato sem fazenda mantém farmId null (agrupa em 'Sem fazenda')", () => {
    const c = buildContacts([seed("5577999608294", "Sistema", "2026-07-01T10:00:00.000Z", null)]);
    expect(c[0].farmId).toBeNull();
  });

  it("os 292 registros sem fazenda não são descartados", () => {
    const seeds = Array.from({ length: 292 }, (_, i) =>
      seed(`55779999${String(i).padStart(5, "0")}`, "X", "2026-07-01T10:00:00.000Z", null));
    expect(buildContacts(seeds)).toHaveLength(292);
  });

  it("uma fazenda encontrada depois preenche o farmId antes nulo", () => {
    const c = buildContacts([
      seed("5577999608294", "Sistema", "2026-07-01T10:00:00.000Z", null),
      seed("5577999608294", "Sistema", "2026-07-02T10:00:00.000Z", "farm-9"),
    ]);
    expect(c[0].farmId).toBe("farm-9");
  });
});

// ── 7, 8 e 9: datas ────────────────────────────────────────────────────────
describe("7, 8 e 9. período padrão e datas locais", () => {
  it("7. o padrão é 30 dias, não 7", () => {
    expect(DEFAULT_RANGE_DAYS).toBe(30);
  });

  it("8. não há deslocamento UTC — 23:30 local não vira o dia seguinte", () => {
    // 31/08/2026 23:30 local. Com toISOString().slice(0,10) em BRT daria 01/09.
    const base = new Date(2026, 7, 31, 23, 30, 0);
    expect(localDateString(0, base)).toBe("2026-08-31");
    expect(localDateString(30, base)).toBe("2026-08-01");
  });

  it("8b. 00:30 local também não retrocede", () => {
    expect(localDateString(0, new Date(2026, 8, 2, 0, 30, 0))).toBe("2026-09-02");
  });

  it("9. o início é 00:00:00.000 e o fim 23:59:59.999 LOCAIS", () => {
    const ini = startOfLocalDay("2026-08-26");
    expect([ini.getHours(), ini.getMinutes(), ini.getSeconds(), ini.getMilliseconds()])
      .toEqual([0, 0, 0, 0]);
    const fim = endOfLocalDay("2026-09-02");
    expect([fim.getHours(), fim.getMinutes(), fim.getSeconds(), fim.getMilliseconds()])
      .toEqual([23, 59, 59, 999]);
  });

  it("9b. uma mensagem às 23:59:59.500 do último dia ENTRA na janela", () => {
    const { from, to } = dateRangeToIso("2026-08-26", "2026-09-02");
    const msg = new Date(2026, 8, 2, 23, 59, 59, 500).toISOString();
    expect(msg >= from && msg <= to).toBe(true);
  });

  it("9c. a primeira mensagem do dia inicial também entra", () => {
    const { from, to } = dateRangeToIso("2026-08-26", "2026-09-02");
    const msg = new Date(2026, 7, 26, 0, 0, 0, 0).toISOString();
    expect(msg >= from && msg <= to).toBe(true);
  });

  it("9d. um dia antes do início fica de fora", () => {
    const { from } = dateRangeToIso("2026-08-26", "2026-09-02");
    expect(new Date(2026, 7, 25, 23, 59, 59, 999).toISOString() < from).toBe(true);
  });
});

// ── 10 e 11: paginação ─────────────────────────────────────────────────────
describe("10 e 11. paginação sem truncamento silencioso e sem duplicata", () => {
  it("as páginas são de 1000 e as faixas não se sobrepõem", () => {
    expect(PAGE_SIZE).toBe(1000);
    expect(pageRange(0)).toEqual([0, 999]);
    expect(pageRange(1)).toEqual([1000, 1999]);
    expect(pageRange(2)).toEqual([2000, 2999]);
  });

  it("10. as 10.122 mensagens de 30 dias exigem 11 páginas — nenhuma perdida", () => {
    const TOTAL = 10122;
    let vistas = 0, p = 0;
    for (;;) {
      const [f, t] = pageRange(p);
      const n = Math.max(0, Math.min(t, TOTAL - 1) - f + 1);
      vistas += n;
      if (!hasMorePages(n)) break;
      p += 1;
    }
    expect(p + 1).toBe(11);
    expect(vistas).toBe(TOTAL);   // o antigo limit(2000) perdia 8.122
  });

  it("só há próxima página quando a atual veio cheia", () => {
    expect(hasMorePages(1000)).toBe(true);
    expect(hasMorePages(999)).toBe(false);
    expect(hasMorePages(0)).toBe(false);
  });

  it("11. mergeUnique não duplica quando o offset desloca entre páginas", () => {
    const p1 = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const p2 = [{ id: "c" }, { id: "d" }];   // 'c' repetido pela borda
    const out = mergeUnique(p1, p2);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("11b. reaplicar a mesma página não cresce o conjunto", () => {
    const p1 = [{ id: "a" }, { id: "b" }];
    expect(mergeUnique(mergeUnique([], p1), p1)).toHaveLength(2);
  });

  it("11c. a ordem de chegada é preservada", () => {
    expect(mergeUnique([{ id: "x" }], [{ id: "y" }, { id: "z" }]).map((r) => r.id))
      .toEqual(["x", "y", "z"]);
  });

  it("o teto de segurança é explícito e alto o bastante para a base atual", () => {
    expect(MAX_ROWS).toBe(50_000);
    expect(MAX_ROWS).toBeGreaterThan(19_622);   // total real do banco
    expect(CONTACT_PAGE_SIZE).toBe(1000);
  });
});

// ── 12: corrida de requisições ─────────────────────────────────────────────
describe("12. resposta antiga não sobrescreve filtro novo", () => {
  it("só o token mais recente pode escrever", () => {
    const g = createRequestGuard();
    const antigo = g.begin();
    const novo = g.begin();
    expect(g.isCurrent(antigo)).toBe(false);
    expect(g.isCurrent(novo)).toBe(true);
  });

  it("trocar de contato três vezes deixa só a última valer", () => {
    const g = createRequestGuard();
    const tokens = [g.begin(), g.begin(), g.begin()];
    expect(tokens.filter((t) => g.isCurrent(t))).toEqual([tokens[2]]);
  });
});

// ── Telefone ───────────────────────────────────────────────────────────────
describe("telefone: canônico e sufixo", () => {
  it("insere o 9º dígito e o prefixo 55 quando faltam", () => {
    expect(canonPhone("7799997128")).toBe("5577999997128");
    expect(canonPhone("+55 77 9999-7128")).toBe("5577999997128");
    expect(canonPhone("5577999997128")).toBe("5577999997128");
  });

  it("o sufixo de 8 dígitos casa todas as variantes", () => {
    expect(phoneSuffix8("+55 77 99999-7128")).toBe(phoneSuffix8("557799997128"));
  });

  it("entrada vazia não quebra", () => {
    expect(canonPhone("")).toBe("");
    expect(buildContacts([seed("", "X", "2026-07-01T10:00:00.000Z")])).toHaveLength(0);
  });

  it("formatPhone devolve o original quando não reconhece", () => {
    expect(formatPhone("123")).toBe("123");
  });
});

// ── 17 e integração com a página ───────────────────────────────────────────
describe("17 e a página: contrato do componente", () => {
  const REPO = path.resolve(__dirname, "../..");
  const PAGE = fs.readFileSync(path.join(REPO, "src/pages/HistoricoWhatsApp.tsx"), "utf8");
  /** Só o CÓDIGO: comentários mencionam o limit antigo e não podem contar. */
  const CODE = PAGE.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const LIB = fs.readFileSync(path.join(REPO, "src/lib/whatsappHistory.ts"), "utf8");

  it("17. NENHUMA escrita no banco em toda a correção", () => {
    for (const src of [PAGE, LIB]) {
      expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/);
    }
  });

  it("não toca RLS, policy, auth nem service_role", () => {
    for (const src of [PAGE, LIB]) {
      expect(src).not.toMatch(/service_role|SERVICE_ROLE|whatsapp_operators|is_whatsapp_super_admin|current_operator_phone|POLICY/);
    }
  });

  it("1. a lista lateral NÃO reage ao filtro de datas", () => {
    const efeito = PAGE.slice(PAGE.indexOf("void loadContacts()"));
    const deps = efeito.slice(0, efeito.indexOf("]") + 1);
    expect(deps).toContain("farmFilter");
    expect(deps).not.toContain("dateFrom");
    expect(deps).not.toContain("dateTo");
  });

  it("1b. a query de contatos não filtra por created_at", () => {
    const bloco = PAGE.slice(PAGE.indexOf("const loadContacts"),
                             PAGE.indexOf("const fetchMessagePage"));
    expect(bloco).not.toContain('.gte("created_at"');
    expect(bloco).not.toContain('.lte("created_at"');
    expect(bloco).toContain('.eq("farm_id", farmFilter)');   // 2. fazenda preservada
  });

  it("5 e 15. as mensagens continuam filtrando por data e por fazenda", () => {
    const bloco = PAGE.slice(PAGE.indexOf("const fetchMessagePage"),
                             PAGE.indexOf("const load = async"));
    expect(bloco).toContain('.gte("created_at", from)');
    expect(bloco).toContain('.lte("created_at", to)');
    expect(bloco).toContain('.eq("farm_id", farmFilter)');
    expect(bloco).toContain('.ilike("phone"');            // 3. seleção de contato
  });

  it("10. o limit(2000) e o limit(5000) mudos foram embora", () => {
    expect(CODE).not.toContain(".limit(2000)");
    expect(CODE).not.toContain(".limit(5000)");
    expect(CODE).not.toMatch(/\.limit\(\d+\)/);   // nenhum teto mudo sobrou
    expect(CODE).toContain(".range(rFrom, rTo)");
  });

  it("a ordenação é estável (created_at + id)", () => {
    const bloco = PAGE.slice(PAGE.indexOf("const fetchMessagePage"),
                             PAGE.indexOf("const load = async"));
    expect(bloco).toContain('.order("created_at", { ascending: false })');
    expect(bloco).toContain('.order("id", { ascending: false })');
  });

  it("13 e 14. CSV e PDF exportam o conjunto completo, não a página visível", () => {
    for (const fn of ["const exportCSV", "const exportPDF"]) {
      const bloco = PAGE.slice(PAGE.indexOf(fn), PAGE.indexOf(fn) + 700);
      expect(bloco, fn).toContain("await fetchAllForExport()");
      expect(bloco, fn).toContain("applyLocalFilters");
    }
    expect(PAGE).toContain("for (const r of all)");   // CSV usa o conjunto todo
    expect(PAGE).toContain("body: all.map((r) => [");  // PDF idem
  });

  it("6. 'Todos os contatos' continua existindo", () => {
    expect(PAGE).toContain("Todos os contatos");
  });

  it("5. estado vazio fala do PERÍODO, não some com o contato", () => {
    expect(PAGE).toContain("Nenhuma mensagem encontrada no período selecionado.");
  });

  it("o teto de segurança avisa em vez de sumir calado", () => {
    expect(PAGE).toContain("contactsTruncated");
    expect(PAGE).toMatch(/pode haver contatos não exibidos/);
  });

  it("12. os dois carregamentos usam guarda de corrida", () => {
    expect(PAGE).toContain("msgGuard.isCurrent(token)");
    expect(PAGE).toContain("contactGuard.isCurrent(token)");
  });

  it("o período padrão da tela é o de 30 dias", () => {
    expect(PAGE).toContain("useState(localDateString(DEFAULT_RANGE_DAYS))");
    expect(PAGE).not.toContain("defaultDate(7)");
  });
});
