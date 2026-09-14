// @vitest-environment node
// SPRINT 1 — Dashboard Financeiro. RPC em Postgres 17 real (pglite) + helpers puros.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
import { centsToBRL, centsToCompactBRL, pctBR, monthLabel, dateBR,
         BILLING_TYPE_LABEL, CHARGE_STATUS_LABEL } from "@/lib/billingFormat";

const REPO = path.resolve(__dirname, "../..");
const rd = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
const M0 = rd("20260905120000_billing_foundation.sql");
const M2 = rd("20260908180000_billing_dashboard_summary.sql");

const BOOT = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
CREATE TABLE public.farms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.is_platform_admin(_u uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id=_u); $$;
`;

interface Dash {
  mrr_cents: number; billed_month_cents: number; received_month_cents: number;
  open_cents: number; overdue_cents: number; delinquency_pct: number;
  delinquent_customers: number; active_contracts: number;
  revenue_by_type: Array<{ type: string; billed_cents: number }>;
  monthly_history: Array<{ month: string; billed_cents: number; received_cents: number }>;
  upcoming_due: unknown[]; recent_payments: unknown[]; recent_charges: unknown[];
}
let db: PGlite; let FIN = "", VIEW = "", NINGUEM = "", CUST = "", CT = "";

const asUser = async (role: string, u: string | null, sql: string) => {
  await db.exec(`SET ROLE ${role};`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [u ?? ""]);
  try { return await db.query(sql); } finally { await db.exec(`RESET ROLE;`); }
};
const dash = async (u = FIN): Promise<Dash> => {
  const r = await asUser("authenticated", u, `SELECT public.billing_dashboard_summary() AS d`);
  return (r.rows[0] as { d: Dash }).d;
};
const mesAtual = () => new Date().toISOString().slice(0, 7) + "-01";

beforeEach(async () => {
  db = new PGlite(); await db.exec(BOOT); await db.exec(M0); await db.exec(M2);
  const mk = async () => (await db.query<{ id: string }>(
    `INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
  FIN = await mk(); VIEW = await mk(); NINGUEM = await mk();
  await db.query(`INSERT INTO public.billing_roles (user_id,role) VALUES ($1,'finance'),($2,'finance_viewer')`, [FIN, VIEW]);
  CUST = (await db.query<{ id: string }>(
    `INSERT INTO public.billing_customers (legal_name,doc_type,doc_number)
     VALUES ('Sykue','cnpj','11222333000181') RETURNING id`)).rows[0].id;
  CT = (await db.query<{ id: string }>(
    `INSERT INTO public.billing_contracts (customer_id,billing_type,description,amount_cents,periodicity,start_date,status)
     VALUES ($1,'taxa_acesso_online','Taxa',38000,'mensal',current_date - 60,'ativo') RETURNING id`, [CUST])).rows[0].id;
}, 90_000);
afterEach(async () => { await db?.close(); });

const cobranca = async (opts: { total?: number; venc?: string; comp?: string; status?: string } = {}) =>
  (await db.query<{ id: string }>(
    `INSERT INTO public.billing_charges (contract_id,customer_id,competence_month,due_date,amount_cents,status,idempotency_key)
     VALUES ($1,$2,$3::date,$4::date,$5,$6::public.billing_charge_status,'k'||gen_random_uuid())
     RETURNING id`,
    [CT, CUST, opts.comp ?? mesAtual(), opts.venc ?? new Date().toISOString().slice(0,10),
     opts.total ?? 38000, opts.status ?? "aberta"])).rows[0].id;

