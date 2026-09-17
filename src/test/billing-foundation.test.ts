// @vitest-environment node
// ETAPA 1 do módulo Financeiro: fundação. Postgres 17 real (pglite), rodando a
// migration de verdade — incluindo RLS com SET ROLE, porque superusuário
// ignora RLS e um teste que rodasse como superuser não provaria nada.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const MIG = path.join(REPO, "supabase/migrations/20260905120000_billing_foundation.sql");
const MIG_SQL = fs.readFileSync(MIG, "utf8");

/** Ambiente mínimo que a migration pressupõe: auth, farms, platform_admins. */
const BOOT = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
-- mesma definição do Supabase: sub do JWT
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;

CREATE TABLE public.farms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text,
  license_key text, license_status text DEFAULT 'active');
CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY, created_by uuid,
  notes text, created_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION public.is_platform_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = _user_id);
$$;
`;

let db: PGlite;
const U = { admin: "", finance: "", viewer: "", nobody: "" };
let CUST = "", FARM_A = "", FARM_B = "", FARM_OUTRO = "", CUST2 = "";

/** Executa como um papel/usuário reais — é isso que exercita a RLS. */
interface Rows { rows: unknown[] }
async function asUser(role: "anon" | "authenticated", userId: string | null,
                      sql: string, params: unknown[] = []): Promise<Rows> {
  await db.exec(`SET ROLE ${role};`);
  if (userId) await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  else await db.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  try { return (await db.query(sql, params)) as Rows; }
  finally { await db.exec(`RESET ROLE;`); }
}
const negado = async (role: "anon" | "authenticated", u: string | null, sql: string, p: unknown[] = []) => {
  try { const r = await asUser(role, u, sql, p);
        return Array.isArray(r.rows) ? r.rows.length === 0 : true; }
  catch { return true; }
};

beforeEach(async () => {
  db = new PGlite();
  await db.exec(BOOT);
  await db.exec(MIG_SQL);
  for (const k of Object.keys(U) as Array<keyof typeof U>) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO auth.users (id,email) VALUES (gen_random_uuid(),$1) RETURNING id`, [`${k}@renov.com`]);
    U[k] = r.rows[0].id;
  }
  await db.query(`INSERT INTO public.platform_admins (user_id) VALUES ($1)`, [U.admin]);
  await db.query(`INSERT INTO public.billing_roles (user_id,role) VALUES ($1,'finance'),($2,'finance_viewer')`,
    [U.finance, U.viewer]);
  const f = async (n: string) => (await db.query<{ id: string }>(
    `INSERT INTO public.farms (name) VALUES ($1) RETURNING id`, [n])).rows[0].id;
  FARM_A = await f("SEMEAR"); FARM_B = await f("SOSSEGO"); FARM_OUTRO = await f("TERRA NORTE");
  const c = async (nome: string, doc: string) => (await db.query<{ id: string }>(
    `INSERT INTO public.billing_customers (legal_name,doc_type,doc_number) VALUES ($1,'cnpj',$2) RETURNING id`,
    [nome, doc])).rows[0].id;
  CUST = await c("Grupo Sykue", "12.345.678/0001-90");
  CUST2 = await c("Outro Cliente", "98765432000199");
}, 90_000);
afterEach(async () => { await db?.close(); });

