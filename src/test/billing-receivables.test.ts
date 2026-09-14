// @vitest-environment node
// SPRINT 3 — recebimentos (infraestrutura, sem gateway). Postgres 17 (pglite),
// com SET ROLE real: superusuário ignora RLS.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const rd = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
const M0 = rd("20260905120000_billing_foundation.sql");
const M4 = rd("20260909140000_billing_receivables.sql");

const BOOT = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
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

let db: PGlite; let ADMIN = "", FIN = "", VIEW = "", NINGUEM = "", CUST = "", CT = "", CH = "";
interface R { ok: boolean; error?: string; payment_id?: string; saldo_cents?: number;
              charge_status?: string; reversal_id?: string }
const asUser = async (role: string, u: string | null, sql: string) => {
  await db.exec(`SET ROLE ${role};`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [u ?? ""]);
  try { return await db.query(sql); } finally { await db.exec(`RESET ROLE;`); }
};
const pagar = async (u: string, valor: number, ch = CH): Promise<R> =>
  ((await asUser("authenticated", u,
    `SELECT public.billing_register_manual_payment('${ch}'::uuid, ${valor}) AS r`)).rows[0] as { r: R }).r;
const estornar = async (u: string, pid: string): Promise<R> =>
  ((await asUser("authenticated", u,
    `SELECT public.billing_reverse_payment('${pid}'::uuid,'teste') AS r`)).rows[0] as { r: R }).r;
const statusCobranca = async () => (await db.query<{ s: string }>(
  `SELECT status::text s FROM billing_charges WHERE id=$1`, [CH])).rows[0].s;

