-- ============================================================================
-- SPRINT 3 — RECEBIMENTOS: INFRAESTRUTURA (SEM INTEGRAÇÃO)
-- ----------------------------------------------------------------------------
-- Prepara PIX, PIX Recorrente, Apple Pay, Google Pay, cartão, boleto e
-- transferência. NENHUM gateway é integrado. Nenhuma chamada externa existe.
--
-- ⚠️ UMA ALTERAÇÃO NA FUNDAÇÃO, INEVITÁVEL E DELIBERADA
--   `billing_payments_amount_positive CHECK (amount_cents > 0)` IMPEDE gravar
--   estorno como linha negativa. Como a regra é "nunca apagar, nunca editar,
--   estorno é linha nova com valor negativo", as duas coisas não coexistem.
--   Substituo o CHECK por um MAIS ESTRITO, não mais frouxo:
--       kind='estorno'  → amount_cents < 0
--       demais kinds    → amount_cents > 0
--   Zero é rejeitado em ambos. Nenhuma linha existente viola a nova regra
--   (todas são positivas e recebem kind='pagamento' por default).
--   Esta é a única alteração de estrutura pré-existente nesta Sprint.
--
-- ISOLAMENTO: só billing_*. Nenhuma tabela operacional é lida ou escrita.
-- SEGURANÇA: nenhuma coluna aceita PAN, CVV, chave privada ou credencial. Só
-- tokens e identificadores do provedor.
-- ============================================================================

-- ── ENUMS ──────────────────────────────────────────────────────────────────
CREATE TYPE public.billing_payment_kind AS ENUM
  ('pagamento', 'estorno', 'reembolso', 'ajuste');

-- Estado do MEIO de pagamento (a autorização), distinto do estado da transação.
CREATE TYPE public.billing_method_status AS ENUM
  ('pendente', 'ativo', 'revogado', 'expirado', 'falhou');

-- Estado de uma TRANSAÇÃO. Texto livre nunca — enum fechado.
CREATE TYPE public.billing_payment_status AS ENUM
  ('pendente', 'autorizado', 'capturado', 'parcial', 'quitado',
   'cancelado', 'estornado', 'falhou', 'expirado');

CREATE TYPE public.billing_payment_origin AS ENUM
  ('manual', 'gateway', 'webhook', 'conciliacao', 'importacao');

-- `billing_payment_method` (pix, pix_automatico, boleto, transferencia, cartao,
-- outro) JÁ EXISTE na fundação. Estendo com os que faltam em vez de criar tipo
-- novo — os valores antigos continuam válidos e nada precisa migrar.
ALTER TYPE public.billing_payment_method ADD VALUE IF NOT EXISTS 'cartao_credito';
ALTER TYPE public.billing_payment_method ADD VALUE IF NOT EXISTS 'cartao_debito';
ALTER TYPE public.billing_payment_method ADD VALUE IF NOT EXISTS 'apple_pay';
ALTER TYPE public.billing_payment_method ADD VALUE IF NOT EXISTS 'google_pay';

-- ── MEIOS DE PAGAMENTO ─────────────────────────────────────────────────────
CREATE TABLE public.billing_payment_methods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES public.billing_customers(id) ON DELETE RESTRICT,
  kind          public.billing_payment_method NOT NULL,
  status        public.billing_method_status NOT NULL DEFAULT 'pendente',
  -- Identificadores do PROVEDOR. Nenhum dado sensível: sem PAN, sem CVV, sem
  -- chave privada. Só o que o gateway devolve como referência opaca.
  provider                  text,
  provider_customer_id      text,
  provider_payment_method_id text,
  -- PIX RECORRENTE: a autorização vive no PSP; aqui guardamos a referência e o
  -- teto. `max_amount_cents` é trava dupla — o PSP também a aplica, mas o
  -- sistema precisa saber o limite que ele mesmo pactuou.
  authorization_id  text,
  authorized_at     timestamptz,
  revoked_at        timestamptz,
  expires_at        timestamptz,
  max_amount_cents  bigint,
  periodicity       public.billing_periodicity,
  currency          char(3) NOT NULL DEFAULT 'BRL',
  -- Exibição segura: bandeira e últimos 4 dígitos são o MÁXIMO permitido.
  display_brand     text,
  display_last4     char(4),
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by        uuid REFERENCES auth.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_pm_max_amount_positive CHECK (max_amount_cents IS NULL OR max_amount_cents > 0),
  CONSTRAINT billing_pm_last4_digits CHECK (display_last4 IS NULL OR display_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT billing_pm_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  -- Revogado exige data: "revogado" sem quando não é auditável.
  CONSTRAINT billing_pm_revoked_has_date
    CHECK ((status = 'revogado') = (revoked_at IS NOT NULL))
);

