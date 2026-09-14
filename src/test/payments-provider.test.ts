// @vitest-environment node
// SPRINT 4 — camada PaymentProvider. Contrato puro + adaptador sandbox.
// NENHUM gateway real é integrado; nenhuma chamada de rede acontece.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { SandboxProvider, sandboxFactory } from "@/lib/payments/SandboxProvider";
import { getProvider, registerProvider, listRegisteredProviders, __resetRegistry,
         type ProviderConfig } from "@/lib/payments/PaymentProvider";
import { WebhookDedupe, routeWebhook, acaoPara, identificarProvider } from "@/lib/payments/webhookRouter";

const REPO = path.resolve(__dirname, "../..");
const SEGREDO = "seg-de-teste";
const CFG: ProviderConfig = { provider: "sandbox", environment: "development",
  credentials: { webhookSecret: SEGREDO }, timeoutMs: 5000 };

const hmac = async (corpo: string) => {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(SEGREDO),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(corpo)));
  return Array.from(s, (b) => b.toString(16).padStart(2, "0")).join("");
};
const webhook = async (body: Record<string, unknown>) => {
  const rawBody = JSON.stringify(body);
  return { rawBody, headers: { "x-signature": await hmac(rawBody), "x-provider": "sandbox" } };
};

let p: SandboxProvider;
beforeEach(() => { p = new SandboxProvider(CFG); });

describe("registro e troca de gateway", () => {
  it("a plataforma resolve o provedor por id — nenhum import concreto", () => {
    __resetRegistry();
    expect(getProvider(CFG).ok).toBe(false);          // não registrado ainda
    registerProvider("sandbox", sandboxFactory);
    const r = getProvider(CFG);
    expect(r.ok).toBe(true);
    expect(listRegisteredProviders()).toEqual(["sandbox"]);
  });
  it("credencial ausente falha na criação, não em runtime", () => {
    const r = getProvider({ ...CFG, credentials: {} });
    expect(r.ok).toBe(false);
    if (r.ok !== true) expect(r.error.code).toBe("provider_init_failed");
  });
});