describe("indicadores derivados", () => {
  it("dashboard vazio devolve zeros, não erro", async () => {
    const d = await dash();
    expect(d.billed_month_cents).toBe(0);
    expect(d.overdue_cents).toBe(0);
    expect(d.delinquency_pct).toBe(0);      // divisor zero não explode
    expect(d.monthly_history).toHaveLength(12);   // 12 meses sempre presentes
  });

  it("MRR normaliza a periodicidade para mês", async () => {
    await db.query(`INSERT INTO public.billing_contracts
      (customer_id,billing_type,description,amount_cents,periodicity,start_date,status)
      VALUES ($1,'mensalidade_plataforma','Anual',1200000,'anual',current_date-10,'ativo')`, [CUST]);
    const d = await dash();
    expect(d.mrr_cents).toBe(38000 + 100000);   // 380 + (12.000/12)
    expect(d.active_contracts).toBe(2);
  });

  it("contrato encerrado não entra no MRR", async () => {
    await db.query(`UPDATE public.billing_contracts SET status='encerrado'`);
    expect((await dash()).mrr_cents).toBe(0);
  });

  it("faturado usa COMPETÊNCIA e recebido usa DATA DE PAGAMENTO", async () => {
    const ch = await cobranca({ total: 38000 });
    await db.query(`INSERT INTO public.billing_payments (charge_id,amount_cents,paid_at,method)
                    VALUES ($1,10000,now(),'pix')`, [ch]);
    const d = await dash();
    expect(d.billed_month_cents).toBe(38000);
    expect(d.received_month_cents).toBe(10000);
    expect(d.open_cents).toBe(28000);            // saldo derivado
  });

  it("cobrança cancelada não conta como faturado nem como dívida", async () => {
    await cobranca({ status: "cancelada" });
    const d = await dash();
    expect(d.billed_month_cents).toBe(0);
    expect(d.open_cents).toBe(0);
  });

  it("vencido exige saldo > 0 — cobrança quitada some da dívida", async () => {
    const ch = await cobranca({ venc: "2020-01-10", comp: "2020-01-01" });
    let d = await dash();
    expect(d.overdue_cents).toBe(38000);
    expect(d.delinquent_customers).toBe(1);
    await db.query(`INSERT INTO public.billing_payments (charge_id,amount_cents,paid_at,method)
                    VALUES ($1,38000,now(),'pix')`, [ch]);
    d = await dash();
    expect(d.overdue_cents).toBe(0);
    expect(d.delinquent_customers).toBe(0);
  });

  it("pagamento parcial mantém o saldo remanescente como vencido", async () => {
    const ch = await cobranca({ venc: "2020-01-10", comp: "2020-01-01" });
    await db.query(`INSERT INTO public.billing_payments (charge_id,amount_cents,paid_at,method)
                    VALUES ($1,8000,now(),'pix')`, [ch]);
    expect((await dash()).overdue_cents).toBe(30000);
  });

  it("inadimplência é vencido ÷ faturado do mês", async () => {
    await cobranca({ total: 100000 });                              // faturado do mês
    await cobranca({ total: 25000, venc: "2020-01-10", comp: "2020-01-01" });  // vencido
    const d = await dash();
    expect(d.billed_month_cents).toBe(100000);
    expect(Number(d.delinquency_pct)).toBe(25);
  });

  it("receita por tipo e listas vêm preenchidas", async () => {
    await cobranca({ total: 38000 });
    const d = await dash();
    expect(d.revenue_by_type.find((t) => t.type === "taxa_acesso_online")?.billed_cents).toBe(38000);
    expect(d.recent_charges).toHaveLength(1);
  });

  it("próximos vencimentos traz só o que ainda vai vencer", async () => {
    await cobranca({ venc: "2020-01-10", comp: "2020-01-01" });                    // passado
    await cobranca({ venc: new Date(Date.now() + 6e8).toISOString().slice(0,10) }); // futuro
    expect((await dash()).upcoming_due).toHaveLength(1);
  });
});

describe("segurança", () => {
  it("anon não executa a RPC", async () => {
    let negado = false;
    try { await asUser("anon", null, `SELECT public.billing_dashboard_summary()`); }
    catch { negado = true; }
    expect(negado).toBe(true);
  });
  it("authenticated sem papel financeiro → forbidden", async () => {
    let negado = false;
    try { await dash(NINGUEM); } catch { negado = true; }
    expect(negado).toBe(true);
  });
  it("finance_viewer LÊ o dashboard", async () => {
    expect((await dash(VIEW)).active_contracts).toBe(1);
  });
});

describe("isolamento e não-persistência", () => {
  const codigo = M2.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  it("nada é persistido: sem INSERT/UPDATE/DELETE e sem materialized view", () => {
    expect(codigo).not.toMatch(/INSERT\s+INTO/i);
    expect(codigo).not.toMatch(/UPDATE\s+public\./i);
    expect(codigo).not.toMatch(/DELETE\s+FROM/i);
    expect(codigo).not.toMatch(/MATERIALIZED\s+VIEW/i);
    expect(codigo).toContain("STABLE");     // função só de leitura
  });
  it("lê apenas billing_* — nenhuma tabela operacional", () => {
    for (const p of ["public.farms", "public.equipments", "public.commands",
                     "desired_running", "automation_", "scheduled_", "device_licenses",
                     "license_key", "platform_set_farm_suspended"]) {
      expect(codigo, p).not.toContain(p);
    }
    expect(codigo).toContain("public.billing_charges");
  });
});

describe("formatação (helpers puros)", () => {
  it("centavos viram BRL", () => {
    expect(centsToBRL(280000).replace(/\u00A0/g, " ")).toBe("R$ 2.800,00");
    expect(centsToBRL(0).replace(/\u00A0/g, " ")).toBe("R$ 0,00");
    expect(centsToBRL(null).replace(/\u00A0/g, " ")).toBe("R$ 0,00");
  });
  it("compacto para eixo de gráfico", () => {
    expect(centsToCompactBRL(280000)).toMatch(/mil/);
    expect(centsToCompactBRL(500_000_00)).toMatch(/mil|mi/);
    expect(centsToCompactBRL(1000)).not.toMatch(/mil|mi/);
  });
  it("percentual e mês em pt-BR", () => {
    expect(pctBR(25)).toBe("25,0%");
    expect(monthLabel("2026-09")).toBe("set/2026");
    expect(monthLabel("")).toBe("");
  });
  it("data não desloca por fuso", () => {
    expect(dateBR("2026-09-01")).toBe("01/09/2026");       // sem virar 31/08
    expect(dateBR(null)).toBe("—");
  });
  it("rótulos dos enums cobrem os valores do banco", () => {
    for (const t of ["taxa_acesso_online","mensalidade_plataforma","manutencao","servico","personalizado"]) {
      expect(BILLING_TYPE_LABEL[t], t).toBeTruthy();
    }
    for (const s of ["prevista","aberta","enviada","paga","paga_parcial","vencida",
                     "em_negociacao","cancelada","estornada"]) {
      expect(CHARGE_STATUS_LABEL[s], s).toBeTruthy();
    }
  });
});
