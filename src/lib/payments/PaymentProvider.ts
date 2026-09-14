// ─────────────────────────────────────────────────────────────────────────────
// PaymentProvider — a ÚNICA porta para gateways de pagamento.
// ─────────────────────────────────────────────────────────────────────────────
// Nenhum ponto da plataforma fala com gateway diretamente. Tudo passa por esta
// interface. Trocar de banco/PSP passa a ser escrever um adaptador novo — sem
// tocar em RPC, tabela, dashboard, cobrança ou recebimento.
//
// Este arquivo é CONTRATO PURO: sem rede, sem SDK, sem credencial. É o que
// permite testar as regras (idempotência, assinatura, mapeamento de status)
// sem nenhum gateway integrado.
//
// SEGREDO NUNCA VIVE AQUI. Credenciais ficam só no backend (Vault/env da Edge
// Function). O contrato recebe um `ProviderConfig` opaco, e nenhum campo dele é
// devolvido em resposta, log ou erro.

import type { Result } from "./types";

export type ProviderId =
  | "banco_do_brasil" | "bradesco" | "sicredi" | "mercado_pago" | "pagseguro"
  | "asaas" | "stripe" | "pagarme" | "stone" | "pagbank" | "sandbox";

export type Environment = "development" | "staging" | "production";

/** Credenciais resolvidas no BACKEND. Nunca serializado para o frontend. */
export interface ProviderConfig {
  provider: ProviderId;
  environment: Environment;
  /** Valores opacos vindos do Vault/env. O contrato nunca os inspeciona. */
  credentials: Readonly<Record<string, string>>;
  /** Timeout por chamada. Gateway lento não pode travar a plataforma. */
  timeoutMs?: number;
}

// ── Modelos neutros ────────────────────────────────────────────────────────
// Deliberadamente NÃO espelham nenhum gateway: é o adaptador que traduz.

export interface ProviderCustomer {
  providerCustomerId: string;
  /** Documento normalizado (só dígitos). Nunca PAN, nunca CVV. */
  docNumber: string;
  name: string;
  email?: string | null;
  phone?: string | null;
}

export type PaymentStatus =
  | "pendente" | "autorizado" | "capturado" | "parcial" | "quitado"
  | "cancelado" | "estornado" | "falhou" | "expirado";

export interface ProviderCharge {
  providerPaymentId: string;
  providerTransactionId?: string | null;
  providerReference?: string | null;
  providerStatus: string;
  status: PaymentStatus;
  amountCents: number;
  expiresAt?: string | null;
  /** PIX */
  pix?: { txid: string; qrCode?: string | null; copyPaste?: string | null;
          endToEndId?: string | null } | null;
  /** BOLETO — só identificadores públicos do documento. */
  boleto?: { line: string; ourNumber?: string | null; barcode?: string | null;
             pdfUrl?: string | null; dueDate: string } | null;
  raw: Record<string, unknown>;
}

/** Autorização de PIX Recorrente. A autorização vive no PSP; guardamos a
 *  referência e o teto que nós mesmos pactuamos. */
export interface ProviderRecurringAuthorization {
  authorizationId: string;
  providerCustomerId: string;
  status: "pendente" | "ativo" | "revogado" | "expirado" | "falhou";
  maxAmountCents: number;
  periodicity: "mensal" | "bimestral" | "trimestral" | "semestral" | "anual";
  authorizedAt?: string | null;
  expiresAt?: string | null;
  raw: Record<string, unknown>;
}

/** Token de carteira/cartão. NUNCA PAN, CVV, senha ou material criptográfico. */
export interface WalletToken {
  token: string;
  brand?: string | null;
  last4?: string | null;
}

export interface WebhookEvent {
  provider: ProviderId;
  /** Id do EVENTO no provedor — chave de deduplicação do webhook. */
  eventId: string;
  type: string;
  providerPaymentId?: string | null;
  providerTransactionId?: string | null;
  authorizationId?: string | null;
  status?: PaymentStatus | null;
  amountCents?: number | null;
  pixEndToEndId?: string | null;
  occurredAt?: string | null;
  raw: Record<string, unknown>;
}

