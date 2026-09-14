// ─────────────────────────────────────────────────────────────────────────────
// SupabaseBillingGateway — implementação concreta de BillingGateway.
// ─────────────────────────────────────────────────────────────────────────────
// ADAPTADOR PURO: traduz a porta em chamadas de RPC e nada mais. NENHUMA regra
// de negócio vive aqui — nada de decidir saldo, status, estorno ou o que é
// duplicata. Tudo isso é do PaymentService, e há teste que falha se aparecer.
//
// TRILHA ÚNICA: `billing_register_manual_payment` e `billing_reverse_payment`
// JÁ gravam billing_events (full_payment/partial_payment/manual_payment/
// refund_created). Este adaptador NÃO grava outro evento para o mesmo fato —
// `recordEvent` só existe para o que NÃO vira operação: recusa, expiração,
// ignorado e erro. Um fato financeiro, uma trilha.
import type { BillingGateway } from "./ports";
import { fail, ok, withTimeout, type Result } from "./types";

/** Cliente mínimo. Injetado para que o adaptador não importe o singleton — é o
 *  que permite testá-lo sem rede e sem banco. */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>):
    Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
}

const TIMEOUT_PADRAO_MS = 10_000;

export class SupabaseBillingGateway implements BillingGateway {
  constructor(private readonly client: RpcClient,
              private readonly timeoutMs: number = TIMEOUT_PADRAO_MS) {}

  /** Toda chamada passa por aqui: timeout controlado e erro tipado. O banco
   *  lento nunca prende a Edge Function indefinidamente. */
  private async call<T>(fn: string, args: Record<string, unknown>): Promise<Result<T>> {
    const r = await withTimeout(this.client.rpc(fn, args), this.timeoutMs, fn);
    if (r.ok !== true) return r;                       // timeout/rede: retryable
    const { data, error } = r.value;
    if (error) {
      const msg = String(error.message ?? "");
      // Violação de UNIQUE é sinalizada, não interpretada: quem decide o que
      // fazer com duplicata é o PaymentService.
      const dup = /duplicate key|unique constraint|23505/i.test(msg);
      return fail(dup ? "duplicado" : (error.code ?? "rpc_error"), msg, !dup);
    }
    return ok(data as T);
  }

  async resolveCharge(i: { provider: string; providerPaymentId?: string | null;
                           providerTransactionId?: string | null; pixEndToEndId?: string | null;
                           pixTxid?: string | null; providerReference?: string | null;
                           chargeIdHint?: string | null }) {
    const r = await this.call<{ status: string; charge_id?: string; candidates?: number }>(
      "billing_resolve_charge", {
        _provider: i.provider,
        _provider_payment_id: i.providerPaymentId ?? null,
        _provider_transaction_id: i.providerTransactionId ?? null,
        _pix_end_to_end_id: i.pixEndToEndId ?? null,
        _pix_txid: i.pixTxid ?? null,
        _provider_reference: i.providerReference ?? null,
        _charge_id_hint: i.chargeIdHint ?? null,
      });
    if (r.ok !== true) return r;
    // Ambíguo NÃO vira escolha: o adaptador reporta e o serviço decide parar.
    if (r.value?.status === "ambiguous") {
      return fail("ambiguous_charge", `resolução ambígua (${r.value.candidates ?? "?"} candidatas)`, false);
    }
    return ok({ chargeId: r.value?.status === "found" ? (r.value.charge_id ?? null) : null });
  }

  async registerPayment(i: Parameters<BillingGateway["registerPayment"]>[0]) {
    const r = await this.call<{ ok?: boolean; error?: string; payment_id?: string;
                                saldo_cents?: number; charge_status?: string }>(
      "billing_register_manual_payment", {
        _charge_id: i.chargeId, _amount_cents: i.amountCents,
        _method: i.method, _paid_at: i.paidAt, _notes: i.notes ?? null,
      });
    if (r.ok !== true) return r;
    if (r.value?.ok !== true) return fail(String(r.value?.error ?? "rpc_recusou"), String(r.value?.error ?? ""), false);
    return ok({ paymentId: String(r.value.payment_id), saldoCents: Number(r.value.saldo_cents ?? 0),
                chargeStatus: String(r.value.charge_status ?? "") });
  }

  async reversePayment(i: { providerPaymentId: string; reason?: string | null }) {
    const r = await this.call<{ ok?: boolean; error?: string; reversal_id?: string }>(
      "billing_reverse_payment", { _payment_id: i.providerPaymentId, _reason: i.reason ?? null });
    if (r.ok !== true) return r;
    if (r.value?.ok !== true) return fail(String(r.value?.error ?? "rpc_recusou"), String(r.value?.error ?? ""), false);
    return ok({ reversalId: String(r.value.reversal_id) });
  }

  async updateAuthorization(i: Parameters<BillingGateway["updateAuthorization"]>[0]) {
    const r = await this.call<{ method_id?: string }>("billing_update_payment_authorization", {
      _authorization_id: i.authorizationId, _status: i.status, _provider: i.provider,
      _metadata: i.providerMetadata ?? {},
    });
    if (r.ok !== true) return r;
    return ok({ methodId: String(r.value?.method_id ?? "") });
  }

  async recordEvent(i: Parameters<BillingGateway["recordEvent"]>[0]) {
    const r = await this.call<{ event_id?: string }>("billing_record_event", {
      _event: i.event, _entity_type: i.entityType, _entity_id: i.entityId ?? null,
      _provider: i.provider, _metadata: i.metadata,
    });
    if (r.ok !== true) return r;
    return ok({ eventId: String(r.value?.event_id ?? "") });
  }
}
