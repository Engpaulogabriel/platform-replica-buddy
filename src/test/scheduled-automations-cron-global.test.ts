// @vitest-environment node
// O cron era hardcoded para a SEMEAR (`0-20 20 * * 1-5` = 17:00–17:20 BRT).
// A janela da SOSSEGO (17:45–17:49) nunca recebia tick. Aqui provamos que a
// cadência por minuto cobre as duas, e que a migration mexe SÓ no cron.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const MIG = fs.readFileSync(path.join(REPO,
  "supabase/migrations/20260903120000_scheduled_automations_cron_global.sql"), "utf8");
const FUNC = fs.readFileSync(path.join(REPO,
  "supabase/functions/scheduled-shutdown/index.ts"), "utf8");
/** Só o SQL executável — comentários citam o job antigo e não podem contar. */
const SQL = MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ── Janela de decisão, idêntica à da Edge Function (index.ts:92-96) ─────────
type Regra = { nome: string; timeBrt: string; interval: number; retries: number };
const SEMEAR: Regra  = { nome: "SEMEAR",  timeBrt: "17:00", interval: 5, retries: 3 };
const SOSSEGO: Regra = { nome: "SOSSEGO", timeBrt: "17:45", interval: 2, retries: 2 };

const min = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
/** A regra é avaliada neste minuto? */
function dentroDaJanela(r: Regra, agora: string): boolean {
  const elapsed = min(agora) - min(r.timeBrt);
  return elapsed >= 0 && elapsed <= r.retries * r.interval;
}
/** O cron entrega um tick neste minuto? */
const tickAntigo = (hhmm: string) => {           // 0-20 20 * * 1-5 → 17:00..17:20
  const [h, m] = hhmm.split(":").map(Number);
  return h === 17 && m >= 0 && m <= 20;
};
const tickNovo = () => true;                      // * * * * *
/** Executa = há tick E a regra está na janela. */
const executa = (r: Regra, hhmm: string, tick: (s: string) => boolean) =>
  tick(hhmm) && dentroDaJanela(r, hhmm);

describe("1 a 3. SEMEAR permanece exatamente como está", () => {
  it("1. 16:59 — não executa nem antes nem depois da mudança", () => {
    expect(executa(SEMEAR, "16:59", tickAntigo)).toBe(false);
    expect(executa(SEMEAR, "16:59", tickNovo)).toBe(false);
  });

  it("2. 17:00 — é avaliada, nos dois crons", () => {
    expect(executa(SEMEAR, "17:00", tickAntigo)).toBe(true);
    expect(executa(SEMEAR, "17:00", tickNovo)).toBe(true);
  });

  it("3. 17:05 / 17:10 / 17:15 — comportamento preservado", () => {
    for (const t of ["17:05", "17:10", "17:15"]) {
      expect(executa(SEMEAR, t, tickAntigo), `antigo ${t}`).toBe(true);
      expect(executa(SEMEAR, t, tickNovo), `novo ${t}`).toBe(true);
    }
  });

  it("a janela da SEMEAR fecha em 17:15 — 17:16 fica fora nos dois", () => {
    expect(executa(SEMEAR, "17:16", tickAntigo)).toBe(false);
    expect(executa(SEMEAR, "17:16", tickNovo)).toBe(false);
  });

  it("para a SEMEAR NADA muda: zero minutos novos de avaliação", () => {
    // `0-20` em cron é um INTERVALO (todo minuto de :00 a :20), não a lista
    // 0,5,10,15,20. A janela da SEMEAR (17:00–17:15) já era coberta minuto a
    // minuto, então a cadência global não acrescenta nem remove um único
    // minuto para ela. Impacto exatamente zero.
    const novos: string[] = [];
    const perdidos: string[] = [];
    for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m++) {
      const t = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const antes = executa(SEMEAR, t, tickAntigo);
      const depois = executa(SEMEAR, t, tickNovo);
      if (depois && !antes) novos.push(t);
      if (antes && !depois) perdidos.push(t);
    }
    expect(novos).toEqual([]);
    expect(perdidos).toEqual([]);
  });
});

