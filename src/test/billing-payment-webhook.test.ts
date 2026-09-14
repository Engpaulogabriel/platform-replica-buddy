// @vitest-environment node
// SPRINT 6 (final) — Edge Function + RPC de autorização.
// A Edge Function é validada por CONTRATO (análise estática) e por simulação do
// seu fluxo com as peças reais: Deno.serve não roda no vitest, mas router,
// PaymentService e gateway rodam — e é onde mora toda a regra.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
import { SandboxProvider } from "@/lib/payments/SandboxProvider";
import { WebhookDedupe, routeWebhook, identificarProvider } from "@/lib/payments/webhookRouter";
import { PaymentService } from "@/lib/payments/PaymentService";
import { SupabaseBillingGateway, type RpcClient } from "@/lib/payments/SupabaseBillingGateway";

const REPO = path.resolve(__dirname, "../..");
const EDGE = fs.readFileSync(path.join(REPO, "supabase/functions/billing-payment-webhook/index.ts"), "utf8");
const RPC  = fs.readFileSync(path.join(REPO, "supabase/migrations/20260909180000_billing_update_payment_authorization.sql"), "utf8");
const semTs = (t: string) => t.split("\n").filter((l) => { const x = l.trim();
  return !x.startsWith("//") && !x.startsWith("*") && !x.startsWith("/*"); }).join("\n");
const semSql = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const EDGE_C = semTs(EDGE), RPC_C = semSql(RPC);

const SEGREDO = "seg-edge";
const hmac = async (corpo: string) => {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(SEGREDO),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(corpo)));
  return Array.from(s, (b) => b.toString(16).padStart(2, "0")).join("");
};
const prov = () => new SandboxProvider({ provider: "sandbox", environment: "development",
  credentials: { webhookSecret: SEGREDO }, timeoutMs: 5000 });

/** Réplica do fluxo da Edge Function, com as MESMAS peças. Devolve o status
 *  HTTP que ela devolveria — é assim que o contrato de erro fica testável. */
async function fluxo(rawBody: string, headers: Record<string, string>,
                     rpcClient: RpcClient, d: WebhookDedupe): Promise<number> {
  if (!rawBody) return 400;
  const pid = identificarProvider(headers);
  if (!pid || pid !== "sandbox") return 404;
  const rota = await routeWebhook(prov(), d, { rawBody, headers });
  if (rota.ok !== true) {
    const c = rota.error.code;
    if (c === "assinatura_ausente" || c === "assinatura_invalida") return 401;
    return 400;
  }
  const r = await new PaymentService(new SupabaseBillingGateway(rpcClient, 50)).process(rota.value);
  if (r.ok !== true) {
    return /timeout|network|unavailable|08006/i.test(r.error.message) ? 503 : 500;
  }
  return r.value.applied ? 200 : 204;
}

class Rpc implements RpcClient {
  chamadas: string[] = []; atraso = 0;
  respostas: Record<string, { data: unknown; error: { message: string; code?: string } | null }> = {
    billing_resolve_charge: { data: { status: "found", charge_id: "ch-1" }, error: null },
    billing_register_manual_payment: { data: { ok: true, payment_id: "p1", saldo_cents: 0, charge_status: "paga" }, error: null },
    billing_reverse_payment: { data: { ok: true, reversal_id: "r1" }, error: null },
    billing_update_payment_authorization: { data: { ok: true, method_id: "pm1" }, error: null },
    billing_record_event: { data: { event_id: "e1" }, error: null },
  };
  async rpc(fn: string) {
    this.chamadas.push(fn);
    if (this.atraso) await new Promise((r) => setTimeout(r, this.atraso));
    return this.respostas[fn] ?? { data: null, error: null };
  }
}

const wh = async (body: Record<string, unknown>, sig?: string) => {
  const rawBody = JSON.stringify(body);
  return { rawBody, headers: { "x-signature": sig ?? await hmac(rawBody), "x-provider": "sandbox" } };
};

let c: Rpc; let d: WebhookDedupe;
beforeEach(() => { c = new Rpc(); d = new WebhookDedupe(); });

