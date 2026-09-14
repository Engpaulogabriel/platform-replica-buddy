// @vitest-environment node
// A V1 abortou porque validava o formato HTTP (`functions/v1/scheduled-shutdown`)
// e produção usa o wrapper `SELECT public.cron_invoke('scheduled-shutdown');`.
// A V2 corrige SOMENTE o reconhecimento do comando. Testado em Postgres real
// (pglite) com os regexes EXTRAÍDOS DO ARQUIVO, e com o schema `cron` simulado
// para rodar a migration de ponta a ponta.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const V2_PATH = path.join(REPO,
  "supabase/migrations/20260903130000_scheduled_automations_cron_global_v2.sql");
const V1_PATH = path.join(REPO,
  "supabase/migrations/20260903120000_scheduled_automations_cron_global.sql");
const V2 = fs.readFileSync(V2_PATH, "utf8");
const V1 = fs.readFileSync(V1_PATH, "utf8");

/** Extrai o valor real de uma CONSTANT text := '...'; do arquivo SQL. */
function extraiRegex(sql: string, nome: string): string {
  const m = new RegExp(`${nome}\\s+CONSTANT\\s+text\\s*:=\\s*\\n?\\s*'([\\s\\S]*?)';`).exec(sql);
  if (!m) throw new Error(`regex ${nome} não encontrada no arquivo`);
  return m[1].replace(/''/g, "'");   // desfaz o escape SQL de aspas
}
const RE_WRAPPER = extraiRegex(V2, "c_re_wrapper");
const RE_HTTP = extraiRegex(V2, "c_re_http");

let db: PGlite;
/** Reproduz a checagem da migration: tira comentários e casa os dois padrões. */
async function aceita(cmd: string): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(
    `SELECT (regexp_replace($1, '--[^\\n]*', '', 'g') ~* $2
          OR regexp_replace($1, '--[^\\n]*', '', 'g') ~* $3) AS ok`,
    [cmd, RE_WRAPPER, RE_HTTP]);
  return r.rows[0].ok;
}

beforeAll(async () => { db = new PGlite(); }, 60_000);
afterAll(async () => { await db?.close(); });

describe("1 a 6. reconhecimento do comando", () => {
  it("1. o comando REAL de produção é aceito", async () => {
    expect(await aceita(`SELECT public.cron_invoke('scheduled-shutdown');`)).toBe(true);
  });

  it("2. variações de espaçamento são aceitas", async () => {
    for (const c of [
      `SELECT public.cron_invoke( 'scheduled-shutdown' );`,
      `SELECT public.cron_invoke(\n  'scheduled-shutdown'\n);`,
      `SELECT public . cron_invoke ( 'scheduled-shutdown' ) ;`,
      `SELECT cron_invoke('scheduled-shutdown');`,          // sem schema
    ]) expect(await aceita(c), c).toBe(true);
  });

  it("3. variações de caixa são aceitas", async () => {
    for (const c of [
      `select public.cron_invoke('scheduled-shutdown');`,
      `SELECT PUBLIC.CRON_INVOKE('scheduled-shutdown');`,
    ]) expect(await aceita(c), c).toBe(true);
  });

  it("3b. argumento extra (body jsonb) é aceito", async () => {
    expect(await aceita(
      `SELECT public.cron_invoke('scheduled-shutdown', '{}'::jsonb);`)).toBe(true);
  });

  it("4. o formato HTTP legado continua aceito", async () => {
    expect(await aceita(
      `SELECT net.http_post(url := 'https://x.supabase.co/functions/v1/scheduled-shutdown', body := '{}');`
    )).toBe(true);
  });

  it("5. outra função é REJEITADA", async () => {
    for (const c of [
      `SELECT public.cron_invoke('outra-funcao');`,
      `SELECT public.cron_invoke('critical-alerts-tick');`,
      `SELECT public.cron_invoke('scheduled-shutdown-outro');`,   // prefixo não basta
      `SELECT net.http_post(url := '.../functions/v1/scheduled-shutdown-x');`,
    ]) expect(await aceita(c), c).toBe(false);
  });

  it("6. menção em comentário, sem chamada real, é REJEITADA", async () => {
    for (const c of [
      `-- roda o scheduled-shutdown`,
      `SELECT 1; -- SELECT public.cron_invoke('scheduled-shutdown');`,
      `SELECT public.outra_coisa('x'); -- functions/v1/scheduled-shutdown`,
      `SELECT 'scheduled-shutdown';`,                    // string solta
    ]) expect(await aceita(c), c).toBe(false);
  });

  it("a validação NÃO é uma busca solta pela palavra", async () => {
    expect(await aceita(`SELECT algo_que_menciona_scheduled_shutdown();`)).toBe(false);
    expect(await aceita(`SELECT my_cron_invoke('scheduled-shutdown');`)).toBe(false);
  });
});

