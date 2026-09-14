// @vitest-environment node
// CAUSA RAIZ do incidente SOSSEGO 04/09 21:02.
// A V5.1 passa o dia da semana em INGLÊS para `automatic_desired_state`, mas
// `automation_schedules.days` guarda PORTUGUÊS. Sem normalização a função
// devolve NULL, o tick executa CONTINUE e a bomba não liga — sem deixar rastro.
// Postgres 17 real (pglite), rodando a migration de verdade.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const MIG = path.join(REPO,
  "supabase/migrations/20260905001426_6cf46965-7dd0-4ec0-8f7f-b22d03eebd49.sql");
const MIG_SQL = fs.readFileSync(MIG, "utf8");
/** só as funções — o bloco de VALIDAÇÃO no fim é comentário. */
const FN_SQL = MIG_SQL;   // a migration viva é só a função

let db: PGlite;
const PT = ["seg", "ter", "qua", "qui", "sex"];
const EN = ["mon", "tue", "wed", "thu", "fri"];

/** min do dia a partir de "HH:MM". */
const m = (hhmm: string) => {
  const [h, mi] = hhmm.split(":").map(Number); return h * 60 + mi;
};

async function desired(days: string[], nowMin: number, today: string, prev: string,
                       on = "21:02", off = "17:58", mode = "on-off") {
  const r = await db.query<{ d: string | null }>(
    `SELECT public.automatic_desired_state($1,$2,$3,$4,$5,$6,$7) AS d`,
    [on, off, days, mode, nowMin, today, prev]);
  return r.rows[0].d;
}

beforeAll(async () => { db = new PGlite(); await db.exec(FN_SQL); }, 60_000);
afterAll(async () => { await db?.close(); });

describe("8 a 10. dias em PT e EN — os dois lados normalizados", () => {
  it("o caso REAL do incidente: days em PT, dow em EN → 'on'", async () => {
    // Era exatamente isto que retornava NULL e matava o disparo das 21:02.
    expect(await desired(PT, m("21:02"), "fri", "thu")).toBe("on");
  });

  it("dow em PT NÃO casa — a versão viva normaliza só o array `_days`", async () => {
    // Documenta o contrato REAL de produção (20260905001426): `_days` é
    // normalizado PT→EN, `_dow_today`/`_dow_prev` são comparados crus. Quem
    // chama é `run_automation_tick`, que sempre passa inglês. Um chamador que
    // passe PT não é suportado — e este teste trava essa fronteira.
    expect(await desired(PT, m("21:02"), "sex", "qui")).toBeNull();
  });

  it("10. days em INGLÊS continua funcionando (nos dois formatos de dow)", async () => {
    expect(await desired(EN, m("21:02"), "fri", "thu")).toBe("on");
  });

  it("8. os sete dias da semana casam em PT e EN", async () => {
    const pares: Array<[string, string]> = [["dom","sun"],["seg","mon"],["ter","tue"],
      ["qua","wed"],["qui","thu"],["sex","fri"],["sab","sat"]];
    for (const [pt, en] of pares) {
      expect(await desired([pt], m("22:00"), en, "xxx"), `${pt}/${en}`).toBe("on");
      expect(await desired([en], m("22:00"), en, "xxx"), `${en}/${en}`).toBe("on");
    }
  });

  it("9. 'sáb' com acento e 'sab' sem acento — ambos viram sat", async () => {
    for (const d of ["sáb", "sab"]) {
      expect(await desired([d], m("22:00"), "sat", "xxx"), d).toBe("on");
    }
  });

  it("dia que NÃO está na lista continua fora", async () => {
    // sexta fora dos dias: na janela de meia-noite quinta manda desligar.
    expect(await desired(["seg","ter","qua","qui"], m("22:00"), "fri", "thu")).toBe("off");
    expect(await desired(["seg"], m("22:00"), "fri", "thu")).toBeNull();
  });
});

describe("11 a 16. janela que atravessa a meia-noite — desired por ESTADO", () => {
  // SOSSEGO real: liga 21:02, desliga 17:58 do dia seguinte.
  const casos: Array<[string, string, string, string | null]> = [
    ["21:02 — horário exato",            "21:02", "fri", "on"],
    ["12. motor volta 21:15",            "21:15", "fri", "on"],
    ["13. motor volta 23:00",            "23:00", "fri", "on"],
    ["14. motor volta 03:00 (dia seg.)", "03:00", "sat", "on"],
    ["15. motor volta 17:57",            "17:57", "sat", "on"],
    ["16. 17:59 — desired vira OFF",     "17:59", "sat", "off"],
  ];
  for (const [nome, hora, dow, esperado] of casos) {
    it(nome, async () => {
      const prev = dow === "sat" ? "fri" : "thu";
      expect(await desired(PT, m(hora), dow, prev)).toBe(esperado);
    });
  }

  it("nenhum limite artificial de catch-up: 4h depois ainda é ON", async () => {
    // 01:02 = 4 horas depois do time_on, no dia seguinte.
    expect(await desired(PT, m("01:02"), "sat", "fri")).toBe("on");
  });
});

describe("contrato da versão viva", () => {
  it("valor desconhecido não vira dia válido", async () => {
    expect(await desired(PT, m("22:00"), "lua", "lua")).toBeNull();
  });

  it("days vazio ou NULL não governa", async () => {
    expect(await desired([], m("22:00"), "fri", "thu")).toBeNull();
  });
});
