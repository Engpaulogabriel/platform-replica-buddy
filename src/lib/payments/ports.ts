// ─────────────────────────────────────────────────────────────────────────────
// ports.ts — SOMENTE CONTRATOS. Nenhuma implementação.
// ─────────────────────────────────────────────────────────────────────────────
// Existe para quebrar a dependência arquitetural entre o orquestrador
// (PaymentService) e os adaptadores (SupabaseBillingGateway, providers).
// Antes, `BillingGateway` morava dentro de PaymentService.ts, então todo
// adaptador precisava importar o serviço que ele serve — inversão de
// dependência ao contrário. Agora ambos dependem só do contrato.
import type { Result } from "./types";

/** Porta para os serviços financeiros internos. As RPCs existentes — nada mais.
 *  Nenhum SELECT solto: o dado financeiro continua derivado. */
export interface BillingGateway {
  /** `billing_register_manual_payment` */
  registerPayment(i: {
    chargeId: string; amountCents: number; method: string; paidAt: string;
    origin: "gateway" | "webhook" | "manual" | "conciliacao" | "importacao";
    provider: string; providerPaymentId?: string | null;
    providerTransactionId?: string | null; providerReference?: string | null;
    providerStatus?: string | null; providerMetadata?: Record<string, unknown>;
    pixTxid?: string | null; pixEndToEndId?: string | null; notes?: string | null;
  }): Promise<Result<{ paymentId: string; saldoCents: number; chargeStatus: string }>>;

  /** `billing_reverse_payment` */
  reversePayment(i: { providerPaymentId: string; reason?: string | null }): Promise<Result<{ reversalId: string }>>;

  /** `billing_update_payment_authorization` — PIX Recorrente, carteiras e
   *  cartão recorrente: autorização, revogação e expiração. */
  updateAuthorization(i: {
    authorizationId: string; status: "pendente" | "ativo" | "revogado" | "expirado" | "falhou";
    provider: string; providerMetadata?: Record<string, unknown>;
  }): Promise<Result<{ methodId: string }>>;

  /** Trilha do que NÃO vira operação financeira: recusa, expiração, ignorado,
   *  erro. Pagamento e estorno NÃO passam por aqui — as RPTs deles já gravam
   *  billing_events, e duas trilhas para o mesmo fato seria pior que nenhuma. */
  recordEvent(i: {
    event: string; entityType: string; entityId?: string | null;
    provider: string; metadata: Record<string, unknown>;
  }): Promise<Result<{ eventId: string }>>;

  /** Única leitura do fluxo, uma vez por webhook. Determinística: devolve
   *  `chargeId: null` em vez de adivinhar. */
  resolveCharge(i: { provider: string; providerPaymentId?: string | null;
                     providerTransactionId?: string | null; pixEndToEndId?: string | null;
                     pixTxid?: string | null; providerReference?: string | null;
                     chargeIdHint?: string | null }): Promise<Result<{ chargeId: string | null }>>;
}

/** Porta de log. Existe para que nenhum adaptador chame `console` direto — o
 *  que também torna verificável a regra de "segredo nunca aparece em log". */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export type { PaymentProvider, ProviderConfig, ProviderId, Environment,
              WebhookEvent, ProviderCharge, ProviderCustomer,
              ProviderRecurringAuthorization, WalletToken, PaymentStatus } from "./PaymentProvider";