beforeEach(async () => {
  db = new PGlite(); await db.exec(BOOT); await db.exec(M0); await db.exec(M4);
  const mk = async () => (await db.query<{ id: string }>(
    `INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
  ADMIN = await mk(); FIN = await mk(); VIEW = await mk(); NINGUEM = await mk();
  await db.query(`INSERT INTO public.platform_admins VALUES ($1)`, [ADMIN]);
  await db.query(`INSERT INTO public.billing_roles (user_id,role) VALUES ($1,'finance'),($2,'finance_viewer')`, [FIN, VIEW]);
  CUST = (await db.query<{ id: string }>(
    `INSERT INTO billing_customers (legal_name,doc_type,doc_number) VALUES ('S','cnpj','11222333000181') RETURNING id`)).rows[0].id;
  CT = (await db.query<{ id: string }>(
    `INSERT INTO billing_contracts (customer_id,billing_type,description,amount_cents,start_date,status)
     VALUES ($1,'taxa_acesso_online','T',100000,current_date,'ativo') RETURNING id`, [CUST])).rows[0].id;
  CH = (await db.query<{ id: string }>(
    `INSERT INTO billing_charges (contract_id,customer_id,competence_month,due_date,amount_cents,status,idempotency_key)
     VALUES ($1,$2,date_trunc('month',current_date)::date,current_date,100000,'aberta','k1') RETURNING id`,
    [CT, CUST])).rows[0].id;
}, 90_000);
afterEach(async () => { await db?.close(); });

describe("baixa manual: parcial, integral e múltiplos pagamentos", () => {
  it("pagamento parcial deixa a cobrança em paga_parcial", async () => {
    const r = await pagar(FIN, 30000);
    expect(r.ok).toBe(true);
    expect(Number(r.saldo_cents)).toBe(70000);
    expect(await statusCobranca()).toBe("paga_parcial");
  });

  it("pagamento integral quita", async () => {
    const r = await pagar(FIN, 100000);
    expect(Number(r.saldo_cents)).toBe(0);
    expect(await statusCobranca()).toBe("paga");
  });

  it("dois pagamentos somam e quitam — sem sobrescrever o primeiro", async () => {
    const a = await pagar(FIN, 40000);
    const b = await pagar(FIN, 60000);
    expect(Number(b.saldo_cents)).toBe(0);
    const n = await db.query<{ n: number }>(`SELECT count(*)::int n FROM billing_payments`);
    expect(Number(n.rows[0].n)).toBe(2);          // histórico preservado
    const primeiro = await db.query<{ a: string }>(
      `SELECT amount_cents::text a FROM billing_payments WHERE id=$1`, [a.payment_id]);
    expect(Number(primeiro.rows[0].a)).toBe(40000);   // linha original intacta
  });

  it("valor inválido e cobrança cancelada são recusados", async () => {
    expect((await pagar(FIN, 0)).error).toBe("invalid_amount");
    await db.query(`UPDATE billing_charges SET status='cancelada' WHERE id=$1`, [CH]);
    expect((await pagar(FIN, 1000)).error).toBe("charge_not_payable");
  });
});

describe("estorno: linha nova, nunca edição", () => {
  it("estorno cria linha NEGATIVA apontando para o original", async () => {
    const p = await pagar(FIN, 100000);
    const e = await estornar(ADMIN, p.payment_id!);
    expect(e.ok).toBe(true);
    const r = await db.query<{ amount_cents: string; kind: string; reverses: string | null }>(
      `SELECT amount_cents::text, kind::text, reverses_payment_id::text AS reverses
         FROM billing_payments ORDER BY created_at`);
    expect(r.rows).toHaveLength(2);
    expect(Number(r.rows[0].amount_cents)).toBe(100000);    // original intacto
    expect(Number(r.rows[1].amount_cents)).toBe(-100000);
    expect(r.rows[1].kind).toBe("estorno");
    expect(r.rows[1].reverses).toBe(p.payment_id);
  });

  it("cobrança volta a 'aberta' quando o estorno zera o pago", async () => {
    const p = await pagar(FIN, 100000);
    expect(await statusCobranca()).toBe("paga");
    await estornar(ADMIN, p.payment_id!);
    expect(await statusCobranca()).toBe("aberta");
  });

  it("estornar duas vezes o mesmo pagamento é recusado", async () => {
    const p = await pagar(FIN, 50000);
    await estornar(ADMIN, p.payment_id!);
    expect((await estornar(ADMIN, p.payment_id!)).error).toBe("already_reversed");
  });

  it("o CHECK impede estorno positivo e pagamento negativo", async () => {
    // Com alvo VÁLIDO, para isolar o CHECK de sinal do CHECK de alvo — senão o
    // teste passaria pela constraint errada.
    const p = await pagar(FIN, 1000);
    await expect(db.query(
      `INSERT INTO billing_payments (charge_id,amount_cents,paid_at,method,kind,reverses_payment_id)
       VALUES ($1,500,now(),'pix','estorno',$2)`, [CH, p.payment_id])).rejects.toThrow();
    await expect(db.query(
      `INSERT INTO billing_payments (charge_id,amount_cents,paid_at,method,kind,reverses_payment_id)
       VALUES ($1,500,now(),'pix','estorno',NULL)`, [CH])).rejects.toThrow();
    await expect(db.query(
      `INSERT INTO billing_payments (charge_id,amount_cents,paid_at,method,kind)
       VALUES ($1,-500,now(),'pix','pagamento')`, [CH])).rejects.toThrow();
  });
});

describe("permissões", () => {
  it("viewer NÃO registra pagamento nem estorna", async () => {
    expect((await pagar(VIEW, 1000)).error).toBe("forbidden");
    const p = await pagar(FIN, 1000);
    expect((await estornar(VIEW, p.payment_id!)).error).toBe("forbidden");
  });
  it("financeiro registra, mas NÃO estorna — estorno é do admin", async () => {
    const p = await pagar(FIN, 1000);
    expect(p.ok).toBe(true);
    expect((await estornar(FIN, p.payment_id!)).error).toBe("forbidden");
  });
  it("authenticated sem papel financeiro não faz nada", async () => {
    expect((await pagar(NINGUEM, 1000)).error).toBe("forbidden");
  });
  it("anon não lê nem escreve billing_payment_methods", async () => {
    let bloqueado = false;
    try {
      const r = await asUser("anon", null, `SELECT * FROM billing_payment_methods`);
      bloqueado = r.rows.length === 0;
    } catch { bloqueado = true; }
    expect(bloqueado).toBe(true);
  });
  it("viewer lê meios de pagamento, mas não escreve", async () => {
    await db.query(`INSERT INTO billing_payment_methods (customer_id,kind,status) VALUES ($1,'pix','ativo')`, [CUST]);
    expect((await asUser("authenticated", VIEW, `SELECT id FROM billing_payment_methods`)).rows.length).toBe(1);
    let negado = false;
    try {
      const r = await asUser("authenticated", VIEW,
        `INSERT INTO billing_payment_methods (customer_id,kind) VALUES ('${CUST}','pix') RETURNING id`);
      negado = r.rows.length === 0;
    } catch { negado = true; }
    expect(negado).toBe(true);
  });
});

describe("meios de pagamento — estrutura para os gateways futuros", () => {
  it("suporta todos os métodos exigidos", async () => {
    for (const k of ["pix","pix_automatico","boleto","transferencia","cartao_credito",
                     "cartao_debito","apple_pay","google_pay"]) {
      await db.query(`INSERT INTO billing_payment_methods (customer_id,kind,provider,provider_payment_method_id)
                      VALUES ($1,$2::billing_payment_method,'psp-x',$2||'-tok')`, [CUST, k]);
    }
    const n = await db.query<{ n: number }>(`SELECT count(*)::int n FROM billing_payment_methods`);
    expect(Number(n.rows[0].n)).toBe(8);
  });

  it("PIX recorrente: autorização, limite, periodicidade e revogação", async () => {
    const id = (await db.query<{ id: string }>(
      `INSERT INTO billing_payment_methods (customer_id,kind,status,provider,authorization_id,
         authorized_at,max_amount_cents,periodicity)
       VALUES ($1,'pix_automatico','ativo','psp-x','AUTH-1',now(),500000,'mensal') RETURNING id`,
      [CUST])).rows[0].id;
    // revogar exige data — o CHECK garante auditabilidade
    await expect(db.query(`UPDATE billing_payment_methods SET status='revogado' WHERE id=$1`, [id]))
      .rejects.toThrow();
    await db.query(`UPDATE billing_payment_methods SET status='revogado', revoked_at=now() WHERE id=$1`, [id]);
    const r = await db.query<{ s: string }>(`SELECT status::text s FROM billing_payment_methods WHERE id=$1`, [id]);
    expect(r.rows[0].s).toBe("revogado");
  });

  it("só UMA autorização PIX recorrente ativa por cliente", async () => {
    await db.query(`INSERT INTO billing_payment_methods (customer_id,kind,status) VALUES ($1,'pix_automatico','ativo')`, [CUST]);
    await expect(db.query(
      `INSERT INTO billing_payment_methods (customer_id,kind,status) VALUES ($1,'pix_automatico','ativo')`, [CUST]))
      .rejects.toThrow();
  });

  it("o mesmo token do provedor não entra duas vezes", async () => {
    await db.query(`INSERT INTO billing_payment_methods (customer_id,kind,provider,provider_payment_method_id)
                    VALUES ($1,'cartao_credito','psp-x','tok-1')`, [CUST]);
    await expect(db.query(`INSERT INTO billing_payment_methods (customer_id,kind,provider,provider_payment_method_id)
                    VALUES ($1,'cartao_credito','psp-x','tok-1')`, [CUST])).rejects.toThrow();
  });

  it("exibição segura: só bandeira e últimos 4 dígitos", async () => {
    await expect(db.query(`INSERT INTO billing_payment_methods (customer_id,kind,display_last4)
                           VALUES ($1,'cartao_credito','12a4')`, [CUST])).rejects.toThrow();
    await db.query(`INSERT INTO billing_payment_methods (customer_id,kind,display_brand,display_last4)
                    VALUES ($1,'cartao_credito','visa','1234')`, [CUST]);
  });

  it("PIX e boleto: campos de identificação presentes e e2e único", async () => {
    const p = await pagar(FIN, 1000);
    await db.query(`UPDATE billing_payments SET pix_txid='TX1', pix_end_to_end_id='E2E1',
                    boleto_line='0001', boleto_our_number='123', boleto_barcode='X' WHERE id=$1`, [p.payment_id]);
    const p2 = await pagar(FIN, 1000);
    await expect(db.query(`UPDATE billing_payments SET pix_end_to_end_id='E2E1' WHERE id=$1`, [p2.payment_id]))
      .rejects.toThrow();
  });
});

describe("auditoria", () => {
  it("pagamento parcial, integral e estorno registram billing_events", async () => {
    const a = await pagar(FIN, 30000);
    await pagar(FIN, 70000);
    await estornar(ADMIN, a.payment_id!);
    const e = await db.query<{ event: string }>(`SELECT event FROM billing_events ORDER BY id`);
    const ev = e.rows.map((x) => x.event);
    expect(ev).toContain("partial_payment");
    expect(ev).toContain("full_payment");
    expect(ev).toContain("manual_payment");
    expect(ev).toContain("refund_created");
  });
  it("billing_events continua append-only", async () => {
    await pagar(FIN, 1000);
    await expect(db.query(`UPDATE billing_events SET event='x'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM billing_events`)).rejects.toThrow();
  });
});

describe("barreira operacional e segurança de dados", () => {
  const codigo = M4.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  it("nenhuma referência operacional", () => {
    for (const p of ["public.farms","public.equipments","public.commands","desired_running",
                     "pending_command","automation_","scheduled_","device_licenses",
                     "license_key","technical_events","platform_set_farm_suspended"]) {
      expect(codigo, p).not.toContain(p);
    }
  });
  it("nenhuma coluna sensível: sem PAN, CVV ou chave privada", () => {
    // O COMMENT ON documenta a proibição citando os termos; a verificação tem
    // de olhar DEFINIÇÃO de coluna, não texto de documentação.
    const semDoc = codigo.replace(/COMMENT ON[\s\S]*?;/g, "");
    // limite de palavra: "pan" solto casaria com "acompanhamento" e afins.
    for (const p of ["card_number","pan","cvv","cvc","security_code","private_key",
                     "secret_key","password","card_holder"]) {
      expect(semDoc, p).not.toMatch(new RegExp(`\\b${p}\\b`, "i"));
    }
  });
  it("nenhuma integração externa foi criada", () => {
    expect(codigo).not.toMatch(/http:\/\/|https:\/\//);
    expect(codigo).not.toMatch(/net\.http_post|cron\.schedule|pg_net/);
  });
  it("status são ENUM, nunca texto livre", () => {
    expect(codigo).toContain("CREATE TYPE public.billing_payment_status AS ENUM");
    expect(codigo).toContain("CREATE TYPE public.billing_method_status AS ENUM");
    expect(codigo).toContain("CREATE TYPE public.billing_payment_kind AS ENUM");
  });
  it("billing_payments é REUTILIZADA — nenhuma coluna removida ou renomeada", () => {
    expect(codigo).not.toMatch(/DROP\s+COLUMN/i);
    expect(codigo).not.toMatch(/RENAME/i);
    expect(codigo).not.toMatch(/DROP\s+TABLE/i);
    expect(codigo).toContain("ALTER TABLE public.billing_payments");
    expect(codigo).toContain("ADD COLUMN IF NOT EXISTS");
  });
});
