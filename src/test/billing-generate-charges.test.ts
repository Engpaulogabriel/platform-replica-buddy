// @vitest-environment node
// SPRINT 2 — geração automática de cobranças. Postgres 17 real (pglite).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const rd = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
const M0 = rd("20260905120000_billing_foundation.sql");
const M3 = rd("20260909120000_billing_generate_charges.sql");

const BOOT = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
CREATE TABLE public.farms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.is_platform_admin(_u uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id=_u); $$;
`;

let db: PGlite; let CUST = "", CUST2 = "";
interface Res { ok: boolean; charges_created: number; already_existed: number; contracts_evaluated: number }

const contrato = async (o: {
  per?: string; status?: string; start?: string; end?: string | null;
  due?: number; valor?: number; cust?: string;
} = {}) => (await db.query<{ id: string }>(
  `INSERT INTO public.billing_contracts (customer_id,billing_type,description,amount_cents,
     periodicity,due_day,start_date,end_date,status)
   VALUES ($1,'taxa_acesso_online','C',$2,$3::public.billing_periodicity,$4,$5::date,$6::date,
           $7::public.billing_contract_status) RETURNING id`,
  [o.cust ?? CUST, o.valor ?? 38000, o.per ?? "mensal", o.due ?? 10,
   o.start ?? "2026-01-15", o.end ?? null, o.status ?? "ativo"])).rows[0].id;

const gerar = async (ref: string): Promise<Res> =>
  (await db.query<{ r: Res }>(
    `SELECT public.billing_generate_charges($1::date) AS r`, [ref])).rows[0].r;

const comps = async () => (await db.query<{ c: string }>(
  `SELECT to_char(competence_month,'YYYY-MM') c FROM public.billing_charges ORDER BY competence_month`))
  .rows.map((x) => x.c);

beforeEach(async () => {
  db = new PGlite(); await db.exec(BOOT); await db.exec(M0); await db.exec(M3);
  const c = async (doc: string) => (await db.query<{ id: string }>(
    `INSERT INTO public.billing_customers (legal_name,doc_type,doc_number)
     VALUES ('C'||$1,'cnpj',$1) RETURNING id`, [doc])).rows[0].id;
  CUST = await c("11222333000181"); CUST2 = await c("529982247250");
}, 90_000);
afterEach(async () => { await db?.close(); });

describe("periodicidade determinística", () => {
  it("mensal gera todo mês", async () => {
    await contrato({ per: "mensal", start: "2026-01-15" });
    for (const ref of ["2026-01-20", "2026-02-05", "2026-03-01"]) await gerar(ref);
    expect(await comps()).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("bimestral ancora no mês de início, não no mês corrente", async () => {
    await contrato({ per: "bimestral", start: "2026-02-10" });
    for (const ref of ["2026-02-20","2026-03-20","2026-04-20","2026-05-20"]) await gerar(ref);
    expect(await comps()).toEqual(["2026-02", "2026-04"]);   // fev, abr — não jan/mar
  });

  it("trimestral: fev → mai → ago", async () => {
    await contrato({ per: "trimestral", start: "2026-02-01" });
    for (const ref of ["2026-02-05","2026-03-05","2026-05-05","2026-08-05"]) await gerar(ref);
    expect(await comps()).toEqual(["2026-02", "2026-05", "2026-08"]);
  });

  it("semestral: mar → set", async () => {
    await contrato({ per: "semestral", start: "2026-03-01" });
    for (const ref of ["2026-03-02","2026-06-02","2026-09-02"]) await gerar(ref);
    expect(await comps()).toEqual(["2026-03", "2026-09"]);
  });

  it("anual gera uma vez por ano, no mês de aniversário", async () => {
    await contrato({ per: "anual", start: "2026-05-20" });
    for (const ref of ["2026-05-25","2026-11-25","2027-05-25"]) await gerar(ref);
    expect(await comps()).toEqual(["2026-05", "2027-05"]);
  });
});

describe("vigência", () => {
  it("contrato iniciado no meio do mês gera a competência do mês de início", async () => {
    await contrato({ start: "2026-03-17", due: 5 });
    await gerar("2026-03-20");
    const r = await db.query<{ c: string; v: string }>(
      `SELECT to_char(competence_month,'YYYY-MM') c, to_char(due_date,'YYYY-MM-DD') v FROM billing_charges`);
    expect(r.rows[0].c).toBe("2026-03");
    expect(r.rows[0].v).toBe("2026-03-05");
  });

  it("antes do start_date não gera nada", async () => {
    await contrato({ start: "2026-06-01" });
    expect((await gerar("2026-05-31")).charges_created).toBe(0);
  });

  it("depois do end_date não gera mais", async () => {
    await contrato({ start: "2026-01-01", end: "2026-02-28" });
    await gerar("2026-01-10"); await gerar("2026-02-10"); await gerar("2026-03-10");
    expect(await comps()).toEqual(["2026-01", "2026-02"]);
  });
});

describe("status do contrato — só ativo gera", () => {
  for (const st of ["rascunho", "pausado", "encerrado", "cancelado"]) {
    it(`${st} NÃO gera cobrança`, async () => {
      await contrato({ status: st });
      const r = await gerar("2026-03-10");
      expect(r.charges_created).toBe(0);
      expect(r.contracts_evaluated).toBe(0);   // nem entra no laço
    });
  }
  it("ativo gera", async () => {
    await contrato({ status: "ativo" });
    expect((await gerar("2026-03-10")).charges_created).toBe(1);
  });
});

describe("vencimento — fevereiro, bissexto e meses curtos", () => {
  it("due_day 28 é válido em fevereiro comum e bissexto", async () => {
    await contrato({ due: 28, start: "2026-02-01", end: "2026-02-28" });   // 2026 comum
    await gerar("2026-02-05");
    await contrato({ due: 28, start: "2028-02-01", cust: CUST2 });   // 2028 bissexto
    await gerar("2028-02-05");
    const r = await db.query<{ v: string }>(
      `SELECT to_char(due_date,'YYYY-MM-DD') v FROM billing_charges ORDER BY due_date`);
    expect(r.rows.map((x) => x.v)).toEqual(["2026-02-28", "2028-02-28"]);
  });

  it("due_day acima de 28 é impossível — o CHECK da fundação barra", async () => {
    // Garantia ESTRUTURAL: nunca há data inválida a corrigir na geração.
    await expect(contrato({ due: 31 })).rejects.toThrow();
    await expect(contrato({ due: 0 })).rejects.toThrow();
  });

  it("meses de 30 e 31 dias com due_day 28", async () => {
    await contrato({ due: 28, start: "2026-04-01" });   // abril = 30
    await gerar("2026-04-02"); await gerar("2026-05-02");   // maio = 31
    const r = await db.query<{ v: string }>(
      `SELECT to_char(due_date,'YYYY-MM-DD') v FROM billing_charges ORDER BY due_date`);
    expect(r.rows.map((x) => x.v)).toEqual(["2026-04-28", "2026-05-28"]);
  });
});

describe("idempotência", () => {
  it("segunda execução no mesmo dia não duplica", async () => {
    await contrato();
    const a = await gerar("2026-03-10");
    const b = await gerar("2026-03-10");
    expect(a.charges_created).toBe(1);
    expect(b.charges_created).toBe(0);
    expect(b.already_existed).toBe(1);
    expect(await comps()).toEqual(["2026-03"]);
  });

  it("dez execuções seguidas continuam com uma linha", async () => {
    await contrato();
    for (let i = 0; i < 10; i++) await gerar("2026-03-10");
    expect(await comps()).toHaveLength(1);
  });

  it("cron rodando duas vezes no dia é inofensivo", async () => {
    await contrato();
    await db.query(`SELECT public.billing_generate_charges()`);
    await db.query(`SELECT public.billing_generate_charges()`);
    const n = await db.query<{ n: number }>(`SELECT count(*)::int n FROM billing_charges`);
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it("competência já criada por outro caminho não é duplicada", async () => {
    const ct = await contrato();
    await db.query(
      `INSERT INTO billing_charges (contract_id,customer_id,competence_month,due_date,amount_cents,idempotency_key)
       VALUES ($1,$2,'2026-03-01','2026-03-10',38000,'manual-x')`, [ct, CUST]);
    // o unique parcial (contract_id, competence_month) da fundação protege
    let erro = false;
    try { await gerar("2026-03-10"); } catch { erro = true; }
    const n = await db.query<{ n: number }>(`SELECT count(*)::int n FROM billing_charges`);
    expect(Number(n.rows[0].n)).toBe(1);
    expect(erro).toBe(true);   // falha explícita, não duplicata silenciosa
  });
});

describe("múltiplos contratos, clientes e auditoria", () => {
  it("gera para vários contratos e clientes numa passada", async () => {
    await contrato({ cust: CUST }); await contrato({ cust: CUST, per: "anual" });
    await contrato({ cust: CUST2 }); await contrato({ cust: CUST2, status: "pausado" });
    const r = await gerar("2026-03-10");
    expect(r.contracts_evaluated).toBe(3);   // o pausado não entra
    expect(r.charges_created).toBe(3);
  });

  it("cada cobrança gerada registra billing_events", async () => {
    await contrato();
    await gerar("2026-03-10");
    const e = await db.query<{ event: string; actor_kind: string }>(
      `SELECT event, actor_kind FROM billing_events`);
    expect(e.rows[0].event).toBe("charge_generated");
    expect(e.rows[0].actor_kind).toBe("automatic");
  });

  it("a cobrança nasce como 'prevista' com o valor do contrato", async () => {
    await contrato({ valor: 280000 });
    await gerar("2026-03-10");
    const c = await db.query<{ status: string; amount_cents: string; total_cents: string }>(
      `SELECT status::text, amount_cents::text, total_cents::text FROM billing_charges`);
    expect(c.rows[0].status).toBe("prevista");
    expect(Number(c.rows[0].amount_cents)).toBe(280000);
    expect(Number(c.rows[0].total_cents)).toBe(280000);
  });
});

describe("isolamento e cron", () => {
  const codigo = M3.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  it("nenhuma referência a tabela operacional", () => {
    for (const p of ["public.farms", "public.equipments", "public.commands", "desired_running",
                     "automation_", "scheduled_shutdown", "device_licenses", "license_key",
                     "platform_set_farm_suspended"]) {
      expect(codigo, p).not.toContain(p);
    }
  });
  it("não cria tabela, enum nem índice — só funções", () => {
    expect(codigo).not.toMatch(/CREATE\s+TABLE/i);
    expect(codigo).not.toMatch(/CREATE\s+TYPE/i);
    expect(codigo).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
    expect(codigo).not.toMatch(/ALTER\s+TABLE/i);
  });
  it("um único cron, chamando só a RPC", () => {
    const jobs = codigo.match(/cron\.schedule\(/g) ?? [];
    expect(jobs).toHaveLength(1);
    expect(codigo).toContain("'SELECT public.billing_generate_charges();'");
    expect(codigo).toContain("cron.unschedule('billing-generate-charges-daily')");
  });
  it("reutiliza a idempotência existente da fundação", () => {
    expect(codigo).toContain("ON CONFLICT (idempotency_key)");
    expect(codigo).toContain("'contract:' || v_ct.id::text || ':' || to_char(v_comp, 'YYYY-MM')");
  });
});