describe("1 a 4. cliente, fazendas e contratos", () => {
  it("1. um cliente pode possuir várias fazendas", async () => {
    await db.query(`INSERT INTO public.billing_customer_farms (customer_id,farm_id) VALUES ($1,$2),($1,$3)`,
      [CUST, FARM_A, FARM_B]);
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM public.billing_customer_farms WHERE customer_id=$1`, [CUST]);
    expect(Number(r.rows[0].n)).toBe(2);
  });

  it("2. a mesma fazenda não pode ser vinculada duas vezes ao cliente", async () => {
    await db.query(`INSERT INTO public.billing_customer_farms (customer_id,farm_id) VALUES ($1,$2)`, [CUST, FARM_A]);
    await expect(db.query(
      `INSERT INTO public.billing_customer_farms (customer_id,farm_id) VALUES ($1,$2)`, [CUST, FARM_A]
    )).rejects.toThrow();
  });

  it("documento duplicado é barrado mesmo com máscara diferente", async () => {
    // '12.345.678/0001-90' já existe; o mesmo CNPJ sem máscara não pode entrar.
    await expect(db.query(
      `INSERT INTO public.billing_customers (legal_name,doc_type,doc_number) VALUES ('Clone','cnpj','12345678000190')`
    )).rejects.toThrow();
  });

  it("3. o contrato cobre um SUBCONJUNTO das fazendas do cliente", async () => {
    await db.query(`INSERT INTO public.billing_customer_farms (customer_id,farm_id) VALUES ($1,$2),($1,$3)`,
      [CUST, FARM_A, FARM_B]);
    const ct = await db.query<{ id: string }>(
      `INSERT INTO public.billing_contracts (customer_id,billing_type,description,amount_cents,start_date)
       VALUES ($1,'taxa_acesso_online','Taxa de acesso online',38000,current_date) RETURNING id`, [CUST]);
    // só a SEMEAR entra no contrato
    await db.query(`INSERT INTO public.billing_contract_farms (contract_id,customer_id,farm_id) VALUES ($1,$2,$3)`,
      [ct.rows[0].id, CUST, FARM_A]);
    const r = await db.query<{ farm_id: string }>(
      `SELECT farm_id FROM public.billing_contract_farms WHERE contract_id=$1`, [ct.rows[0].id]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].farm_id).toBe(FARM_A);
  });

  it("4. contrato NÃO aceita fazenda de outro billing_customer", async () => {
    await db.query(`INSERT INTO public.billing_customer_farms (customer_id,farm_id) VALUES ($1,$2)`, [CUST, FARM_A]);
    await db.query(`INSERT INTO public.billing_customer_farms (customer_id,farm_id) VALUES ($1,$2)`, [CUST2, FARM_OUTRO]);
    const ct = await db.query<{ id: string }>(
      `INSERT INTO public.billing_contracts (customer_id,billing_type,description,amount_cents,start_date)
       VALUES ($1,'mensalidade_plataforma','Mensalidade',280000,current_date) RETURNING id`, [CUST]);
    // fazenda do CUST2 no contrato do CUST — o par (customer_id,farm_id) não existe
    await expect(db.query(
      `INSERT INTO public.billing_contract_farms (contract_id,customer_id,farm_id) VALUES ($1,$2,$3)`,
      [ct.rows[0].id, CUST, FARM_OUTRO])).rejects.toThrow();
    // e mentir o customer_id também não passa: quebra a FK contrato↔cliente
    await expect(db.query(
      `INSERT INTO public.billing_contract_farms (contract_id,customer_id,farm_id) VALUES ($1,$2,$3)`,
      [ct.rows[0].id, CUST2, FARM_OUTRO])).rejects.toThrow();
  });
});

describe("5. cobranças e idempotência", () => {
  const mkContrato = async () => (await db.query<{ id: string }>(
    `INSERT INTO public.billing_contracts (customer_id,billing_type,description,amount_cents,start_date)
     VALUES ($1,'taxa_acesso_online','Taxa',38000,current_date) RETURNING id`, [CUST])).rows[0].id;

  it("5. idempotency_key não pode duplicar", async () => {
    const ct = await mkContrato();
    const ins = (comp: string, key: string) => db.query(
      `INSERT INTO public.billing_charges (contract_id,customer_id,competence_month,due_date,amount_cents,idempotency_key)
       VALUES ($1,$2,$3::date,$3::date + 9,38000,$4)`, [ct, CUST, comp, key]);
    await ins("2026-09-01", "contract:X:2026-09");
    await expect(ins("2026-10-01", "contract:X:2026-09")).rejects.toThrow();
  });

  it("5b. mesma competência do mesmo contrato não duplica nem com outra chave", async () => {
    const ct = await mkContrato();
    const ins = (key: string) => db.query(
      `INSERT INTO public.billing_charges (contract_id,customer_id,competence_month,due_date,amount_cents,idempotency_key)
       VALUES ($1,$2,'2026-09-01','2026-09-10',38000,$3)`, [ct, CUST, key]);
    await ins("k1");
    await expect(ins("k2")).rejects.toThrow();
  });

  it("5c. após cancelar, a competência pode ser reemitida", async () => {
    const ct = await mkContrato();
    await db.query(
      `INSERT INTO public.billing_charges (contract_id,customer_id,competence_month,due_date,amount_cents,idempotency_key)
       VALUES ($1,$2,'2026-09-01','2026-09-10',38000,'k1')`, [ct, CUST]);
    await db.query(`UPDATE public.billing_charges SET status='cancelada' WHERE idempotency_key='k1'`);
    await db.query(
      `INSERT INTO public.billing_charges (contract_id,customer_id,competence_month,due_date,amount_cents,idempotency_key)
       VALUES ($1,$2,'2026-09-01','2026-09-10',38000,'k2')`, [ct, CUST]);
    const r = await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.billing_charges`);
    expect(Number(r.rows[0].n)).toBe(2);
  });

  it("total_cents é gerado e não pode divergir dos componentes", async () => {
    const ct = await mkContrato();
    await db.query(
      `INSERT INTO public.billing_charges (contract_id,customer_id,competence_month,due_date,amount_cents,
         discount_cents,interest_cents,fine_cents,idempotency_key)
       VALUES ($1,$2,'2026-09-01','2026-09-10',38000,1000,500,200,'k')`, [ct, CUST]);
    const r = await db.query<{ t: string }>(`SELECT total_cents t FROM public.billing_charges`);
    expect(Number(r.rows[0].t)).toBe(38000 - 1000 + 500 + 200);
    await expect(db.query(`UPDATE public.billing_charges SET total_cents = 1`)).rejects.toThrow();
  });

  it("pagamento do mesmo evento do provedor não entra duas vezes", async () => {
    const ct = await mkContrato();
    const ch = await db.query<{ id: string }>(
      `INSERT INTO public.billing_charges (contract_id,customer_id,competence_month,due_date,amount_cents,idempotency_key)
       VALUES ($1,$2,'2026-09-01','2026-09-10',38000,'k') RETURNING id`, [ct, CUST]);
    const pay = () => db.query(
      `INSERT INTO public.billing_payments (charge_id,amount_cents,paid_at,method,provider,provider_payment_id)
       VALUES ($1,38000,now(),'pix','psp-x','E2E-123')`, [ch.rows[0].id]);
    await pay();
    await expect(pay()).rejects.toThrow();
  });
});

