// @vitest-environment node
// SPRINT 6 — SupabaseBillingGateway + RPC de resolução. Postgres 17 (pglite)
// para a RPC; cliente injetado (sem rede) para o adaptador.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
import { SupabaseBillingGateway, type RpcClient } from "@/lib/payments/SupabaseBillingGateway";

const REPO = path.resolve(__dirname, "../..");
const rd = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
const M0 = rd("20260905120000_billing_foundation.sql");
const M4 = rd("20260909140000_billing_receivables.sql");
const M6 = rd("20260909160000_billing_resolve_charge.rpc.sql");

const BOOT = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
CREATE TABLE public.farms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.is_platform_admin(_u uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT true $$;
`;

let db: PGlite; let CH = "", CH2 = "";
const resolve = async (args: Record<string, unknown>) => {
  const chaves = ["_provider","_provider_payment_id","_provider_transaction_id",
                  "_pix_end_to_end_id","_pix_txid","_provider_reference","_charge_id_hint"];
  const vals = chaves.map((k) => args[k] ?? null);
  const r = await db.query<{ r: { status: string; charge_id?: string; candidates?: number } }>(
    `SELECT public.billing_resolve_charge($1,$2,$3,$4,$5,$6,$7::uuid) AS r`, vals);
  return r.rows[0].r;
};

beforeEach(async () => {
  db = new PGlite(); await db.exec(BOOT); await db.exec(M0); await db.exec(M4); await db.exec(M6);
  await db.exec(`CREATE OR REPLACE FUNCTION public.can_read_billing(_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT true $$;`);
  const cust = (await db.query<{ id: string }>(
    `INSERT INTO billing_customers (legal_name,doc_type,doc_number) VALUES ('S','cnpj','11222333000181') RETURNING id`)).rows[0].id;
  const ct = (await db.query<{ id: string }>(
    `INSERT INTO billing_contracts (customer_id,billing_type,description,amount_cents,start_date,status)
     VALUES ($1,'taxa_acesso_online','T',100000,current_date,'ativo') RETURNING id`, [cust])).rows[0].id;
  const mkCh = async (k: string, mesesAtras: number) => (await db.query<{ id: string }>(
    `INSERT INTO billing_charges (contract_id,customer_id,competence_month,due_date,amount_cents,status,idempotency_key)
     VALUES ($1,$2,(date_trunc('month',current_date) - ($4||' months')::interval)::date,
             current_date,100000,'aberta',$3) RETURNING id`,
    [ct, cust, k, String(mesesAtras)])).rows[0].id;
  CH = await mkCh("k1", 0); CH2 = await mkCh("k2", 1);
}, 90_000);
afterEach(async () => { await db?.close(); });

const pagamento = (ch: string, campos: Record<string, string>) => {
  const cols = ["charge_id","amount_cents","paid_at","method","provider", ...Object.keys(campos)];
  const vals = [`'${ch}'`, "1000", "now()", "'pix'", "'sandbox'",
                ...Object.values(campos).map((v) => `'${v}'`)];
  return db.query(`INSERT INTO billing_payments (${cols.join(",")}) VALUES (${vals.join(",")})`);
};

describe("resolução determinística", () => {
  it("11/18. encontra por provider_payment_id", async () => {
    await pagamento(CH, { provider_payment_id: "sbx_1" });
    expect(await resolve({ _provider: "sandbox", _provider_payment_id: "sbx_1" }))
      .toMatchObject({ status: "found", charge_id: CH, matched_by: "provider_identifier" });
  });
  it("17. encontra por provider_transaction_id", async () => {
    await pagamento(CH, { provider_payment_id: "sbx_tx", provider_transaction_id: "tx_9" });
    expect(await resolve({ _provider: "sandbox", _provider_transaction_id: "tx_9" }))
      .toMatchObject({ status: "found", charge_id: CH });
  });
  it("19. encontra por pix_end_to_end_id", async () => {
    await pagamento(CH, { provider_payment_id: "sbx_e2e", pix_end_to_end_id: "E2E9" });
    expect(await resolve({ _provider: "sandbox", _pix_end_to_end_id: "E2E9" }))
      .toMatchObject({ status: "found", charge_id: CH });
  });
  it("encontra por pix_txid e por provider_reference", async () => {
    await pagamento(CH, { provider_payment_id: "sbx_tx1", pix_txid: "TX1", provider_reference: "REF1" });
    expect((await resolve({ _provider: "sandbox", _pix_txid: "TX1" })).status).toBe("found");
    expect((await resolve({ _provider: "sandbox", _provider_reference: "REF1" })).status).toBe("found");
  });
  it("12. cobrança inexistente → not_found, nunca chute", async () => {
    expect(await resolve({ _provider: "sandbox", _provider_payment_id: "nao_existe" }))
      .toMatchObject({ status: "not_found", reason: "sem_correspondencia" });
  });
  it("sem identificador nenhum → not_found", async () => {
    expect(await resolve({ _provider: "sandbox" }))
      .toMatchObject({ status: "not_found", reason: "sem_identificador" });
  });
  it("13. dois identificadores em cobranças distintas → ambiguous", async () => {
    await pagamento(CH,  { provider_payment_id: "A" });
    await pagamento(CH2, { provider_payment_id: "B0", provider_transaction_id: "B" });
    const r = await resolve({ _provider: "sandbox", _provider_payment_id: "A", _provider_transaction_id: "B" });
    expect(r.status).toBe("ambiguous");
    expect(r).not.toHaveProperty("charge_id");   // jamais escolhe uma
  });
  it("provider diferente não casa — identificador não é global", async () => {
    await pagamento(CH, { provider_payment_id: "sbx_1" });
    expect((await resolve({ _provider: "outro_psp", _provider_payment_id: "sbx_1" })).status).toBe("not_found");
  });
  it("hint do metadata só vale se a cobrança EXISTIR", async () => {
    expect(await resolve({ _provider: "sandbox", _charge_id_hint: CH }))
      .toMatchObject({ status: "found", matched_by: "metadata_hint" });
    expect((await resolve({ _provider: "sandbox",
      _charge_id_hint: "00000000-0000-0000-0000-000000000000" })).status).toBe("not_found");
  });
  it("identificador forte tem precedência sobre o hint", async () => {
    await pagamento(CH, { provider_payment_id: "sbx_1" });
    const r = await resolve({ _provider: "sandbox", _provider_payment_id: "sbx_1", _charge_id_hint: CH2 });
    expect(r.charge_id).toBe(CH);
  });
  it("nunca resolve por nome, valor ou data", () => {
    const c = M6.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const p of ["legal_name","amount_cents","due_date","ILIKE","similarity","levenshtein"]) {
      expect(c, p).not.toContain(p);
    }
  });
});

// ── Adaptador: cliente injetado, sem rede ──────────────────────────────────
class ClientSpy implements RpcClient {
  chamadas: Array<{ fn: string; args: Record<string, unknown> }> = [];
  resposta: { data: unknown; error: { message: string; code?: string } | null } = { data: null, error: null };
  atraso = 0;
  async rpc(fn: string, args: Record<string, unknown>) {
    this.chamadas.push({ fn, args });
    if (this.atraso) await new Promise((r) => setTimeout(r, this.atraso));
    return this.resposta;
  }
}

describe("SupabaseBillingGateway — adaptador sem regra de negócio", () => {
  let c: ClientSpy; let g: SupabaseBillingGateway;
  beforeEach(() => { c = new ClientSpy(); g = new SupabaseBillingGateway(c, 50); });

  it("registerPayment chama a RPC existente e devolve o saldo do banco", async () => {
    c.resposta = { data: { ok: true, payment_id: "p1", saldo_cents: 70000, charge_status: "paga_parcial" }, error: null };
    const r = await g.registerPayment({ chargeId: "ch", amountCents: 30000, method: "pix",
      paidAt: "2026-09-09T00:00:00Z", origin: "webhook", provider: "sandbox" });
    expect(r.ok).toBe(true);
    if (r.ok === true) expect(r.value.saldoCents).toBe(70000);
    expect(c.chamadas[0].fn).toBe("billing_register_manual_payment");
  });

  it("16. UNIQUE do banco vira código 'duplicado' NÃO retentável", async () => {
    c.resposta = { data: null, error: { message: 'duplicate key value violates unique constraint "x"' } };
    const r = await g.registerPayment({ chargeId: "ch", amountCents: 1, method: "pix",
      paidAt: "x", origin: "webhook", provider: "sandbox" });
    expect(r.ok).toBe(false);
    if (r.ok !== true) { expect(r.error.code).toBe("duplicado"); expect(r.error.retryable).toBe(false); }
  });

  it("14. timeout vira erro RETENTÁVEL, não exceção", async () => {
    c.atraso = 200;   // acima dos 50ms do gateway
    const r = await g.resolveCharge({ provider: "sandbox", providerPaymentId: "x" });
    expect(r.ok).toBe(false);
    if (r.ok !== true) { expect(r.error.code).toBe("timeout"); expect(r.error.retryable).toBe(true); }
  });

  it("15. banco indisponível é erro tratado", async () => {
    c.resposta = { data: null, error: { message: "connection refused", code: "08006" } };
    const r = await g.resolveCharge({ provider: "sandbox", providerPaymentId: "x" });
    expect(r.ok).toBe(false);
    if (r.ok !== true) expect(r.error.retryable).toBe(true);
  });

  it("resolução ambígua NÃO vira escolha — o adaptador recusa", async () => {
    c.resposta = { data: { status: "ambiguous", candidates: 2 }, error: null };
    const r = await g.resolveCharge({ provider: "sandbox", providerPaymentId: "x" });
    expect(r.ok).toBe(false);
    if (r.ok !== true) expect(r.error.code).toBe("ambiguous_charge");
  });

  it("not_found devolve chargeId nulo, sem erro", async () => {
    c.resposta = { data: { status: "not_found" }, error: null };
    const r = await g.resolveCharge({ provider: "sandbox", providerPaymentId: "x" });
    expect(r.ok === true && r.value.chargeId).toBeNull();
  });
});

describe("24/25. barreiras arquiteturais", () => {
  const arq = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
  const semComentario = (t: string) => t.split("\n")
    .filter((l) => { const x = l.trim();
      return !x.startsWith("//") && !x.startsWith("*") && !x.startsWith("/*"); }).join("\n");
  const GW = semComentario(arq("src/lib/payments/SupabaseBillingGateway.ts"));

  it("24. o adaptador NÃO contém regra de negócio", () => {
    // Nada de decidir saldo, status, o que é parcial, ou se estorna.
    for (const p of ["paga_parcial", "saldo >", "if (saldo", "amountCents >=",
                     "total_cents", "already_reversed", "ja_registrado"]) {
      expect(GW, p).not.toContain(p);
    }
  });

  it("o adaptador só chama RPC — nenhum SQL, nenhuma tabela", () => {
    expect(GW).not.toMatch(/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
    expect(GW).not.toMatch(/\.from\(["']billing/);
    const rpcs = [...GW.matchAll(/this\.call<[^>]*>\(\s*\n?\s*"([a-z_]+)"/g)].map((m) => m[1]);
    for (const r of rpcs) expect(r.startsWith("billing_"), r).toBe(true);
  });

  it("14. billing_events NÃO é duplicado pelo adaptador", () => {
    // As RPCs de pagamento/estorno já gravam a trilha; recordEvent existe só
    // para o que não vira operação.
    expect(GW).not.toMatch(/registerPayment[\s\S]{0,600}recordEvent/);
    expect(GW).not.toMatch(/reversePayment[\s\S]{0,600}recordEvent/);
  });

  it("25. o PaymentService continua sendo o único orquestrador", () => {
    const svc = semComentario(arq("src/lib/payments/PaymentService.ts"));
    expect(svc).toContain("billing.registerPayment");
    expect(svc).toContain("billing.reversePayment");
    // GW já vem sem comentários: o adaptador não pode IMPORTAR nem CHAMAR o
    // serviço. Citá-lo em comentário explicativo é legítimo.
    expect(GW).not.toMatch(/from\s+"\.\/PaymentService"/);
    expect(GW).not.toContain("new PaymentService");
    expect(GW).toMatch(/from\s+"\.\/ports"/);   // depende do CONTRATO
  });

  it("21. nenhum segredo e nenhum log no adaptador", () => {
    expect(GW).not.toMatch(/console\.(log|warn|error)/);
    for (const p of ["service_role","apikey","api_key","password","secret","token"]) {
      expect(GW, p).not.toMatch(new RegExp(`\\b${p}\\b`, "i"));
    }
  });

  it("BARRIER CHECK operacional", () => {
    for (const f of ["src/lib/payments/SupabaseBillingGateway.ts"]) {
      const c = semComentario(arq(f));
      for (const p of ["farms","equipments","commands","desired_running","pending_command",
                       "automation_","scheduled_","license_key","device_licenses",
                       "technical_events","agent","telemetry","PLC","pump","well"]) {
        expect(c, `${f}:${p}`).not.toMatch(new RegExp(`\\b${p}`, "i"));
      }
    }
    const m = M6.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const p of ["farms","equipments","commands","desired_running","automation_",
                     "scheduled_","license_key","device_licenses","technical_events"]) {
      expect(m, `migration:${p}`).not.toContain(p);
    }
  });
});
