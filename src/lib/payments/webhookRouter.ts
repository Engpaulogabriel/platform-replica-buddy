// Roteador único de webhook. TODO webhook entra por aqui.
// ---------------------------------------------------------------------------
// ORDEM É A SEGURANÇA: identificar provedor → validar ASSINATURA → normalizar
// → deduplicar → só então mandar ao serviço interno. Nada é processado antes de
// a assinatura passar; sem isso, qualquer um forja um pagamento aprovado.
//
// NUNCA acessa tabela. Devolve um comando normalizado; quem persiste é o
// serviço interno (RPCs da Sprint 3), que já sabe registrar billing_events.
import { fail, ok, type Result } from "./types";
import type { PaymentProvider, ProviderId, WebhookEvent } from "./PaymentProvider";

/** Ação que o serviço interno deve executar. O roteador não a executa. */
export interface WebhookCommand {
  action: "register_payment" | "register_refund" | "mark_failed" | "mark_cancelled"
        | "mark_expired" | "update_authorization" | "ignore" | "register_error";
  event: WebhookEvent;
  /** Chave de dedupe: `<provider>:<eventId>`. */
  dedupeKey: string;
  reason?: string;
}

/** Já processados. Em produção o "já vi" definitivo são os UNIQUE que a
 *  Sprint 3 criou (`provider_payment_id`, `pix_end_to_end_id`) — este cache é
 *  só a primeira barreira, que evita trabalho repetido. */
export class WebhookDedupe {
  private vistos = new Map<string, number>();
  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}
  jaProcessado(k: string, agora: number): boolean {
    const t = this.vistos.get(k);
    if (t === undefined) return false;
    if (agora - t > this.ttlMs) { this.vistos.delete(k); return false; }
    return true;
  }
  marcar(k: string, agora: number): void { this.vistos.set(k, agora); }
  get tamanho(): number { return this.vistos.size; }
}

/** Mapeia o status normalizado para a ação interna. Sem `default` silencioso:
 *  status desconhecido vira `ignore` com motivo, nunca "aprovado" por engano. */
export function acaoPara(e: WebhookEvent): WebhookCommand["action"] {
  switch (e.status) {
    case "quitado": case "capturado": return "register_payment";
    case "parcial": return "register_payment";
    case "estornado": return "register_refund";
    case "falhou": return "mark_failed";
    case "cancelado": return "mark_cancelled";
    case "expirado": return "mark_expired";
    case "autorizado": case "pendente": return "update_authorization";
    default: return "ignore";
  }
}

export async function routeWebhook(
  provider: PaymentProvider, dedupe: WebhookDedupe,
  i: { rawBody: string; headers: Record<string, string> }, agora = Date.now(),
): Promise<Result<WebhookCommand>> {
  // 1) ASSINATURA — antes de qualquer interpretação do corpo.
  const parsed = await provider.receiveWebhook(i);
  if (parsed.ok !== true) return { ok: false, error: parsed.error };
  const e = parsed.value;

  if (!e.eventId) return fail("webhook_sem_event_id", "Evento sem identificador", false);
  const dedupeKey = `${e.provider}:${e.eventId}`;

  // 2) DEDUPE — reprocessar não pode gerar segundo pagamento.
  if (dedupe.jaProcessado(dedupeKey, agora)) {
    return ok({ action: "ignore", event: e, dedupeKey, reason: "webhook_duplicado" });
  }
  dedupe.marcar(dedupeKey, agora);

  const action = acaoPara(e);
  if (action === "register_payment" && !e.providerPaymentId) {
    return fail("webhook_sem_pagamento", "Pagamento aprovado sem providerPaymentId", false);
  }
  return ok({ action, event: e, dedupeKey });
}

/** Provedores conhecidos, para o roteador identificar a origem pelo header. */
export function identificarProvider(headers: Record<string, string>): ProviderId | null {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const v = h["x-provider"] ?? h["x-payment-provider"] ?? "";
  const conhecidos: ProviderId[] = ["banco_do_brasil","bradesco","sicredi","mercado_pago",
    "pagseguro","asaas","stripe","pagarme","stone","pagbank","sandbox"];
  return (conhecidos as string[]).includes(v) ? (v as ProviderId) : null;
}
