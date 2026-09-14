// ─────────────────────────────────────────────────────────────────────────────
// PaymentService — o ÚNICO ponto que transforma evento de gateway em operação
// financeira. É ele, e só ele, que chama as RPCs.
// ─────────────────────────────────────────────────────────────────────────────
// O webhookRouter não conhece banco, tabela nem billing. Ele entrega um
// WebhookCommand normalizado; aqui ficam validação, regra, idempotência,
// tratamento de erro e a chamada das RPCs existentes.
//
// A porta `BillingGateway` é injetada: o serviço não importa Supabase. Isso é o
// que permite testar TODA a regra sem banco — e o que impede alguém, amanhã,
// de acrescentar uma consulta solta no meio do fluxo.
import { fail, ok, type Result } from "./types";
import type { WebhookCommand } from "./webhookRouter";
import type { WebhookEvent } from "./PaymentProvider";
import type { BillingGateway } from "./ports";

export type { BillingGateway } from "./ports";   // reexport: chamadores antigos seguem válidos

export interface ProcessOutcome {
  action: WebhookCommand["action"];
  applied: boolean;
  /** Motivo, quando nada foi aplicado. Sempre preenchido se `applied=false`. */
  reason?: string;
  paymentId?: string;
  reversalId?: string;
  chargeId?: string;
  saldoCents?: number;
  chargeStatus?: string;
}

/** Método do gateway → enum `billing_payment_method` da fundação. */
export function mapMethod(e: WebhookEvent): string {
  const t = String(e.type ?? "").toLowerCase();
  const raw = String((e.raw?.method ?? e.raw?.payment_method ?? "")).toLowerCase();
  const alvo = raw || t;
  if (alvo.includes("pix_automatico") || alvo.includes("recurring")) return "pix_automatico";
  if (alvo.includes("pix")) return "pix";
  if (alvo.includes("apple")) return "apple_pay";
  if (alvo.includes("google")) return "google_pay";
  if (alvo.includes("debit")) return "cartao_debito";
  if (alvo.includes("card") || alvo.includes("credit")) return "cartao_credito";
  if (alvo.includes("boleto")) return "boleto";
  if (alvo.includes("transfer")) return "transferencia";
  return "outro";
}

export class PaymentService {
  constructor(private readonly billing: BillingGateway) {}