describe("contrato HTTP", () => {
  it("webhook aprovado → 200 e pagamento registrado", async () => {
    const w = await wh({ event_id: "e1", status: "PAID", payment_id: "sbx_1", amount_cents: 100000, method: "pix" });
    expect(await fluxo(w.rawBody, w.headers, c, d)).toBe(200);
    expect(c.chamadas).toContain("billing_register_manual_payment");
  });

  it("pagamento parcial e total percorrem o mesmo caminho", async () => {
    c.respostas.billing_register_manual_payment = { data: { ok: true, payment_id: "p", saldo_cents: 70000, charge_status: "paga_parcial" }, error: null };
    const a = await wh({ event_id: "p1", status: "PARTIAL", payment_id: "sbx_1", amount_cents: 30000, method: "pix" });
    expect(await fluxo(a.rawBody, a.headers, c, d)).toBe(200);
    c.respostas.billing_register_manual_payment = { data: { ok: true, payment_id: "p2", saldo_cents: 0, charge_status: "paga" }, error: null };
    const b = await wh({ event_id: "p2", status: "PAID", payment_id: "sbx_1", amount_cents: 70000, method: "pix" });
    expect(await fluxo(b.rawBody, b.headers, c, d)).toBe(200);
  });

  it("estorno/refund → 200 e reverse chamado", async () => {
    const w = await wh({ event_id: "r1", status: "REFUNDED", payment_id: "sbx_1" });
    expect(await fluxo(w.rawBody, w.headers, c, d)).toBe(200);
    expect(c.chamadas).toContain("billing_reverse_payment");
  });

  it("webhook DUPLICADO → 204, sem novo pagamento", async () => {
    const w = await wh({ event_id: "e1", status: "PAID", payment_id: "sbx_1", amount_cents: 100000, method: "pix" });
    expect(await fluxo(w.rawBody, w.headers, c, d)).toBe(200);
    expect(await fluxo(w.rawBody, w.headers, c, d)).toBe(204);
    expect(c.chamadas.filter((x) => x === "billing_register_manual_payment")).toHaveLength(1);
  });

  it("replay attack: mesmo corpo e assinatura, nada aplicado de novo", async () => {
    const w = await wh({ event_id: "e1", status: "PAID", payment_id: "sbx_1", amount_cents: 100000, method: "pix" });
    await fluxo(w.rawBody, w.headers, c, d);
    for (let i = 0; i < 5; i++) expect(await fluxo(w.rawBody, w.headers, c, d)).toBe(204);
    expect(c.chamadas.filter((x) => x === "billing_register_manual_payment")).toHaveLength(1);
  });

  it("UNIQUE do banco → 204, NUNCA 500", async () => {
    c.respostas.billing_register_manual_payment = { data: null,
      error: { message: 'duplicate key value violates unique constraint "billing_payments_provider_uniq"' } };
    const w = await wh({ event_id: "u1", status: "PAID", payment_id: "sbx_1", amount_cents: 100, method: "pix" });
    expect(await fluxo(w.rawBody, w.headers, c, d)).toBe(204);
  });

  it("assinatura inválida → 401", async () => {
    const w = await wh({ event_id: "e1", status: "PAID", payment_id: "x" }, "deadbeef");
    expect(await fluxo(w.rawBody, w.headers, c, d)).toBe(401);
    expect(c.chamadas).toHaveLength(0);
  });

  it("sem assinatura → 401", async () => {
    const w = await wh({ event_id: "e1", status: "PAID", payment_id: "x" });
    expect(await fluxo(w.rawBody, { "x-provider": "sandbox" }, c, d)).toBe(401);
  });

  it("provider inexistente → 404, antes de qualquer processamento", async () => {
    const w = await wh({ event_id: "e1", status: "PAID", payment_id: "x" });
    expect(await fluxo(w.rawBody, { ...w.headers, "x-provider": "psp_fantasma" }, c, d)).toBe(404);
    expect(c.chamadas).toHaveLength(0);
  });

  it("payload inválido → 400", async () => {
    const raw = "{quebrado";
    expect(await fluxo(raw, { "x-signature": await hmac(raw), "x-provider": "sandbox" }, c, d)).toBe(400);
    expect(await fluxo("", { "x-provider": "sandbox" }, c, d)).toBe(400);
  });

  it("timeout → 503 retentável, sem exceção", async () => {
    c.atraso = 200;
    const w = await wh({ event_id: "t1", status: "PAID", payment_id: "sbx_1", amount_cents: 100, method: "pix" });
    await expect(fluxo(w.rawBody, w.headers, c, d)).resolves.toBe(503);
  });

  it("banco indisponível → 503", async () => {
    c.respostas.billing_resolve_charge = { data: null, error: { message: "connection refused", code: "08006" } };
    const w = await wh({ event_id: "b1", status: "PAID", payment_id: "sbx_1", amount_cents: 100, method: "pix" });
    expect(await fluxo(w.rawBody, w.headers, c, d)).toBe(503);
  });

  it("cobrança inexistente → 500 (erro de processamento), não pagamento órfão", async () => {
    c.respostas.billing_resolve_charge = { data: { status: "not_found" }, error: null };
    const w = await wh({ event_id: "n1", status: "PAID", payment_id: "sbx_1", amount_cents: 100, method: "pix" });
    expect(await fluxo(w.rawBody, w.headers, c, d)).toBe(500);
    expect(c.chamadas).not.toContain("billing_register_manual_payment");
  });

  it("cobrança ambígua não escolhe: nada é registrado", async () => {
    c.respostas.billing_resolve_charge = { data: { status: "ambiguous", candidates: 2 }, error: null };
    const w = await wh({ event_id: "a1", status: "PAID", payment_id: "sbx_1", amount_cents: 100, method: "pix" });
    expect(await fluxo(w.rawBody, w.headers, c, d)).toBe(500);
    expect(c.chamadas).not.toContain("billing_register_manual_payment");
  });
});