// ── A INTERFACE ────────────────────────────────────────────────────────────
export interface PaymentProvider {
  readonly id: ProviderId;
  readonly environment: Environment;

  createCustomer(input: Omit<ProviderCustomer, "providerCustomerId">): Promise<Result<ProviderCustomer>>;
  updateCustomer(providerCustomerId: string, patch: Partial<ProviderCustomer>): Promise<Result<ProviderCustomer>>;

  /** `idempotencyKey` é OBRIGATÓRIO em toda criação: retry de rede nunca pode
   *  gerar duas cobranças no gateway. */
  createPix(i: { chargeId: string; amountCents: number; providerCustomerId?: string | null;
                 expiresInSeconds?: number; idempotencyKey: string }): Promise<Result<ProviderCharge>>;
  cancelPix(providerPaymentId: string): Promise<Result<ProviderCharge>>;

  createRecurringPix(i: { providerCustomerId: string; maxAmountCents: number;
                          periodicity: ProviderRecurringAuthorization["periodicity"];
                          idempotencyKey: string }): Promise<Result<ProviderRecurringAuthorization>>;
  cancelRecurringPix(authorizationId: string): Promise<Result<ProviderRecurringAuthorization>>;

  createCardPayment(i: { chargeId: string; amountCents: number; token: WalletToken;
                         providerCustomerId?: string | null; idempotencyKey: string }): Promise<Result<ProviderCharge>>;
  cancelCard(providerPaymentId: string): Promise<Result<ProviderCharge>>;

  createApplePay(i: { chargeId: string; amountCents: number; token: WalletToken;
                      idempotencyKey: string }): Promise<Result<ProviderCharge>>;
  createGooglePay(i: { chargeId: string; amountCents: number; token: WalletToken;
                       idempotencyKey: string }): Promise<Result<ProviderCharge>>;

  createBoleto(i: { chargeId: string; amountCents: number; dueDate: string;
                    providerCustomerId?: string | null; idempotencyKey: string }): Promise<Result<ProviderCharge>>;
  cancelBoleto(providerPaymentId: string): Promise<Result<ProviderCharge>>;

  getPayment(providerPaymentId: string): Promise<Result<ProviderCharge>>;
  refund(i: { providerPaymentId: string; amountCents?: number;
              idempotencyKey: string }): Promise<Result<ProviderCharge>>;

  /** Valida assinatura e NORMALIZA. Nunca toca no banco — quem persiste é o
   *  serviço interno, que decide o que fazer com o evento normalizado. */
  receiveWebhook(i: { rawBody: string; headers: Record<string, string> }): Promise<Result<WebhookEvent>>;
}

/** Registro de adaptadores. A plataforma resolve por id; nenhum ponto importa
 *  um gateway concreto. Adicionar PSP = registrar aqui, e nada mais muda. */
const registry = new Map<ProviderId, (cfg: ProviderConfig) => PaymentProvider>();

export function registerProvider(id: ProviderId, factory: (cfg: ProviderConfig) => PaymentProvider): void {
  registry.set(id, factory);
}

export function getProvider(cfg: ProviderConfig): Result<PaymentProvider> {
  const f = registry.get(cfg.provider);
  if (!f) return { ok: false, error: { code: "provider_not_registered", message: `Provedor ${cfg.provider} não registrado`, retryable: false } };
  try { return { ok: true, value: f(cfg) }; }
  catch (e) {
    return { ok: false, error: { code: "provider_init_failed",
      message: e instanceof Error ? e.message : String(e), retryable: false } };
  }
}

export function listRegisteredProviders(): ProviderId[] { return [...registry.keys()]; }
export function __resetRegistry(): void { registry.clear(); }