  /**
   * Processa UM comando. Nunca lança: falha de gateway ou de banco vira
   * `Result` com motivo, e a trilha registra. Auditoria e cobrança não podem
   * derrubar-se mutuamente.
   */
  async process(cmd: WebhookCommand): Promise<Result<ProcessOutcome>> {
    const e = cmd.event;
    const provider = String(e.provider);

    try {
      switch (cmd.action) {
        case "ignore":
          // Duplicado ou status desconhecido. Registra e para — nunca aplica.
          await this.billing.recordEvent({ event: "webhook_ignored", entityType: "billing_payments",
            provider, metadata: { dedupeKey: cmd.dedupeKey, reason: cmd.reason ?? null, type: e.type } });
          return ok({ action: cmd.action, applied: false, reason: cmd.reason ?? "ignorado" });

        case "register_payment": {
          if (!e.amountCents || e.amountCents <= 0) {
            return this.erro(cmd, "valor_invalido", provider);
          }
          const alvo = await this.billing.resolveCharge({ provider,
            providerPaymentId: e.providerPaymentId, providerTransactionId: e.providerTransactionId,
            pixEndToEndId: e.pixEndToEndId });
          if (alvo.ok !== true) return this.erro(cmd, `resolve_falhou:${alvo.error.code}`, provider);
          if (!alvo.value.chargeId) return this.erro(cmd, "cobranca_nao_encontrada", provider);

          const r = await this.billing.registerPayment({
            chargeId: alvo.value.chargeId, amountCents: e.amountCents, method: mapMethod(e),
            paidAt: e.occurredAt ?? new Date().toISOString(), origin: "webhook", provider,
            providerPaymentId: e.providerPaymentId, providerTransactionId: e.providerTransactionId,
            providerReference: null, providerStatus: String(e.raw?.status ?? ""),
            providerMetadata: e.raw, pixEndToEndId: e.pixEndToEndId,
            pixTxid: e.raw?.txid ? String(e.raw.txid) : null,
            notes: `webhook ${e.eventId}`,
          });
          if (r.ok !== true) {
            // IDEMPOTÊNCIA DEFINITIVA: o UNIQUE do banco (provider_payment_id /
            // pix_end_to_end_id) rejeita o reprocessamento. Isso NÃO é erro —
            // é a barreira funcionando. Reportar como falha geraria alarme falso.
            if (/duplicate|unique|23505/i.test(r.error.message) || r.error.code === "duplicado") {
              await this.billing.recordEvent({ event: "webhook_duplicate_blocked",
                entityType: "billing_payments", provider,
                metadata: { dedupeKey: cmd.dedupeKey, providerPaymentId: e.providerPaymentId } });
              return ok({ action: cmd.action, applied: false, reason: "ja_registrado",
                          chargeId: alvo.value.chargeId });
            }
            return this.erro(cmd, `registro_falhou:${r.error.code}`, provider);
          }
          return ok({ action: cmd.action, applied: true, paymentId: r.value.paymentId,
            chargeId: alvo.value.chargeId, saldoCents: r.value.saldoCents,
            chargeStatus: r.value.chargeStatus });
        }

        case "register_refund": {
          if (!e.providerPaymentId) return this.erro(cmd, "estorno_sem_pagamento", provider);
          const r = await this.billing.reversePayment({
            providerPaymentId: e.providerPaymentId, reason: `webhook ${e.eventId}` });
          if (r.ok !== true) {
            if (/already_reversed/i.test(r.error.code) || /already_reversed/i.test(r.error.message)) {
              return ok({ action: cmd.action, applied: false, reason: "ja_estornado" });
            }
            return this.erro(cmd, `estorno_falhou:${r.error.code}`, provider);
          }
          return ok({ action: cmd.action, applied: true, reversalId: r.value.reversalId });
        }

        case "update_authorization": {
          if (!e.authorizationId) return this.erro(cmd, "autorizacao_ausente", provider);
          const st = e.status === "autorizado" ? "ativo" as const
                   : e.status === "expirado"  ? "expirado" as const
                   : e.status === "falhou"    ? "falhou" as const
                   : "pendente" as const;
          const r = await this.billing.updateAuthorization({
            authorizationId: e.authorizationId, status: st, provider, providerMetadata: e.raw });
          if (r.ok !== true) return this.erro(cmd, `autorizacao_falhou:${r.error.code}`, provider);
          return ok({ action: cmd.action, applied: true });
        }

        case "mark_failed": case "mark_cancelled": case "mark_expired": {
          // NÃO alteram dinheiro. Só trilha — o saldo continua derivado dos
          // pagamentos, e uma cobrança recusada simplesmente não tem pagamento.
          const evento = cmd.action === "mark_failed" ? "payment_failed"
                       : cmd.action === "mark_cancelled" ? "payment_cancelled" : "payment_expired";
          await this.billing.recordEvent({ event: evento, entityType: "billing_payments",
            provider, metadata: { providerPaymentId: e.providerPaymentId, eventId: e.eventId,
                                  status: e.status, dedupeKey: cmd.dedupeKey } });
          return ok({ action: cmd.action, applied: true });
        }

        case "register_error":
          return this.erro(cmd, cmd.reason ?? "erro_reportado", provider);
      }
    } catch (ex) {
      // Nunca propaga: exceção inesperada vira erro registrado.
      return this.erro(cmd, `excecao:${ex instanceof Error ? ex.message : String(ex)}`, provider);
    }
  }

  private async erro(cmd: WebhookCommand, motivo: string, provider: string): Promise<Result<ProcessOutcome>> {
    try {
      await this.billing.recordEvent({ event: "webhook_error", entityType: "billing_payments",
        provider, metadata: { dedupeKey: cmd.dedupeKey, reason: motivo, eventId: cmd.event.eventId } });
    } catch { /* trilha é best-effort; o erro abaixo é o que importa */ }
    return fail("webhook_processing_failed", motivo, false);
  }
}
