// @vitest-environment node
// SPRINT 5 — PaymentService: webhook → operação financeira.
// NENHUM PSP real. NENHUM Supabase: a porta BillingGateway é injetada, e é isso
// que permite testar TODA a regra sem banco.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { PaymentService, mapMethod, type BillingGateway } from "@/lib/payments/PaymentService";
import { WebhookDedupe, routeWebhook, type WebhookCommand } from "@/lib/payments/webhookRouter";
import { SandboxProvider } from "@/lib/payments/SandboxProvider";
import { ok, fail, type Result } from "@/lib/payments/types";
import type { WebhookEvent } from "@/lib/payments/PaymentProvider";

const REPO = path.resolve(__dirname, "../..");
const SEGREDO = "seg-sprint5";
const hmac = async (corpo: string) => {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(SEGREDO),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(corpo)));
  return Array.from(s, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** Espião da porta. Conta chamadas — é como provamos "nenhum SELECT duplicado". */
class GatewaySpy implements BillingGateway {
  chamadas: string[] = [];
  eventos: string[] = [];
  chargeId: string | null = "ch-1";
  falharRegistro: Result<never> | null = null;
  falharEstorno: Result<never> | null = null;
  async resolveCharge() { this.chamadas.push("resolveCharge"); return ok({ chargeId: this.chargeId }); }
  async registerPayment(i: { amountCents: number }) {
    this.chamadas.push("registerPayment");
    if (this.falharRegistro) return this.falharRegistro;
    return ok({ paymentId: "pay-1", saldoCents: 100000 - i.amountCents,
                chargeStatus: i.amountCents >= 100000 ? "paga" : "paga_parcial" });
  }
  async reversePayment() {
    this.chamadas.push("reversePayment");
    if (this.falharEstorno) return this.falharEstorno;
    return ok({ reversalId: "rev-1" });
  }
  async updateAuthorization() { this.chamadas.push("updateAuthorization"); return ok({ methodId: "pm-1" }); }
  async recordEvent(i: { event: string }) {
    this.chamadas.push("recordEvent"); this.eventos.push(i.event); return ok({ eventId: "ev-1" });
  }
}

const ev = (o: Partial<WebhookEvent> = {}): WebhookEvent => ({
  provider: "sandbox", eventId: "e1", type: "payment.paid",
  providerPaymentId: "sbx_1", status: "quitado", amountCents: 100000, raw: {}, ...o });
const cmd = (action: WebhookCommand["action"], e = ev(), reason?: string): WebhookCommand =>
  ({ action, event: e, dedupeKey: `sandbox:${e.eventId}`, reason });

let g: GatewaySpy; let svc: PaymentService;
beforeEach(() => { g = new GatewaySpy(); svc = new PaymentService(g); });

describe("pagamento", () => {
  it("total: registra e quita", async () => {
    const r = await svc.process(cmd("register_payment"));
    expect(r.ok).toBe(true);
    if (r.ok === true) {
      expect(r.value.applied).toBe(true);
      expect(r.value.chargeStatus).toBe("paga");
      expect(r.value.saldoCents).toBe(0);
    }
  });

  it("parcial: registra e deixa saldo", async () => {
    const r = await svc.process(cmd("register_payment", ev({ amountCents: 30000 })));
    if (r.ok === true) {
      expect(r.value.applied).toBe(true);
      expect(r.value.saldoCents).toBe(70000);
      expect(r.value.chargeStatus).toBe("paga_parcial");
    }
  });

  it("valor inválido não chega a tocar a RPC", async () => {
    const r = await svc.process(cmd("register_payment", ev({ amountCents: 0 })));
    expect(r.ok).toBe(false);
    expect(g.chamadas).not.toContain("registerPayment");
    expect(g.eventos).toContain("webhook_error");
  });

  it("cobrança não encontrada vira erro registrado, não pagamento órfão", async () => {
    g.chargeId = null;
    const r = await svc.process(cmd("register_payment"));
    expect(r.ok).toBe(false);
    if (r.ok !== true) expect(r.error.message).toBe("cobranca_nao_encontrada");
    expect(g.chamadas).not.toContain("registerPayment");
  });

  it("UNIQUE do banco barrando reprocessamento NÃO é tratado como falha", async () => {
    // A barreira definitiva é o banco. Reportar isso como erro geraria alarme falso.
    g.falharRegistro = fail("duplicado", "duplicate key value violates unique constraint");
    const r = await svc.process(cmd("register_payment"));
    expect(r.ok).toBe(true);
    if (r.ok === true) { expect(r.value.applied).toBe(false); expect(r.value.reason).toBe("ja_registrado"); }
    expect(g.eventos).toContain("webhook_duplicate_blocked");
  });
});

describe("estorno", () => {
  it("registra estorno", async () => {
    const r = await svc.process(cmd("register_refund", ev({ status: "estornado" })));
    expect(r.ok === true && r.value.applied).toBe(true);
  });
  it("estorno duplicado é absorvido, não vira erro", async () => {
    g.falharEstorno = fail("already_reversed", "already_reversed");
    const r = await svc.process(cmd("register_refund", ev({ status: "estornado" })));
    expect(r.ok === true && r.value.reason).toBe("ja_estornado");
  });
  it("estorno sem pagamento é recusado", async () => {
    const r = await svc.process(cmd("register_refund", ev({ providerPaymentId: null })));
    expect(r.ok).toBe(false);
    expect(g.chamadas).not.toContain("reversePayment");
  });
});

describe("autorização PIX Recorrente", () => {
  it("autorizado → ativo", async () => {
    const r = await svc.process(cmd("update_authorization",
      ev({ status: "autorizado", authorizationId: "auth_1" })));
    expect(r.ok === true && r.value.applied).toBe(true);
    expect(g.chamadas).toContain("updateAuthorization");
  });
  it("sem authorizationId é recusado", async () => {
    const r = await svc.process(cmd("update_authorization", ev({ status: "autorizado" })));
    expect(r.ok).toBe(false);
  });
});

describe("recusa, cancelamento, expiração e ignorado — só trilha", () => {
  for (const [acao, evento] of [["mark_failed","payment_failed"],
    ["mark_cancelled","payment_cancelled"], ["mark_expired","payment_expired"]] as const) {
    it(`${acao} registra ${evento} e NÃO mexe em dinheiro`, async () => {
      const r = await svc.process(cmd(acao));
      expect(r.ok === true && r.value.applied).toBe(true);
      expect(g.eventos).toContain(evento);
      expect(g.chamadas).not.toContain("registerPayment");
      expect(g.chamadas).not.toContain("reversePayment");
    });
  }
  it("ignore registra e não aplica nada", async () => {
    const r = await svc.process(cmd("ignore", ev(), "webhook_duplicado"));
    expect(r.ok === true && r.value.applied).toBe(false);
    expect(g.eventos).toContain("webhook_ignored");
    expect(g.chamadas).not.toContain("registerPayment");
  });
  it("register_error sempre falha e deixa trilha", async () => {
    const r = await svc.process(cmd("register_error", ev(), "assinatura"));
    expect(r.ok).toBe(false);
    expect(g.eventos).toContain("webhook_error");
  });
});

describe("resiliência", () => {
  it("exceção inesperada vira erro registrado, nunca propaga", async () => {
    const quebrado: BillingGateway = {
      ...g, resolveCharge: async () => { throw new Error("banco caiu"); },
    } as unknown as BillingGateway;
    const s2 = new PaymentService(quebrado);
    await expect(s2.process(cmd("register_payment"))).resolves.toHaveProperty("ok", false);
  });
  it("falha da RPC vira erro tratado", async () => {
    g.falharRegistro = fail("timeout", "timeout ao gravar", true);
    const r = await svc.process(cmd("register_payment"));
    expect(r.ok).toBe(false);
    if (r.ok !== true) expect(r.error.message).toContain("registro_falhou");
  });
});

describe("performance: nenhuma consulta repetida", () => {
  it("um pagamento faz UMA leitura e UMA escrita", async () => {
    await svc.process(cmd("register_payment"));
    expect(g.chamadas.filter((c) => c === "resolveCharge")).toHaveLength(1);
    expect(g.chamadas.filter((c) => c === "registerPayment")).toHaveLength(1);
    expect(g.chamadas).not.toContain("updateAuthorization");
  });
  it("ações de trilha não fazem leitura nenhuma", async () => {
    await svc.process(cmd("mark_failed"));
    expect(g.chamadas).not.toContain("resolveCharge");
  });
});

describe("mapeamento de método", () => {
  const casos: Array<[string, string]> = [
    ["pix", "pix"], ["pix_automatico", "pix_automatico"], ["apple_pay", "apple_pay"],
    ["google_pay", "google_pay"], ["credit_card", "cartao_credito"], ["debit_card", "cartao_debito"],
    ["boleto", "boleto"], ["transfer", "transferencia"], ["desconhecido", "outro"]];
  for (const [entrada, esperado] of casos) {
    it(`${entrada} → ${esperado}`, () => {
      expect(mapMethod(ev({ raw: { method: entrada } }))).toBe(esperado);
    });
  }
});

describe("ponta a ponta: gateway → router → service", () => {
  const p = () => new SandboxProvider({ provider: "sandbox", environment: "development",
    credentials: { webhookSecret: SEGREDO }, timeoutMs: 5000 });
  const webhook = async (body: Record<string, unknown>) => {
    const rawBody = JSON.stringify(body);
    return { rawBody, headers: { "x-signature": await hmac(rawBody) } };
  };

  it("pagamento aprovado percorre a cadeia e aplica", async () => {
    const d = new WebhookDedupe();
    const w = await webhook({ event_id: "e1", type: "pix.paid", status: "PAID",
      payment_id: "sbx_1", amount_cents: 100000, method: "pix" });
    const rota = await routeWebhook(p(), d, w);
    expect(rota.ok).toBe(true);
    if (rota.ok !== true) return;
    const r = await svc.process(rota.value);
    expect(r.ok === true && r.value.applied).toBe(true);
  });

  it("replay do MESMO webhook não aplica duas vezes", async () => {
    const d = new WebhookDedupe(); const prov = p();
    const w = await webhook({ event_id: "e1", status: "PAID", payment_id: "sbx_1",
      amount_cents: 100000, method: "pix" });
    const a = await routeWebhook(prov, d, w);
    const b = await routeWebhook(prov, d, w);
    if (a.ok === true) await svc.process(a.value);
    if (b.ok === true) await svc.process(b.value);
    expect(g.chamadas.filter((c) => c === "registerPayment")).toHaveLength(1);
    expect(g.eventos).toContain("webhook_ignored");
  });

  it("assinatura inválida nunca chega ao service", async () => {
    const d = new WebhookDedupe();
    const w = await webhook({ event_id: "e1", status: "PAID", payment_id: "x" });
    const rota = await routeWebhook(p(), d, { rawBody: w.rawBody, headers: { "x-signature": "beef" } });
    expect(rota.ok).toBe(false);
    expect(g.chamadas).toHaveLength(0);   // service nem foi invocado
  });

  it("webhook fora de ordem: expirado depois de pago não desfaz o pagamento", async () => {
    const d = new WebhookDedupe(); const prov = p();
    const pago = await webhook({ event_id: "e1", status: "PAID", payment_id: "sbx_1",
      amount_cents: 100000, method: "pix" });
    const exp = await webhook({ event_id: "e2", status: "EXPIRED", payment_id: "sbx_1" });
    const a = await routeWebhook(prov, d, pago);
    const b = await routeWebhook(prov, d, exp);
    if (a.ok === true) await svc.process(a.value);
    if (b.ok === true) await svc.process(b.value);
    // expiração é só trilha — nenhum estorno, nenhum segundo pagamento
    expect(g.chamadas.filter((c) => c === "registerPayment")).toHaveLength(1);
    expect(g.chamadas).not.toContain("reversePayment");
    expect(g.eventos).toContain("payment_expired");
  });

  it("provedor indisponível não derruba o fluxo", async () => {
    const prov = p(); prov.indisponivel = true;
    const r = await prov.createPix({ chargeId: "c", amountCents: 1, idempotencyKey: "k" });
    expect(r.ok).toBe(false);
  });
});

describe("barreira: o service é o único caminho para as RPCs", () => {
  const arqs = ["src/lib/payments/PaymentProvider.ts", "src/lib/payments/types.ts",
                "src/lib/payments/webhookRouter.ts", "src/lib/payments/SandboxProvider.ts",
                "src/lib/payments/PaymentService.ts"];
  const semComentario = (t: string) => t.split("\n")
    .filter((l) => { const x = l.trim();
      return !x.startsWith("//") && !x.startsWith("*") && !x.startsWith("/*"); }).join("\n");

  it("router e provider NÃO conhecem billing nem RPC", () => {
    for (const f of ["src/lib/payments/webhookRouter.ts", "src/lib/payments/SandboxProvider.ts",
                     "src/lib/payments/PaymentProvider.ts"]) {
      const c = semComentario(fs.readFileSync(path.join(REPO, f), "utf8"));
      for (const p2 of ["billing_register_manual_payment", "billing_reverse_payment",
                        "billing_payments", "billing_charges", "supabase", ".rpc("]) {
        expect(c, `${f}:${p2}`).not.toContain(p2);
      }
    }
  });

  it("nem o PaymentService importa Supabase — a porta é injetada", () => {
    const c = semComentario(fs.readFileSync(path.join(REPO, "src/lib/payments/PaymentService.ts"), "utf8"));
    expect(c).not.toContain("supabase");
    expect(c).not.toContain("@/integrations");
  });

  it("BARRIER CHECK operacional: zero ocorrências", () => {
    for (const f of arqs) {
      const c = semComentario(fs.readFileSync(path.join(REPO, f), "utf8"));
      for (const p2 of ["farms","equipments","commands","desired_running","pending_command",
                        "automation_","scheduled_","license_key","device_licenses",
                        "platform_set_farm_suspended","technical_events","agent","telemetry"]) {
        expect(c, `${f}:${p2}`).not.toMatch(new RegExp(`\\b${p2}`, "i"));
      }
    }
  });

  it("nenhum segredo em código, log ou resposta", () => {
    for (const f of arqs) {
      const c = semComentario(fs.readFileSync(path.join(REPO, f), "utf8"));
      expect(c, f).not.toMatch(/console\.(log|warn|error)/);
      for (const p2 of ["password","api_key","apikey","private_key","service_role"]) {
        expect(c, `${f}:${p2}`).not.toMatch(new RegExp(`\\b${p2}\\b`, "i"));
      }
    }
  });

  it("as 8 ações do contrato estão implementadas", () => {
    const c = fs.readFileSync(path.join(REPO, "src/lib/payments/PaymentService.ts"), "utf8");
    for (const a of ["register_payment","register_refund","mark_failed","mark_cancelled",
                     "mark_expired","update_authorization","ignore","register_error"]) {
      expect(c, a).toContain(`"${a}"`);
    }
  });
});