describe("PIX", () => {
  it("cria com QR, copia-e-cola, txid e expiração", async () => {
    const r = await p.createPix({ chargeId: "ch1", amountCents: 38000, idempotencyKey: "k1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.pix?.txid).toBe("txid_k1");
    expect(r.value.pix?.qrCode).toBeTruthy();
    expect(r.value.pix?.copyPaste).toBeTruthy();
    expect(r.value.expiresAt).toBeTruthy();
  });
  it("mesma idempotencyKey devolve a MESMA cobrança — TXID nunca duplica", async () => {
    const a = await p.createPix({ chargeId: "ch1", amountCents: 38000, idempotencyKey: "k1" });
    const b = await p.createPix({ chargeId: "ch1", amountCents: 38000, idempotencyKey: "k1" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.value.providerPaymentId).toBe(a.value.providerPaymentId);
      expect(b.value.pix?.txid).toBe(a.value.pix?.txid);
    }
  });
  it("chaves distintas geram TXIDs distintos", async () => {
    const a = await p.createPix({ chargeId: "c", amountCents: 1, idempotencyKey: "k1" });
    const b = await p.createPix({ chargeId: "c", amountCents: 1, idempotencyKey: "k2" });
    if (a.ok && b.ok) expect(a.value.pix?.txid).not.toBe(b.value.pix?.txid);
  });
  it("consulta e cancelamento", async () => {
    const c = await p.createPix({ chargeId: "ch1", amountCents: 100, idempotencyKey: "k1" });
    if (!c.ok) return;
    expect((await p.getPayment(c.value.providerPaymentId)).ok).toBe(true);
    const x = await p.cancelPix(c.value.providerPaymentId);
    expect(x.ok && x.value.status).toBe("cancelado");
  });
});

describe("PIX Recorrente", () => {
  it("autorização com limite, periodicidade e status", async () => {
    const r = await p.createRecurringPix({ providerCustomerId: "cus_1", maxAmountCents: 500000,
      periodicity: "mensal", idempotencyKey: "a1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.authorizationId).toBe("auth_a1");
      expect(r.value.maxAmountCents).toBe(500000);
      expect(r.value.status).toBe("pendente");
    }
  });
  it("revogação muda o status", async () => {
    const r = await p.cancelRecurringPix("auth_a1");
    expect(r.ok && r.value.status).toBe("revogado");
  });
});

describe("cartão, Apple Pay e Google Pay — só tokens", () => {
  const tok = { token: "tok_abc", brand: "visa", last4: "1234" };
  for (const [nome, fn] of [["cartão", "createCardPayment"], ["Apple Pay", "createApplePay"],
                            ["Google Pay", "createGooglePay"]] as const) {
    it(`${nome} autoriza com token`, async () => {
      const metodos = p as unknown as Record<string,
        (i: unknown) => Promise<{ ok: boolean; value?: { status: string } }>>;
      const r = await metodos[fn]({ chargeId: "ch1", amountCents: 1000, token: tok,
        idempotencyKey: `k-${fn}` });
      expect(r.ok).toBe(true);
      expect(r.value?.status).toBe("autorizado");
    });
  }
  it("sem token, recusa", async () => {
    const r = await p.createCardPayment({ chargeId: "c", amountCents: 1,
      token: { token: "" }, idempotencyKey: "kx" });
    expect(r.ok).toBe(false);
  });
});

describe("boleto", () => {
  it("linha digitável, nosso número, barcode, pdf e vencimento", async () => {
    const r = await p.createBoleto({ chargeId: "ch1", amountCents: 38000,
      dueDate: "2026-10-10", idempotencyKey: "b1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.boleto?.line).toBeTruthy();
      expect(r.value.boleto?.ourNumber).toBe("NNb1");
      expect(r.value.boleto?.barcode).toBe("BCb1");
      expect(r.value.boleto?.pdfUrl).toBeTruthy();
      expect(r.value.boleto?.dueDate).toBe("2026-10-10");
    }
  });
  it("cancelamento", async () => {
    const c = await p.createBoleto({ chargeId: "c", amountCents: 1, dueDate: "2026-10-10", idempotencyKey: "b2" });
    if (!c.ok) return;
    const x = await p.cancelBoleto(c.value.providerPaymentId);
    expect(x.ok && x.value.status).toBe("cancelado");
  });
});

describe("webhook — assinatura, normalização e dedupe", () => {
  let d: WebhookDedupe;
  beforeEach(() => { d = new WebhookDedupe(); });

  it("assinatura válida é aceita e normalizada", async () => {
    const w = await webhook({ event_id: "e1", type: "payment.paid", status: "PAID",
      payment_id: "sbx_k1", amount_cents: 38000, end_to_end_id: "E2E1" });
    const r = await routeWebhook(p, d, w);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.action).toBe("register_payment");
      expect(r.value.event.status).toBe("quitado");
      expect(r.value.event.pixEndToEndId).toBe("E2E1");
      expect(r.value.dedupeKey).toBe("sandbox:e1");
    }
  });

  it("webhook SEM assinatura é recusado", async () => {
    const w = await webhook({ event_id: "e1", status: "PAID", payment_id: "x" });
    const r = await routeWebhook(p, d, { rawBody: w.rawBody, headers: { "x-provider": "sandbox" } });
    expect(r.ok).toBe(false);
    if (r.ok !== true) expect(r.error.code).toBe("assinatura_ausente");
  });

  it("assinatura INVÁLIDA é recusada", async () => {
    const w = await webhook({ event_id: "e1", status: "PAID", payment_id: "x" });
    const r = await routeWebhook(p, d, { rawBody: w.rawBody, headers: { "x-signature": "deadbeef" } });
    expect(r.ok).toBe(false);
    if (r.ok !== true) expect(r.error.code).toBe("assinatura_invalida");
  });

  it("corpo adulterado invalida a assinatura", async () => {
    const w = await webhook({ event_id: "e1", status: "PAID", payment_id: "x", amount_cents: 100 });
    const adulterado = w.rawBody.replace('"amount_cents":100', '"amount_cents":100000');
    const r = await routeWebhook(p, d, { rawBody: adulterado, headers: w.headers });
    expect(r.ok).toBe(false);
  });

  it("webhook DUPLICADO não processa duas vezes", async () => {
    const w = await webhook({ event_id: "e1", status: "PAID", payment_id: "sbx_k1" });
    const a = await routeWebhook(p, d, w);
    const b = await routeWebhook(p, d, w);
    expect(a.ok && a.value.action).toBe("register_payment");
    expect(b.ok && b.value.action).toBe("ignore");
    if (b.ok) expect(b.value.reason).toBe("webhook_duplicado");
  });

  it("status desconhecido vira 'ignore', nunca pagamento", async () => {
    const w = await webhook({ event_id: "e9", status: "SOMETHING_NEW", payment_id: "x" });
    const r = await routeWebhook(p, d, w);
    expect(r.ok && r.value.action).toBe("ignore");
  });

  it("pagamento aprovado sem providerPaymentId é recusado", async () => {
    const w = await webhook({ event_id: "e2", status: "PAID" });
    const r = await routeWebhook(p, d, w);
    expect(r.ok).toBe(false);
    if (r.ok !== true) expect(r.error.code).toBe("webhook_sem_pagamento");
  });

  it("estorno, falha, cancelamento e expiração viram ações próprias", () => {
    const base = { provider: "sandbox" as const, eventId: "x", type: "t", raw: {} };
    expect(acaoPara({ ...base, status: "estornado" })).toBe("register_refund");
    expect(acaoPara({ ...base, status: "falhou" })).toBe("mark_failed");
    expect(acaoPara({ ...base, status: "cancelado" })).toBe("mark_cancelled");
    expect(acaoPara({ ...base, status: "expirado" })).toBe("mark_expired");
  });

  it("identifica o provedor pelo header", () => {
    expect(identificarProvider({ "X-Provider": "sandbox" })).toBe("sandbox");
    expect(identificarProvider({ "x-provider": "gateway_falso" })).toBeNull();
  });

  it("JSON inválido com assinatura válida ainda é recusado", async () => {
    const raw = "{nao-e-json";
    const r = await routeWebhook(p, d, { rawBody: raw, headers: { "x-signature": await hmac(raw) } });
    expect(r.ok).toBe(false);
    if (r.ok !== true) expect(r.error.code).toBe("corpo_invalido");
  });
});

describe("resiliência: provedor indisponível e timeout", () => {
  it("provedor fora do ar devolve erro RETENTÁVEL, não exceção", async () => {
    p.indisponivel = true;
    const r = await p.createPix({ chargeId: "c", amountCents: 1, idempotencyKey: "k" });
    expect(r.ok).toBe(false);
    if (r.ok !== true) { expect(r.error.code).toBe("provider_unavailable"); expect(r.error.retryable).toBe(true); }
  });
  it("nenhuma operação lança — todas devolvem Result", async () => {
    p.indisponivel = true;
    for (const chamada of [
      () => p.createPix({ chargeId: "c", amountCents: 1, idempotencyKey: "k" }),
      () => p.getPayment("inexistente"),
      () => p.refund({ providerPaymentId: "x", idempotencyKey: "k" }),
      () => p.cancelBoleto("x"),
    ]) await expect(chamada()).resolves.toHaveProperty("ok", false);
  });
  it("pagamento inexistente falha sem derrubar", async () => {
    const r = await p.getPayment("nao_existe");
    expect(r.ok).toBe(false);
  });
});

describe("estorno", () => {
  it("refund marca estornado", async () => {
    const c = await p.createPix({ chargeId: "ch", amountCents: 100, idempotencyKey: "k" });
    if (!c.ok) return;
    const r = await p.refund({ providerPaymentId: c.value.providerPaymentId, idempotencyKey: "r1" });
    expect(r.ok && r.value.status).toBe("estornado");
  });
});

describe("segurança e isolamento da camada", () => {
  const arqs = ["src/lib/payments/PaymentProvider.ts", "src/lib/payments/types.ts",
                "src/lib/payments/webhookRouter.ts", "src/lib/payments/SandboxProvider.ts"];
  const semComentario = (t: string) => t.split("\n")
    .filter((l) => { const x = l.trim();
      return !x.startsWith("//") && !x.startsWith("*") && !x.startsWith("/*"); }).join("\n");

  it("nenhum acesso a tabela: a camada não conhece o banco", () => {
    for (const f of arqs) {
      const c = semComentario(fs.readFileSync(path.join(REPO, f), "utf8"));
      for (const p2 of ["supabase", "supabase.from(", ".rpc(", "billing_payments", "billing_charges"]) {
        expect(c, `${f}:${p2}`).not.toContain(p2);
      }
    }
  });

  it("nenhuma referência operacional", () => {
    for (const f of arqs) {
      const c = semComentario(fs.readFileSync(path.join(REPO, f), "utf8"));
      for (const p2 of ["farms", "equipments", "commands", "desired_running",
                        "automation", "scheduled", "device_licenses", "license_key"]) {
        expect(c, `${f}:${p2}`).not.toMatch(new RegExp(`\\b${p2}\\b`));
      }
    }
  });

  it("nenhum dado sensível de cartão no contrato", () => {
    for (const f of arqs) {
      const c = semComentario(fs.readFileSync(path.join(REPO, f), "utf8"));
      for (const p2 of ["cvv", "cvc", "card_number", "pan", "cardholder", "expiry_month"]) {
        expect(c, `${f}:${p2}`).not.toMatch(new RegExp(`\\b${p2}\\b`, "i"));
      }
    }
  });

  it("um único adaptador nesta Sprint", () => {
    const dir = fs.readdirSync(path.join(REPO, "src/lib/payments"))
      .filter((f) => /Provider\.ts$/.test(f) && f !== "PaymentProvider.ts");
    expect(dir).toEqual(["SandboxProvider.ts"]);
  });

  it("a comparação de assinatura é de tempo constante", () => {
    const c = fs.readFileSync(path.join(REPO, "src/lib/payments/SandboxProvider.ts"), "utf8");
    // A definição existir não basta: ela precisa ser CHAMADA na verificação,
    // e nenhuma comparação direta pode substituí-la.
    const rw = c.slice(c.indexOf("async receiveWebhook"));
    expect(rw).toContain("igualSeguro(assinatura, esperada)");
    expect(rw).not.toMatch(/assinatura\s*(===|!==|==|!=)\s*esperada/);
  });
});