describe("6 a 10. RLS — quem enxerga o quê", () => {
  beforeEach(async () => {
    await db.query(`INSERT INTO public.billing_customer_farms (customer_id,farm_id) VALUES ($1,$2)`, [CUST, FARM_A]);
  });

  it("6. anon não faz SELECT/INSERT/UPDATE/DELETE", async () => {
    expect(await negado("anon", null, `SELECT * FROM public.billing_customers`)).toBe(true);
    expect(await negado("anon", null,
      `INSERT INTO public.billing_customers (legal_name,doc_type,doc_number) VALUES ('X','cpf','1')`)).toBe(true);
    expect(await negado("anon", null, `UPDATE public.billing_customers SET legal_name='X'`)).toBe(true);
    expect(await negado("anon", null, `DELETE FROM public.billing_customers`)).toBe(true);
  });

  it("7. authenticated sem papel financeiro não enxerga nada", async () => {
    const r = await asUser("authenticated", U.nobody, `SELECT * FROM public.billing_customers`);
    expect(r.rows).toHaveLength(0);
    expect(await negado("authenticated", U.nobody,
      `INSERT INTO public.billing_customers (legal_name,doc_type,doc_number) VALUES ('X','cpf','111')`)).toBe(true);
  });

  it("8. finance_viewer lê, mas NÃO altera", async () => {
    const r = await asUser("authenticated", U.viewer, `SELECT id FROM public.billing_customers`);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(await negado("authenticated", U.viewer,
      `INSERT INTO public.billing_customers (legal_name,doc_type,doc_number) VALUES ('X','cpf','222')`)).toBe(true);
    const up = await asUser("authenticated", U.viewer,
      `UPDATE public.billing_customers SET legal_name='Hackeado' RETURNING id`);
    expect(up.rows).toHaveLength(0);
    const del = await asUser("authenticated", U.viewer, `DELETE FROM public.billing_customers RETURNING id`);
    expect(del.rows).toHaveLength(0);
  });

  it("9. finance opera: lê, cria, edita", async () => {
    const r = await asUser("authenticated", U.finance, `SELECT id FROM public.billing_customers`);
    expect(r.rows.length).toBeGreaterThan(0);
    const ins = await asUser("authenticated", U.finance,
      `INSERT INTO public.billing_customers (legal_name,doc_type,doc_number)
       VALUES ('Novo Cliente','cnpj','11222333000144') RETURNING id`);
    expect(ins.rows).toHaveLength(1);
    const up = await asUser("authenticated", U.finance,
      `UPDATE public.billing_customers SET notes='ok' WHERE id=$1 RETURNING id`, [CUST]);
    expect(up.rows).toHaveLength(1);
  });

  it("10. platform_admin tem acesso administrativo, inclusive a billing_roles", async () => {
    const r = await asUser("authenticated", U.admin, `SELECT id FROM public.billing_customers`);
    expect(r.rows.length).toBeGreaterThan(0);
    const roles = await asUser("authenticated", U.admin, `SELECT user_id FROM public.billing_roles`);
    expect(roles.rows.length).toBe(2);
    // financeiro NÃO administra papéis — só o admin da plataforma
    const rf = await asUser("authenticated", U.finance, `SELECT user_id FROM public.billing_roles`);
    expect(rf.rows).toHaveLength(0);
  });

  it("a view billing_customer_status respeita RLS (security_invoker)", async () => {
    const nada = await asUser("authenticated", U.nobody, `SELECT * FROM public.billing_customer_status`);
    expect(nada.rows).toHaveLength(0);
    const ve = await asUser("authenticated", U.viewer, `SELECT * FROM public.billing_customer_status`);
    expect(ve.rows.length).toBeGreaterThan(0);
  });
});

