-- ============================================================================
-- SPRINT 6 — RESOLUÇÃO DETERMINÍSTICA DE COBRANÇA A PARTIR DO PROVEDOR
-- ----------------------------------------------------------------------------
-- Por que é a MENOR RPC possível: o PaymentService precisa de UMA coisa do
-- banco antes de registrar pagamento — qual cobrança este evento paga. Tudo o
-- mais já existe (`billing_register_manual_payment`, `billing_reverse_payment`).
--
-- ONDE O VÍNCULO VIVE: em `billing_payments`. Quando uma cobrança é enviada ao
-- gateway (Sprint 7), nasce a linha com `provider_payment_id`/`pix_txid`; o
-- webhook depois a encontra por ali. Não inventei coluna nova em
-- `billing_charges` — seria alterar a fundação para guardar o que a Sprint 3 já
-- modelou.
--
-- DETERMINÍSTICO, NUNCA ADIVINHA:
--   • só identificadores FORTES; nome de cliente, valor e data nunca entram;
--   • sem fuzzy matching;
--   • mais de uma cobrança candidata → 'ambiguous', jamais escolha arbitrária;
--   • nenhum identificador → 'not_found'.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.billing_resolve_charge(
  _provider                text,
  _provider_payment_id     text DEFAULT NULL,
  _provider_transaction_id text DEFAULT NULL,
  _pix_end_to_end_id       text DEFAULT NULL,
  _pix_txid                text DEFAULT NULL,
  _provider_reference      text DEFAULT NULL,
  -- Dica vinda do metadata do provedor. Só é aceita se a cobrança EXISTIR:
  -- confiar cegamente permitiria direcionar pagamento para qualquer cobrança.
  _charge_id_hint          uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids uuid[]; v_n int;
BEGIN
  IF NOT public.can_read_billing(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF COALESCE(_provider_payment_id, _provider_transaction_id, _pix_end_to_end_id,
              _pix_txid, _provider_reference, _charge_id_hint::text) IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found', 'reason', 'sem_identificador');
  END IF;

  SELECT array_agg(DISTINCT p.charge_id) INTO v_ids
    FROM public.billing_payments p
   WHERE p.provider IS NOT DISTINCT FROM _provider
     AND (
          (_provider_payment_id     IS NOT NULL AND p.provider_payment_id     = _provider_payment_id)
       OR (_provider_transaction_id IS NOT NULL AND p.provider_transaction_id = _provider_transaction_id)
       OR (_pix_end_to_end_id       IS NOT NULL AND p.pix_end_to_end_id       = _pix_end_to_end_id)
       OR (_pix_txid                IS NOT NULL AND p.pix_txid                = _pix_txid)
       OR (_provider_reference      IS NOT NULL AND p.provider_reference      = _provider_reference)
     );

  v_n := COALESCE(array_length(v_ids, 1), 0);
  IF v_n = 1 THEN
    RETURN jsonb_build_object('status', 'found', 'charge_id', v_ids[1], 'matched_by', 'provider_identifier');
  END IF;
  IF v_n > 1 THEN
    -- Dois identificadores apontando para cobranças diferentes é inconsistência
    -- de dados. Escolher uma seria creditar pagamento na cobrança errada.
    RETURN jsonb_build_object('status', 'ambiguous', 'candidates', v_n);
  END IF;

  IF _charge_id_hint IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.billing_charges WHERE id = _charge_id_hint) THEN
    RETURN jsonb_build_object('status', 'found', 'charge_id', _charge_id_hint, 'matched_by', 'metadata_hint');
  END IF;

  RETURN jsonb_build_object('status', 'not_found', 'reason', 'sem_correspondencia');
END $$;

COMMENT ON FUNCTION public.billing_resolve_charge IS
  'Resolve a cobrança de um evento de gateway por identificador FORTE. Determinística: não adivinha, devolve ambiguous ou not_found.';

REVOKE ALL ON FUNCTION public.billing_resolve_charge(text,text,text,text,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_resolve_charge(text,text,text,text,text,text,uuid)
  TO authenticated, service_role;