describe("RAW BODY preservado", () => {
  it("assinatura é conferida sobre os BYTES recebidos, não sobre JSON reserializado", async () => {
    // Corpo com espaçamento e ordem que JSON.stringify NÃO reproduziria.
    const raw = '{ "status":"PAID",  "event_id":"e1", "payment_id":"sbx_1", "amount_cents":100, "method":"pix" }';
    expect(JSON.stringify(JSON.parse(raw))).not.toBe(raw);   // prova que difere
    const headers = { "x-signature": await hmac(raw), "x-provider": "sandbox" };
    expect(await fluxo(raw, headers, c, d)).toBe(200);
  });

  it("a Edge Function lê o corpo UMA vez e não reserializa antes da assinatura", () => {
    expect(EDGE_C).toContain("await req.text()");
    expect(EDGE_C).not.toContain("await req.json()");
    // `indexOf("routeWebhook")` casava com o IMPORT, no topo do arquivo — o
    // trecho analisado era só a lista de imports, e nenhuma sabotagem no corpo
    // seria detectada. Ancorar na CHAMADA é o que torna a verificação real.
    // Recorte EXATO: da leitura do corpo até a chamada do router. Antes disso
    // há o helper `resp()`, que usa JSON.stringify legitimamente para o CORPO
    // DA RESPOSTA — nada a ver com o raw body recebido.
    const ini = EDGE_C.indexOf("req.text()");
    const fim = EDGE_C.indexOf("await routeWebhook(");
    expect(ini).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(ini);
    const entre = EDGE_C.slice(ini, fim);
    expect(entre).not.toMatch(/JSON\.parse|JSON\.stringify/);
    // e a própria leitura não pode estar embrulhada em parse/stringify
    const linhaCorpo = EDGE_C.split("\n").find((l) => l.includes("req.text()")) ?? "";
    expect(linhaCorpo).not.toMatch(/JSON\.parse|JSON\.stringify/);
  });
});

