-- ============================================================================
-- SPRINT 6 — ATUALIZAÇÃO DE AUTORIZAÇÃO DE PAGAMENTO
-- ----------------------------------------------------------------------------
-- Única responsabilidade: refletir em `billing_payment_methods` o que o
-- provedor informou sobre uma autorização — PIX Recorrente, carteiras e cartão
-- recorrente. Autorizar, revogar, expirar.
--
-- NENHUMA regra financeira, nenhum cálculo, nenhuma decisão. Quem decide é o
-- PaymentService; esta função só grava o estado que ele mandou.
--
-- NÃO grava billing_events: a trilha financeira continua exclusiva das RPCs
-- existentes. Não há caminho paralelo.
--
-- ISOLAMENTO: só billing_*. Nenhuma tabela operacional.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.billing_update_payment_authorization(
  _authorization_id text,
  _status           public.billing_method_status,
  _provider         text,
  _provider_status  text DEFAULT NULL,
  _authorized_at    timestamptz DEFAULT NULL,
  _expires_at       timestamptz DEFAULT NULL,
  _revoked_at       timestamptz DEFAULT NULL,
  _metadata         jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.can_write_billing(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF _authorization_id IS NULL OR btrim(_authorization_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'authorization_id_ausente');
  END IF;

  -- `revoked_at` é obrigatório quando o status é 'revogado' — o CHECK
  -- `billing_pm_revoked_has_date` da Sprint 3 exige. Preencher com now() aqui
  -- evita que o chamador esbarre numa constraint por esquecimento.
  UPDATE public.billing_payment_methods
     SET status        = _status,
         provider      = COALESCE(_provider, provider),
         authorized_at = COALESCE(_authorized_at, authorized_at),
         expires_at    = COALESCE(_expires_at, expires_at),
         revoked_at    = CASE WHEN _status = 'revogado'
                              THEN COALESCE(_revoked_at, revoked_at, now())
                              ELSE _revoked_at END,
         metadata      = metadata || COALESCE(_metadata, '{}'::jsonb)
                                  || jsonb_build_object('provider_status', _provider_status)
   WHERE authorization_id = btrim(_authorization_id)
   RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'authorization_not_found');
  END IF;
  RETURN jsonb_build_object('ok', true, 'method_id', v_id);
END $$;

COMMENT ON FUNCTION public.billing_update_payment_authorization IS
  'Atualiza a autorização em billing_payment_methods. Sem regra financeira e sem trilha própria.';

REVOKE ALL ON FUNCTION public.billing_update_payment_authorization(
  text, public.billing_method_status, text, text, timestamptz, timestamptz, timestamptz, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_update_payment_authorization(
  text, public.billing_method_status, text, text, timestamptz, timestamptz, timestamptz, jsonb)
  TO authenticated, service_role;
