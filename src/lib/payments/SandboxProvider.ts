// ÚNICO adaptador desta Sprint. Sandbox: implementa o contrato inteiro sem
// nenhuma chamada de rede. Serve para exercitar a arquitetura ponta a ponta e
// para homologação — e prova que a interface é implementável por completo antes
// de assinarmos com qualquer PSP.
//
// Assinatura HMAC-SHA256 sobre o corpo cru, o padrão que Stripe, Asaas,
// Mercado Pago e os bancos usam com pequenas variações. Trocar de PSP mexe
// SÓ neste arquivo.
import { fail, ok, withTimeout, type Result } from "./types";
import type {
  Environment, PaymentProvider, PaymentStatus, ProviderCharge, ProviderConfig,
  ProviderCustomer, ProviderId, ProviderRecurringAuthorization, WalletToken, WebhookEvent,
} from "./PaymentProvider";

const MAPA_STATUS: Record<string, PaymentStatus> = {
  PENDING: "pendente", AUTHORIZED: "autorizado", CAPTURED: "capturado",
  PARTIAL: "parcial", PAID: "quitado", CANCELLED: "cancelado",
  REFUNDED: "estornado", FAILED: "falhou", EXPIRED: "expirado",
};

async function hmacHex(segredo: string, corpo: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(segredo),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(corpo)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparação de tempo constante: `===` vaza o prefixo correto pelo tempo. */
function igualSeguro(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let dif = a.length ^ b.length;
  for (let i = 0; i < len; i++) dif |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return dif === 0;
}

export class SandboxProvider implements PaymentProvider {
  readonly id: ProviderId = "sandbox";
  readonly environment: Environment;
  private readonly timeoutMs: number;
  private readonly segredo: string;
  /** Cobranças criadas, por idempotencyKey — retry devolve a MESMA. */
  private readonly porChave = new Map<string, ProviderCharge>();
  private readonly porId = new Map<string, ProviderCharge>();
  /** Injetável só para teste de indisponibilidade; nunca usado em produção. */
  indisponivel = false;

  constructor(cfg: ProviderConfig) {
    this.environment = cfg.environment;
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    this.segredo = cfg.credentials.webhookSecret ?? "";
    if (!this.segredo) throw new Error("credencial webhookSecret ausente");
  }

  private async chamada<T>(rotulo: string, fn: () => Promise<T>): Promise<Result<T>> {
    if (this.indisponivel) return fail("provider_unavailable", `${rotulo}: provedor indisponível`, true);
    return withTimeout(fn(), this.timeoutMs, rotulo);
  }

  private cobranca(chargeId: string, amountCents: number, chave: string,
                   extra: Partial<ProviderCharge> = {}): ProviderCharge {
    const existente = this.porChave.get(chave);
    if (existente) return existente;   // IDEMPOTÊNCIA no gateway
    const c: ProviderCharge = {
      providerPaymentId: `sbx_${chave}`, providerStatus: "PENDING", status: "pendente",
      amountCents, raw: { chargeId }, ...extra,
    };
    this.porChave.set(chave, c); this.porId.set(c.providerPaymentId, c);
    return c;
  }

  async createCustomer(i: Omit<ProviderCustomer, "providerCustomerId">) {
    return this.chamada("createCustomer", async () =>
      ({ ...i, providerCustomerId: `cus_${i.docNumber}` }));
  }
  async updateCustomer(providerCustomerId: string, patch: Partial<ProviderCustomer>) {
    return this.chamada("updateCustomer", async () =>
      ({ providerCustomerId, docNumber: patch.docNumber ?? "", name: patch.name ?? "", ...patch }));
  }

  async createPix(i: { chargeId: string; amountCents: number; expiresInSeconds?: number; idempotencyKey: string }) {
    return this.chamada("createPix", async () => this.cobranca(i.chargeId, i.amountCents, i.idempotencyKey, {
      // TXID único por chave: retry devolve o mesmo, chamadas distintas nunca colidem.
      pix: { txid: `txid_${i.idempotencyKey}`, qrCode: `00020126...${i.idempotencyKey}`,
             copyPaste: `00020126...${i.idempotencyKey}`, endToEndId: null },
      expiresAt: new Date(Date.now() + (i.expiresInSeconds ?? 3600) * 1000).toISOString(),
    }));
  }
  async cancelPix(id: string) { return this.cancelar("cancelPix", id); }

  async createRecurringPix(i: { providerCustomerId: string; maxAmountCents: number;
                                periodicity: ProviderRecurringAuthorization["periodicity"];
                                idempotencyKey: string }) {
    return this.chamada("createRecurringPix", async (): Promise<ProviderRecurringAuthorization> => ({
      authorizationId: `auth_${i.idempotencyKey}`, providerCustomerId: i.providerCustomerId,
      status: "pendente", maxAmountCents: i.maxAmountCents, periodicity: i.periodicity,
      authorizedAt: null, expiresAt: null, raw: {},
    }));
  }
  async cancelRecurringPix(authorizationId: string) {
    return this.chamada("cancelRecurringPix", async (): Promise<ProviderRecurringAuthorization> => ({
      authorizationId, providerCustomerId: "", status: "revogado", maxAmountCents: 0,
      periodicity: "mensal", authorizedAt: null, expiresAt: null, raw: {},
    }));
  }

  private carteira(rotulo: string, i: { chargeId: string; amountCents: number; token: WalletToken; idempotencyKey: string }) {
    return this.chamada(rotulo, async () => {
      // Token apenas. PAN, CVV e material criptográfico jamais chegam aqui.
      if (!i.token?.token) throw new Error("token ausente");
      return this.cobranca(i.chargeId, i.amountCents, i.idempotencyKey,
        { providerStatus: "AUTHORIZED", status: "autorizado" });
    });
  }
  async createCardPayment(i: { chargeId: string; amountCents: number; token: WalletToken; idempotencyKey: string }) {
    return this.carteira("createCardPayment", i);
  }
  async createApplePay(i: { chargeId: string; amountCents: number; token: WalletToken; idempotencyKey: string }) {
    return this.carteira("createApplePay", i);
  }
  async createGooglePay(i: { chargeId: string; amountCents: number; token: WalletToken; idempotencyKey: string }) {
    return this.carteira("createGooglePay", i);
  }
  async cancelCard(id: string) { return this.cancelar("cancelCard", id); }

  async createBoleto(i: { chargeId: string; amountCents: number; dueDate: string; idempotencyKey: string }) {
    return this.chamada("createBoleto", async () => this.cobranca(i.chargeId, i.amountCents, i.idempotencyKey, {
      boleto: { line: `34191.79001 01043.510047 91020.150008 ${i.idempotencyKey.slice(0,1)} 00000000000000`,
                ourNumber: `NN${i.idempotencyKey}`, barcode: `BC${i.idempotencyKey}`,
                pdfUrl: `https://sandbox.invalid/boleto/${i.idempotencyKey}.pdf`, dueDate: i.dueDate },
    }));
  }
  async cancelBoleto(id: string) { return this.cancelar("cancelBoleto", id); }

  private cancelar(rotulo: string, id: string) {
    return this.chamada(rotulo, async () => {
      const c = this.porId.get(id);
      if (!c) throw new Error("pagamento não encontrado");
      const novo = { ...c, providerStatus: "CANCELLED", status: "cancelado" as PaymentStatus };
      this.porId.set(id, novo);
      return novo;
    });
  }

  async getPayment(id: string) {
    return this.chamada("getPayment", async () => {
      const c = this.porId.get(id);
      if (!c) throw new Error("pagamento não encontrado");
      return c;
    });
  }

  async refund(i: { providerPaymentId: string; amountCents?: number; idempotencyKey: string }) {
    return this.chamada("refund", async () => {
      const c = this.porId.get(i.providerPaymentId);
      if (!c) throw new Error("pagamento não encontrado");
      return { ...c, providerStatus: "REFUNDED", status: "estornado" as PaymentStatus };
    });
  }

  async receiveWebhook(i: { rawBody: string; headers: Record<string, string> }): Promise<Result<WebhookEvent>> {
    const h = Object.fromEntries(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const assinatura = h["x-signature"] ?? "";
    if (!assinatura) return fail("assinatura_ausente", "Webhook sem assinatura", false);

    const esperada = await hmacHex(this.segredo, i.rawBody);
    if (!igualSeguro(assinatura, esperada)) {
      return fail("assinatura_invalida", "Assinatura do webhook não confere", false);
    }

    let body: Record<string, unknown>;
    try { body = JSON.parse(i.rawBody) as Record<string, unknown>; }
    catch { return fail("corpo_invalido", "Webhook com JSON inválido", false); }

    const st = String(body.status ?? "");
    return ok({
      provider: this.id, eventId: String(body.event_id ?? ""), type: String(body.type ?? ""),
      providerPaymentId: body.payment_id ? String(body.payment_id) : null,
      providerTransactionId: body.transaction_id ? String(body.transaction_id) : null,
      authorizationId: body.authorization_id ? String(body.authorization_id) : null,
      // Status desconhecido vira null → o roteador manda `ignore`, nunca
      // "aprovado" por omissão.
      status: MAPA_STATUS[st] ?? null,
      amountCents: typeof body.amount_cents === "number" ? body.amount_cents : null,
      pixEndToEndId: body.end_to_end_id ? String(body.end_to_end_id) : null,
      occurredAt: body.occurred_at ? String(body.occurred_at) : null,
      raw: body,
    });
  }
}

export const sandboxFactory = (cfg: ProviderConfig) => new SandboxProvider(cfg);