describe("Edge Function: fina, sem SQL, sem regra financeira", () => {
  it("nenhum SQL e nenhuma tabela financeira", () => {
    expect(EDGE_C).not.toMatch(/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
    for (const p of ["billing_payments", "billing_charges", "billing_events",
                     "billing_payment_methods", ".from("]) {
      expect(EDGE_C, p).not.toContain(p);
    }
  });

  it("não chama RPC diretamente — o PaymentService é o único caminho", () => {
    expect(EDGE_C).not.toMatch(/\.rpc\(/);
    expect(EDGE_C).toContain("new PaymentService(");
    expect(EDGE_C).toContain("servico.process(");
  });

  it("nenhuma regra financeira", () => {
    for (const p of ["saldo", "amount_cents >", "paga_parcial", "total_cents",
                     "estorno", "refund(", "if (valor"]) {
      expect(EDGE_C, p).not.toContain(p);
    }
  });

  it("segredo: só do ambiente, nunca hardcoded nem em log/resposta", () => {
    expect(EDGE_C).toContain("Deno.env.get(`BILLING_WEBHOOK_SECRET_");
    expect(EDGE_C).not.toMatch(/console\.(log|warn|error)/);
    expect(EDGE_C).not.toMatch(/webhookSecret\s*:\s*["'][^"']{8,}/);   // sem literal
    // nenhuma resposta devolve corpo com segredo/detalhe interno
    expect(EDGE_C).not.toMatch(/JSON\.stringify\(\{[^}]*(secret|error\.message|stack)/);
  });

  it("provider desconhecido é recusado por lista branca", () => {
    expect(EDGE_C).toContain("HABILITADOS");
    expect(EDGE_C).toMatch(/HABILITADOS\.includes\(providerId\)/);
  });

  it("nunca propaga exceção", () => {
    expect(EDGE_C).toMatch(/catch\s*\{[\s\S]*?resp\(500/);
  });
});

describe("RPC de autorização", () => {
  let db: PGlite; let PM = "";
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE TABLE public.farms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
      CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
      CREATE OR REPLACE FUNCTION public.is_platform_admin(_u uuid) RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT true $$;`);
    const rd = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
    await db.exec(rd("20260905120000_billing_foundation.sql"));
    await db.exec(rd("20260909140000_billing_receivables.sql"));
    await db.exec(RPC);
    await db.exec(`CREATE OR REPLACE FUNCTION public.can_write_billing(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT true $$;`);
    const cust = (await db.query<{ id: string }>(
      `INSERT INTO billing_customers (legal_name,doc_type,doc_number) VALUES ('S','cnpj','11222333000181') RETURNING id`)).rows[0].id;
    PM = (await db.query<{ id: string }>(
      `INSERT INTO billing_payment_methods (customer_id,kind,status,authorization_id,provider)
       VALUES ($1,'pix_automatico','pendente','AUTH-1','sandbox') RETURNING id`, [cust])).rows[0].id;
  }, 90_000);
  afterEach(async () => { await db?.close(); });

  const up = async (status: string, extra = "NULL,NULL,NULL") => (await db.query<{ r: { ok: boolean; error?: string; method_id?: string } }>(
    `SELECT public.billing_update_payment_authorization('AUTH-1',$1::billing_method_status,'sandbox','OK',${extra},'{}'::jsonb) AS r`,
    [status])).rows[0].r;

  it("ativa a autorização", async () => {
    const r = await up("ativo", "now(),NULL,NULL");
    expect(r.ok).toBe(true); expect(r.method_id).toBe(PM);
    const s = await db.query<{ s: string }>(`SELECT status::text s FROM billing_payment_methods WHERE id=$1`, [PM]);
    expect(s.rows[0].s).toBe("ativo");
  });

  it("revoga preenchendo revoked_at automaticamente (CHECK da Sprint 3)", async () => {
    const r = await up("revogado");
    expect(r.ok).toBe(true);
    const s = await db.query<{ s: string; rv: string | null }>(
      `SELECT status::text s, revoked_at::text rv FROM billing_payment_methods WHERE id=$1`, [PM]);
    expect(s.rows[0].s).toBe("revogado");
    expect(s.rows[0].rv).toBeTruthy();
  });

  it("expira", async () => {
    expect((await up("expirado")).ok).toBe(true);
  });

  it("autorização inexistente → erro claro, sem criar nada", async () => {
    const r = (await db.query<{ r: { ok: boolean; error: string } }>(
      `SELECT public.billing_update_payment_authorization('NAO-EXISTE','ativo','sandbox') AS r`)).rows[0].r;
    expect(r).toMatchObject({ ok: false, error: "authorization_not_found" });
  });

  it("não grava billing_events — trilha continua exclusiva das RPCs existentes", async () => {
    await up("ativo", "now(),NULL,NULL");
    const n = await db.query<{ n: number }>(`SELECT count(*)::int n FROM billing_events`);
    expect(Number(n.rows[0].n)).toBe(0);
    // O COMMENT ON documenta a proibição citando o termo; a verificação tem de
    // olhar o SQL executável, não a documentação.
    expect(RPC_C.replace(/COMMENT ON[\s\S]*?;/g, "")).not.toContain("billing_events");
  });

  it("nenhuma regra financeira na RPC", () => {
    for (const p of ["billing_payments", "billing_charges", "total_cents",
                     "amount_cents", "saldo"]) {
      expect(RPC_C, p).not.toContain(p);
    }
  });
});

describe("BARRIER CHECK", () => {
  it("zero referência operacional na Edge Function e na RPC", () => {
    for (const [nome, c2] of [["edge", EDGE_C], ["rpc", RPC_C]] as const) {
      for (const p of ["farms","equipments","commands","desired_running","automation_",
                       "scheduled_","license_key","device_licenses","technical_events",
                       "agent","telemetry","PLC","pump","well"]) {
        expect(c2, `${nome}:${p}`).not.toMatch(new RegExp(`\\b${p}`, "i"));
      }
    }
  });
});
