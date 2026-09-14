// Edge Function: billing-payment-webhook
// ---------------------------------------------------------------------------
// PONTE FINA. Recebe HTTP, identifica o provedor, carrega o segredo do Vault,
// entrega ao router, passa o comando ao PaymentService e devolve HTTP.
//
// ELA NÃO SABE O QUE É DINHEIRO. Nenhum SQL, nenhuma tabela, nenhum saldo,
// nenhuma decisão de pagamento ou estorno. Toda regra vive no PaymentService,
// e há teste estático que falha se `billing_payments`, `billing_charges`,
// `billing_events` ou qualquer SELECT/INSERT aparecerem aqui.
//
// RAW BODY: lido com `req.text()` UMA vez e repassado intacto. A assinatura é
// verificada sobre os bytes originalmente recebidos — nunca sobre um JSON
// reserializado, que mudaria espaços e ordem de chaves e invalidaria a
// assinatura de qualquer PSP sério.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";
import { SandboxProvider } from "../../../src/lib/payments/SandboxProvider.ts";
import { WebhookDedupe, routeWebhook, identificarProvider } from "../../../src/lib/payments/webhookRouter.ts";
import { PaymentService } from "../../../src/lib/payments/PaymentService.ts";
import { SupabaseBillingGateway } from "../../../src/lib/payments/SupabaseBillingGateway.ts";
import type { ProviderConfig, ProviderId } from "../../../src/lib/payments/PaymentProvider.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-provider, x-signature, x-payment-provider",
};
/** Corpo genérico SEMPRE: nunca revela detalhe interno, nome de tabela,
 *  mensagem de banco ou pista sobre o segredo. */
const resp = (status: number, code?: string) =>
  new Response(code ? JSON.stringify({ code }) : null,
    { status, headers: { ...cors, ...(code ? { "Content-Type": "application/json" } : {}) } });

/** Provedores habilitados. Um provedor fora desta lista é 404 — aceitar
 *  qualquer string permitiria escolher um verificador de assinatura mais fraco. */
const HABILITADOS: ProviderId[] = ["sandbox"];

/** Dedupe entre invocações da mesma instância. A barreira DEFINITIVA continua
 *  sendo os UNIQUE do banco (provider_payment_id, pix_end_to_end_id). */
const dedupe = new WebhookDedupe();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return resp(405, "method_not_allowed");

  try {
    // 1) RAW BODY — uma leitura, sem parse. Só isso preserva os bytes.
    const rawBody = await req.text();
    if (!rawBody) return resp(400, "empty_body");

    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });

    // 2) PROVEDOR
    const providerId = identificarProvider(headers);
    if (!providerId || !HABILITADOS.includes(providerId)) return resp(404, "unknown_provider");

    // 3) SEGREDO — só do ambiente/Vault. Nunca hardcoded, nunca em log,
    //    nunca em resposta. Ausência é falha de configuração, não do chamador.
    const segredo = Deno.env.get(`BILLING_WEBHOOK_SECRET_${providerId.toUpperCase()}`) ?? "";
    if (!segredo) return resp(503, "provider_unconfigured");

    const cfg: ProviderConfig = {
      provider: providerId, environment:
        (Deno.env.get("BILLING_ENVIRONMENT") as ProviderConfig["environment"]) ?? "production",
      credentials: { webhookSecret: segredo }, timeoutMs: 10_000,
    };
    const provider = new SandboxProvider(cfg);

    // 4-5) ROUTER: assinatura → normalização → dedupe → comando.
    const rota = await routeWebhook(provider, dedupe, { rawBody, headers });
    if (rota.ok !== true) {
      const c = rota.error.code;
      if (c === "assinatura_ausente" || c === "assinatura_invalida") return resp(401, "unauthorized");
      if (c === "corpo_invalido" || c === "webhook_sem_event_id"
          || c === "webhook_sem_pagamento") return resp(400, "invalid_payload");
      return resp(400, "invalid_payload");
    }

    // 6-7) SERVIÇO: única porta para as RPCs.
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } });
    const servico = new PaymentService(new SupabaseBillingGateway(sb, 10_000));
    const r = await servico.process(rota.value);

    // 8) HTTP
    if (r.ok !== true) {
      // Timeout e indisponibilidade são RETENTÁVEIS: 503 faz o PSP reenviar.
      const retryable = /timeout|network|unavailable|08006/i.test(r.error.message);
      return resp(retryable ? 503 : 500, retryable ? "temporarily_unavailable" : "processing_error");
    }
    // Duplicata conhecida NUNCA é 500: 204 diz "recebi e não há nada a fazer".
    if (!r.value.applied) return resp(204);
    return resp(200, "processed");
  } catch {
    // Nada escapa. Detalhe interno jamais vai para a resposta.
    return resp(500, "processing_error");
  }
});