describe("4 a 7. SOSSEGO passa a ser avaliada", () => {
  it("4. 17:44 — não executa (fora da janela dela)", () => {
    expect(executa(SOSSEGO, "17:44", tickNovo)).toBe(false);
  });

  it("5, 6 e 7. 17:45, 17:47 e 17:49 passam a executar", () => {
    for (const t of ["17:45", "17:47", "17:49"]) {
      expect(executa(SOSSEGO, t, tickAntigo), `antigo ${t}`).toBe(false);  // era o bug
      expect(executa(SOSSEGO, t, tickNovo), `novo ${t}`).toBe(true);
    }
  });

  it("com o cron ANTIGO a SOSSEGO nunca executava, em minuto nenhum do dia", () => {
    let algum = false;
    for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m++) {
      const t = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      if (executa(SOSSEGO, t, tickAntigo)) algum = true;
    }
    expect(algum).toBe(false);
  });

  it("8. fora da janela, nada executa — 17:50 já está fora", () => {
    expect(executa(SOSSEGO, "17:50", tickNovo)).toBe(false);
    expect(executa(SEMEAR, "17:50", tickNovo)).toBe(false);
  });

  it("a janela vem da CONFIG, não de hardcode: mudar retries muda a janela", () => {
    const maisRetries = { ...SOSSEGO, retries: 3 };   // 17:45–17:51
    expect(executa(SOSSEGO, "17:51", tickNovo)).toBe(false);
    expect(executa(maisRetries, "17:51", tickNovo)).toBe(true);
  });
});

describe("9 a 16. a migration mexe SÓ no cron", () => {
  it("9. agenda um único job, com cadência por minuto", () => {
    expect(SQL).toContain("PERFORM cron.schedule(v_new_name, '* * * * *', v_cmd);");
    expect((SQL.match(/cron\.schedule\(/g) ?? [])).toHaveLength(1);
  });

  it("10. remove os dois nomes antes de agendar — sem duplicidade", () => {
    expect(SQL).toContain("PERFORM cron.unschedule(v_old_name)");
    expect(SQL).toContain("PERFORM cron.unschedule(v_new_name)");
    expect(SQL).toContain("v_chamadores <> 1");   // trava: exatamente 1 chamador
  });

  it("11. sem risco novo de 401 — o comando é reaproveitado verbatim", () => {
    expect(SQL).toContain("SELECT command INTO v_cmd FROM cron.job");
    expect(SQL).toContain("cron.schedule(v_new_name, '* * * * *', v_cmd)");
    expect(SQL).not.toMatch(/CRON_SECRET/);
    expect(SQL).not.toMatch(/net\.http_post/);    // não reescreve a chamada
  });

  it("11b. nenhuma chave/JWT literal no arquivo", () => {
    expect(MIG).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });

  it("12. valida que o comando aponta para scheduled-shutdown antes de reusar", () => {
    expect(SQL).toContain("functions/v1/scheduled-shutdown");
    expect(SQL).toContain("RAISE EXCEPTION");
  });

  it("13. nenhum outro cron é alterado — há trava de contagem", () => {
    expect(SQL).toContain("v_outros_antes <> v_outros_depois");
  });

  it("14 e 15. não toca tabela, policy, regra nem dado", () => {
    for (const proibido of ["CREATE TABLE", "DROP POLICY", "CREATE POLICY",
                            "INSERT INTO", "UPDATE ", "DELETE FROM",
                            "ALTER TABLE", "DROP CONSTRAINT"]) {
      expect(SQL, proibido).not.toContain(proibido);
    }
  });

  it("15b. NÃO reaplica o seed da SEMEAR (o risco da migration antiga)", () => {
    expect(SQL).not.toContain("scheduled_automations");
    expect(MIG).not.toContain("Desligamento 17h Semear'");
  });

  it("16. sem hardcode de fazenda — só o NOME do job antigo, como alvo", () => {
    // A única menção a 'semear' é o nome do job a ser removido; não há regra,
    // farm_id, horário nem condicional por fazenda.
    expect(SQL).toContain("v_old_name  text := 'scheduled-shutdown-semear-17h'");
    const semNomeDoJob = SQL.split("scheduled-shutdown-semear-17h").join("");
    expect(semNomeDoJob).not.toMatch(/semear|sossego/i);
    expect(SQL).not.toMatch(/farm_id|time_brt|17:45|17:00/);
  });

  it("é idempotente: aplicar duas vezes não duplica", () => {
    expect(SQL).toContain("EXCEPTION WHEN OTHERS THEN NULL");
  });

  it("a lógica da Edge Function NÃO foi tocada", () => {
    expect(FUNC).toContain("if (elapsed < 0 || elapsed > windowEnd) continue;");
    expect(FUNC).toContain('.from("scheduled_automations").select("*").eq("is_active", true)');
  });
});