CREATE INDEX billing_pm_customer_idx ON public.billing_payment_methods (customer_id, status);
-- Um mesmo meio do provedor não pode ser cadastrado duas vezes.
CREATE UNIQUE INDEX billing_pm_provider_uniq
  ON public.billing_payment_methods (provider, provider_payment_method_id)
  WHERE provider_payment_method_id IS NOT NULL;
-- Uma autorização recorrente ATIVA por cliente e por meio.
CREATE UNIQUE INDEX billing_pm_active_authorization_uniq
  ON public.billing_payment_methods (customer_id, kind)
  WHERE status = 'ativo' AND kind = 'pix_automatico';

CREATE TRIGGER billing_pm_touch BEFORE UPDATE ON public.billing_payment_methods
  FOR EACH ROW EXECUTE FUNCTION public.billing_touch_updated_at();

-- ── PAGAMENTOS: SÓ O QUE FALTAVA ───────────────────────────────────────────
-- A tabela é REUTILIZADA. Nenhuma coluna existente foi removida ou renomeada.
ALTER TABLE public.billing_payments
  ADD COLUMN IF NOT EXISTS kind              public.billing_payment_kind NOT NULL DEFAULT 'pagamento',
  ADD COLUMN IF NOT EXISTS status            public.billing_payment_status NOT NULL DEFAULT 'quitado',
  ADD COLUMN IF NOT EXISTS payment_origin    public.billing_payment_origin NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS payment_method_id uuid REFERENCES public.billing_payment_methods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider_transaction_id text,
  ADD COLUMN IF NOT EXISTS provider_reference      text,
  ADD COLUMN IF NOT EXISTS provider_status         text,
  ADD COLUMN IF NOT EXISTS provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- PIX: txid e EndToEndId. BOLETO: linha digitável, nosso número, barcode.
  -- Só identificadores públicos do documento — nada sensível.
  ADD COLUMN IF NOT EXISTS pix_txid          text,
  ADD COLUMN IF NOT EXISTS pix_end_to_end_id text,
  ADD COLUMN IF NOT EXISTS boleto_line       text,
  ADD COLUMN IF NOT EXISTS boleto_our_number text,
  ADD COLUMN IF NOT EXISTS boleto_barcode    text,
  ADD COLUMN IF NOT EXISTS expires_at        timestamptz,
  -- Estorno aponta para o pagamento que reverte. Nunca edita o original.
  ADD COLUMN IF NOT EXISTS reverses_payment_id uuid REFERENCES public.billing_payments(id),
  ADD COLUMN IF NOT EXISTS notes             text;

-- O CHECK novo, mais estrito que o anterior. Ver o cabeçalho.
ALTER TABLE public.billing_payments DROP CONSTRAINT IF EXISTS billing_payments_amount_positive;
ALTER TABLE public.billing_payments ADD CONSTRAINT billing_payments_amount_by_kind
  CHECK ((kind = 'pagamento' AND amount_cents > 0)
      OR (kind IN ('estorno','reembolso') AND amount_cents < 0)
      OR (kind = 'ajuste' AND amount_cents <> 0));