describe("11. trilha append-only", () => {
  it("11. billing_events não sofre UPDATE nem DELETE", async () => {
    await db.query(`INSERT INTO public.billing_events (entity_type,event,actor_kind)
                    VALUES ('billing_charges','created','manual')`);
    await expect(db.query(`UPDATE public.billing_events SET event='alterado'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM public.billing_events`)).rejects.toThrow();
    const r = await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.billing_events`);
    expect(Number(r.rows[0].n)).toBe(1);
  });

  it("nem o financeiro tem privilégio de UPDATE/DELETE na trilha", async () => {
    await db.query(`INSERT INTO public.billing_events (entity_type,event,actor_kind)
                    VALUES ('billing_charges','created','manual')`);
    expect(await negado("authenticated", U.finance, `UPDATE public.billing_events SET event='x'`)).toBe(true);
    expect(await negado("authenticated", U.finance, `DELETE FROM public.billing_events`)).toBe(true);
  });
});

describe("12. BARREIRA: o financeiro não toca na operação", () => {
  const PROIBIDOS = [
    "platform_set_farm_suspended", "platform_toggle_suspend",
    "license_key", "license_status",
    "commands", "equipments", "automation_schedules", "automation_engine",
    "scheduled_automations", "scheduled_shutdowns", "run_automation_tick",
    "run_peak_hour_tick", "enqueue_reset_pump_command", "desired_running",
    "pending_command_id", "main.cjs",
  ];
  /** o cabeçalho CITA os símbolos proibidos para explicar a barreira; o teste
   *  tem de olhar o CÓDIGO, não os comentários. */
  const codigo = MIG_SQL.split("\n")
    .filter((l) => !l.trim().startsWith("--")).join("\n");

  it("12. nenhum símbolo operacional aparece no código da migration", () => {
    for (const p of PROIBIDOS) expect(codigo, p).not.toContain(p);
  });

  it("a migration não escreve em farms — só a referencia por FK de identidade", () => {
    expect(codigo).not.toMatch(/UPDATE\s+public\.farms/i);
    expect(codigo).not.toMatch(/DELETE\s+FROM\s+public\.farms/i);
    expect(codigo).not.toMatch(/ALTER\s+TABLE\s+public\.farms/i);
    expect(codigo).toContain("REFERENCES public.farms(id)");
  });

  it("o status de contrato não tem 'suspenso' — evita confusão com a operação", () => {
    expect(codigo).toContain("'rascunho', 'ativo', 'pausado', 'encerrado', 'cancelado'");
    expect(codigo).not.toMatch(/billing_contract_status[\s\S]{0,200}suspenso/);
  });

  it("nenhuma policy ampla baseada só em authenticated", () => {
    expect(codigo).not.toMatch(/USING\s*\(\s*true\s*\)/i);
    expect(codigo).not.toMatch(/WITH CHECK\s*\(\s*true\s*\)/i);
    // toda policy passa por uma das três funções de autorização
    const policies = codigo.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    for (const p of policies) expect(p).toMatch(/can_(read|write|admin)_billing\(auth\.uid\(\)\)/);
  });

  it("anon é revogado explicitamente em toda tabela e função", () => {
    expect(codigo).toContain("REVOKE ALL ON public.%I FROM PUBLIC, anon;");
    expect(codigo).toMatch(/REVOKE ALL ON FUNCTION public\.can_read_billing\(uuid\)\s+FROM PUBLIC, anon;/);
    expect(codigo).toMatch(/REVOKE ALL ON public\.billing_customer_status FROM PUBLIC, anon;/);
  });
});