// ── Migration completa, com o schema `cron` simulado ───────────────────────
describe("7 a 9. comportamento da migration ponta a ponta", () => {
  const CMD_REAL = `SELECT public.cron_invoke('scheduled-shutdown');`;

  /** Schema `cron` mínimo: tabela job + schedule/unschedule com a semântica real. */
  const CRON_MOCK = `
    DROP SCHEMA IF EXISTS cron CASCADE;
    CREATE SCHEMA cron;
    CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE,
                           schedule text, command text, active boolean DEFAULT true);
    CREATE FUNCTION cron.schedule(_n text, _s text, _c text) RETURNS bigint
      LANGUAGE plpgsql AS $f$
      DECLARE v bigint;
      BEGIN INSERT INTO cron.job (jobname, schedule, command) VALUES (_n,_s,_c)
            RETURNING jobid INTO v; RETURN v; END $f$;
    CREATE FUNCTION cron.unschedule(_n text) RETURNS boolean
      LANGUAGE plpgsql AS $f$
      BEGIN IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname=_n)
              THEN RAISE EXCEPTION 'could not find job %', _n; END IF;
            DELETE FROM cron.job WHERE jobname=_n; RETURN true; END $f$;
  `;

  async function cenario(): Promise<PGlite> {
    const d = new PGlite();
    await d.exec(CRON_MOCK);
    // estado de produção: job antigo + outros jobs que não podem ser tocados
    await d.query(`SELECT cron.schedule('scheduled-shutdown-semear-17h','0-20 20 * * 1-5',$1)`, [CMD_REAL]);
    await d.query(`SELECT cron.schedule('critical-alerts-tick-every-minute','* * * * *',$1)`,
                  [`SELECT public.cron_invoke('critical-alerts-tick');`]);
    await d.query(`SELECT cron.schedule('well-hours-watchdog-tick','*/5 * * * *',$1)`,
                  [`SELECT public.cron_invoke('well-hours-watchdog');`]);
    return d;
  }

  it("7 e 8. aplica, cria UM job por minuto, e é idempotente", async () => {
    const d = await cenario();
    await d.exec(fs.readFileSync(V2_PATH, "utf8"));

    let r = await d.query<{ jobname: string; schedule: string; command: string }>(
      `SELECT jobname, schedule, command FROM cron.job ORDER BY jobname`);
    const nomes = r.rows.map((x) => x.jobname);
    expect(nomes).toContain("scheduled-automations-tick");
    expect(nomes).not.toContain("scheduled-shutdown-semear-17h");
    const novo = r.rows.find((x) => x.jobname === "scheduled-automations-tick")!;
    expect(novo.schedule).toBe("* * * * *");     // 13. a cada minuto
    expect(novo.command).toBe(CMD_REAL);         // comando verbatim, auth preservada

    // 7. segunda aplicação não duplica
    await d.exec(fs.readFileSync(V2_PATH, "utf8"));
    r = await d.query(`SELECT jobname, schedule, command FROM cron.job ORDER BY jobname`);
    expect(r.rows.filter((x) => x.jobname === "scheduled-automations-tick")).toHaveLength(1);
    expect(r.rows).toHaveLength(3);

    // 8. exatamente um job chama scheduled-shutdown
    const c = await d.query<{ n: string }>(
      `SELECT count(*) AS n FROM cron.job
        WHERE regexp_replace(command,'--[^\\n]*','','g') ~* $1`, [RE_WRAPPER]);
    expect(Number(c.rows[0].n)).toBe(1);
    await d.close();
  }, 60_000);

  it("9. nenhum outro job é alterado", async () => {
    const d = await cenario();
    const antes = await d.query<{ jobname: string; schedule: string; command: string }>(
      `SELECT jobname, schedule, command FROM cron.job
        WHERE jobname <> 'scheduled-shutdown-semear-17h' ORDER BY jobname`);
    await d.exec(fs.readFileSync(V2_PATH, "utf8"));
    const depois = await d.query<{ jobname: string; schedule: string; command: string }>(
      `SELECT jobname, schedule, command FROM cron.job
        WHERE jobname NOT IN ('scheduled-shutdown-semear-17h','scheduled-automations-tick')
        ORDER BY jobname`);
    expect(depois.rows).toEqual(antes.rows);
    await d.close();
  }, 60_000);

  it("aborta sem alterar nada se o comando for de outra função", async () => {
    const d = new PGlite();
    await d.exec(CRON_MOCK);
    await d.query(`SELECT cron.schedule('scheduled-shutdown-semear-17h','0-20 20 * * 1-5',$1)`,
                  [`SELECT public.cron_invoke('outra-funcao');`]);
    await expect(d.exec(fs.readFileSync(V2_PATH, "utf8")))
      .rejects.toThrow(/não chama scheduled-shutdown/);
    const r = await d.query<{ jobname: string }>(`SELECT jobname FROM cron.job`);
    expect(r.rows.map((x) => x.jobname)).toEqual(["scheduled-shutdown-semear-17h"]);
    await d.close();
  }, 60_000);

  it("comando que só MENCIONA a chamada em comentário é rejeitado pela migration", async () => {
    // Exercita a limpeza de comentários DENTRO da migration (v_cmd_sem_comentario),
    // não a do helper de teste.
    const d = new PGlite();
    await d.exec(CRON_MOCK);
    await d.query(`SELECT cron.schedule('scheduled-shutdown-semear-17h','0-20 20 * * 1-5',$1)`,
                  [`SELECT public.outra_coisa(); -- SELECT public.cron_invoke('scheduled-shutdown');`]);
    await expect(d.exec(fs.readFileSync(V2_PATH, "utf8")))
      .rejects.toThrow(/não chama scheduled-shutdown/);
    const r = await d.query<{ jobname: string }>(`SELECT jobname FROM cron.job`);
    expect(r.rows.map((x) => x.jobname)).toEqual(["scheduled-shutdown-semear-17h"]);
    await d.close();
  }, 60_000);

  it("A V1 REJEITARIA o comando real — é exatamente o bug corrigido", async () => {
    const d = new PGlite();
    await d.exec(CRON_MOCK);
    await d.query(`SELECT cron.schedule('scheduled-shutdown-semear-17h','0-20 20 * * 1-5',$1)`,
                  [CMD_REAL]);
    await expect(d.exec(fs.readFileSync(V1_PATH, "utf8")))
      .rejects.toThrow(/não chama scheduled-shutdown/);
    await d.close();
  }, 60_000);
});