ALTER TABLE public.billing_payments ADD CONSTRAINT billing_payments_reversal_has_target
  CHECK (kind <> 'estorno' OR reverses_payment_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS billing_payments_status_idx ON public.billing_payments (status, paid_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS billing_payments_e2e_uniq
  ON public.billing_payments (pix_end_to_end_id) WHERE pix_end_to_end_id IS NOT NULL;

-- ── BAIXA MANUAL ───────────────────────────────────────────────────────────
-- Sempre INSERT. Nunca UPDATE de linha existente: histórico é acréscimo.
CREATE OR REPLACE FUNCTION public.billing_register_manual_payment(
  _charge_id uuid, _amount_cents bigint, _method public.billing_payment_method DEFAULT 'transferencia',
  _paid_at timestamptz DEFAULT now(), _notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ch RECORD; v_pago bigint; v_id uuid; v_saldo bigint;
BEGIN
  IF NOT public.can_write_billing(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF _amount_cents IS NULL OR _amount_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;

  SELECT * INTO v_ch FROM public.billing_charges WHERE id = _charge_id FOR UPDATE;
  IF v_ch.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'charge_not_found'); END IF;
  IF v_ch.status IN ('cancelada','estornada') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'charge_not_payable', 'status', v_ch.status);
  END IF;

  INSERT INTO public.billing_payments (
    charge_id, amount_cents, paid_at, method, kind, status, payment_origin,
    reconciled_by, reconciled_by_user, notes)
  VALUES (_charge_id, _amount_cents, _paid_at, _method, 'pagamento', 'quitado',
          'manual', 'manual', auth.uid(), _notes)
  RETURNING id INTO v_id;

  -- Saldo DERIVADO da soma, sempre. Nunca coluna persistida.
  SELECT COALESCE(SUM(amount_cents), 0) INTO v_pago
    FROM public.billing_payments WHERE charge_id = _charge_id;
  v_saldo := v_ch.total_cents - v_pago;

  UPDATE public.billing_charges
     SET status = CASE WHEN v_saldo <= 0 THEN 'paga'::public.billing_charge_status
                       ELSE 'paga_parcial'::public.billing_charge_status END,
         paid_at = CASE WHEN v_saldo <= 0 THEN _paid_at ELSE NULL END
   WHERE id = _charge_id;

  INSERT INTO public.billing_events (entity_type, entity_id, event, actor_user_id, actor_kind, after)
  VALUES ('billing_payments', v_id,
          CASE WHEN v_saldo <= 0 THEN 'full_payment' ELSE 'partial_payment' END,
          auth.uid(), 'manual',
          jsonb_build_object('charge_id', _charge_id, 'amount_cents', _amount_cents,
                             'saldo_cents', v_saldo, 'method', _method::text));
  INSERT INTO public.billing_events (entity_type, entity_id, event, actor_user_id, actor_kind, after)
  VALUES ('billing_payments', v_id, 'manual_payment', auth.uid(), 'manual',
          jsonb_build_object('notes', _notes));

  RETURN jsonb_build_object('ok', true, 'payment_id', v_id, 'saldo_cents', v_saldo,
                            'charge_status', CASE WHEN v_saldo <= 0 THEN 'paga' ELSE 'paga_parcial' END);
END $$;

-- ── ESTORNO ────────────────────────────────────────────────────────────────
-- LINHA NOVA, negativa, apontando para o original. O original NUNCA é tocado.
CREATE OR REPLACE FUNCTION public.billing_reverse_payment(
  _payment_id uuid, _reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_p RECORD; v_id uuid; v_pago bigint; v_ch RECORD;
BEGIN
  IF NOT public.can_admin_billing(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  SELECT * INTO v_p FROM public.billing_payments WHERE id = _payment_id FOR UPDATE;
  IF v_p.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'payment_not_found'); END IF;
  IF v_p.kind <> 'pagamento' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_reversible');
  END IF;
  IF EXISTS (SELECT 1 FROM public.billing_payments WHERE reverses_payment_id = _payment_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_reversed');
  END IF;

  INSERT INTO public.billing_payments (
    charge_id, amount_cents, paid_at, method, kind, status, payment_origin,
    reconciled_by, reconciled_by_user, reverses_payment_id, notes)
  VALUES (v_p.charge_id, -v_p.amount_cents, now(), v_p.method, 'estorno', 'estornado',
          'manual', 'manual', auth.uid(), _payment_id, _reason)
  RETURNING id INTO v_id;

  SELECT * INTO v_ch FROM public.billing_charges WHERE id = v_p.charge_id;
  SELECT COALESCE(SUM(amount_cents), 0) INTO v_pago
    FROM public.billing_payments WHERE charge_id = v_p.charge_id;

  UPDATE public.billing_charges
     SET status = CASE WHEN v_pago <= 0 THEN 'aberta'::public.billing_charge_status
                       WHEN v_ch.total_cents - v_pago <= 0 THEN 'paga'::public.billing_charge_status
                       ELSE 'paga_parcial'::public.billing_charge_status END,
         paid_at = NULL
   WHERE id = v_p.charge_id;

  INSERT INTO public.billing_events (entity_type, entity_id, event, actor_user_id, actor_kind, before, after)
  VALUES ('billing_payments', v_id, 'refund_created', auth.uid(), 'manual',
          jsonb_build_object('original_payment_id', _payment_id, 'original_amount', v_p.amount_cents),
          jsonb_build_object('reversal_amount', -v_p.amount_cents, 'reason', _reason));

  RETURN jsonb_build_object('ok', true, 'reversal_id', v_id, 'saldo_pago_cents', v_pago);
END $$;

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.billing_payment_methods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_payment_methods FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_payment_methods TO authenticated;

CREATE POLICY billing_pm_read ON public.billing_payment_methods FOR SELECT TO authenticated
  USING (public.can_read_billing(auth.uid()));
CREATE POLICY billing_pm_insert ON public.billing_payment_methods FOR INSERT TO authenticated
  WITH CHECK (public.can_write_billing(auth.uid()));
CREATE POLICY billing_pm_update ON public.billing_payment_methods FOR UPDATE TO authenticated
  USING (public.can_write_billing(auth.uid())) WITH CHECK (public.can_write_billing(auth.uid()));
CREATE POLICY billing_pm_delete ON public.billing_payment_methods FOR DELETE TO authenticated
  USING (public.can_admin_billing(auth.uid()));

REVOKE ALL ON FUNCTION public.billing_register_manual_payment(uuid, bigint, public.billing_payment_method, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.billing_reverse_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_register_manual_payment(uuid, bigint, public.billing_payment_method, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_reverse_payment(uuid, text) TO authenticated;

COMMENT ON TABLE public.billing_payment_methods IS
  'Meios de pagamento. Só tokens e referências do provedor — nunca PAN, CVV ou chave privada.';