// ── 10 a 15: escopo preservado ─────────────────────────────────────────────
describe("10 a 15. escopo idêntico ao da V1", () => {
  const sqlOnly = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("10 a 12. não toca tabela, regra, SEMEAR nem SOSSEGO", () => {
    const S = sqlOnly(V2);
    for (const proibido of ["CREATE TABLE", "ALTER TABLE", "DROP POLICY", "CREATE POLICY",
                            "INSERT INTO", "UPDATE ", "DELETE FROM", "scheduled_automations"]) {
      expect(S, proibido).not.toContain(proibido);
    }
    expect(S).not.toMatch(/17:45|17:00|time_brt|farm_id|retry_interval_min|max_retries/);
  });

  it("13. schedule é a cada minuto, e há um único cron.schedule", () => {
    const S = sqlOnly(V2);
    expect(S).toContain("cron.schedule(v_new_name, '* * * * *', v_cmd)");
    expect((S.match(/cron\.schedule\(/g) ?? [])).toHaveLength(1);
  });

  it("nenhuma chave literal e nenhuma mudança de autenticação", () => {
    expect(V2).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(sqlOnly(V2)).not.toMatch(/CRON_SECRET|net\.http_post/);
    expect(sqlOnly(V2)).toContain("cron.schedule(v_new_name, '* * * * *', v_cmd)");
  });

  it("as travas finais continuam presentes", () => {
    const S = sqlOnly(V2);
    expect(S).toContain("v_chamadores <> 1");
    expect(S).toContain("v_outros_antes <> v_outros_depois");
  });

  it("a V1 continua no repositório, intacta", () => {
    expect(fs.existsSync(V1_PATH)).toBe(true);
    expect(V1).toContain("v_cmd NOT ILIKE '%functions/v1/scheduled-shutdown%'");
  });

  it("4. a única diferença de lógica V1→V2 é o reconhecimento do comando", () => {
    const norm = (s: string) => sqlOnly(s)
      .replace(/\s+/g, " ")
      .replace(/v_cmd_sem_comentario[^;]*;/g, "")
      .trim();
    // o núcleo (unschedule/schedule/travas) tem de ser o mesmo
    for (const nucleo of [
      "PERFORM cron.unschedule(v_old_name)",
      "PERFORM cron.unschedule(v_new_name)",
      "PERFORM cron.schedule(v_new_name, '* * * * *', v_cmd)",
      "v_chamadores <> 1",
      "v_outros_antes <> v_outros_depois",
    ]) {
      expect(norm(V1), `V1: ${nucleo}`).toContain(nucleo);
      expect(norm(V2), `V2: ${nucleo}`).toContain(nucleo);
    }
  });
});
