-- ============================================================================
-- MÓDULO FINANCEIRO — ETAPA 1: FUNDAÇÃO
-- ----------------------------------------------------------------------------
-- Núcleo de cobrança da RENOV: cadastro, contratos, cobranças, pagamentos e
-- trilha. SEM provider, SEM PIX/boleto, SEM NFS-e, SEM automação, SEM importação.
--
-- BARREIRA OPERACIONAL — a razão de ser deste cabeçalho:
--   `platform_set_farm_suspended()` zera `farms.license_key`, e o agente trata
--   403/revoked/farm_suspended como condição de parada (main.cjs:10034). Ligar
--   inadimplência a esse caminho tiraria o controle das bombas de um cliente por
--   atraso de pagamento.
--   NADA neste arquivo — nem em qualquer código financeiro — pode referenciar
--   platform_set_farm_suspended, platform_toggle_suspend, farms.license_key,
--   farms.license_status, commands, equipments, automation_* ou scheduled_*.
--   As tabelas daqui só olham `farms` por FK de identidade (farm_id), e NUNCA
--   escrevem em `farms`. Há teste de barreira que falha se isso mudar.
--
-- ISOLAMENTO: nenhuma tabela existente é alterada. Só objetos novos, prefixados
-- `billing_`. Não há colisão com as 287 tabelas/funções atuais.
-- ============================================================================

-- ── 1) AUTORIZAÇÃO ─────────────────────────────────────────────────────────
-- Mesmo formato de `platform_admins` (tabela de associação + função STABLE
-- SECURITY DEFINER). Não duplica sistema de auth: `is_platform_admin()` é o
-- superset e continua valendo. `can_view_financial` NÃO é reutilizada — ela já
-- governa o menu Energia do lado do CLIENTE (AppSidebar.tsx:81) e reaproveitá-la
-- daria a gestores de fazenda acesso à central de cobrança da RENOV.
CREATE TYPE public.billing_role AS ENUM ('finance', 'finance_viewer');

CREATE TABLE public.billing_roles (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       public.billing_role NOT NULL,
  created_by uuid REFERENCES auth.users(id),
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

-- Leitura: admin da plataforma, financeiro e visualizador.
CREATE OR REPLACE FUNCTION public.can_read_billing(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id IS NOT NULL AND (
    public.is_platform_admin(_user_id)
    OR EXISTS (SELECT 1 FROM public.billing_roles r WHERE r.user_id = _user_id)
  );
$$;

-- Escrita: admin da plataforma e financeiro. `finance_viewer` NUNCA escreve.
CREATE OR REPLACE FUNCTION public.can_write_billing(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id IS NOT NULL AND (
    public.is_platform_admin(_user_id)
    OR EXISTS (SELECT 1 FROM public.billing_roles r
                WHERE r.user_id = _user_id AND r.role = 'finance')
  );
$$;

-- Só admin da plataforma administra quem é do financeiro.
CREATE OR REPLACE FUNCTION public.can_admin_billing(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id IS NOT NULL AND public.is_platform_admin(_user_id);
$$;

REVOKE ALL ON FUNCTION public.can_read_billing(uuid)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_write_billing(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_admin_billing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_billing(uuid)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_write_billing(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_admin_billing(uuid) TO authenticated;

-- ── 2) ENUMS DE DOMÍNIO ────────────────────────────────────────────────────
CREATE TYPE public.billing_doc_type AS ENUM ('cnpj', 'cpf');

CREATE TYPE public.billing_type AS ENUM (
  'taxa_acesso_online',      -- legado: conectividade/manutenção do link
  'mensalidade_plataforma',  -- cliente novo: SaaS completo
  'manutencao',
  'servico',
  'personalizado'
);

-- pausado = contrato financeiramente pausado; nunca implica suspensão
-- operacional da fazenda.
--
-- SEM 'suspenso': proposital, e a decisão foi tomada explicitamente. `suspenso`
-- é o vocabulário da suspensão OPERACIONAL de fazenda — `platform_set_farm_suspended()`
-- zera `farms.license_key`, e o agente trata 403/revoked/farm_suspended como
-- condição de parada (main.cjs:10034). Usar a mesma palavra aqui convidaria
-- alguém, no futuro, a ligar inadimplência a esse caminho e tirar o controle
-- das bombas de um cliente por atraso de pagamento. A palavra diferente é uma
-- barreira deliberada contra essa confusão.
CREATE TYPE public.billing_contract_status AS ENUM (
  'rascunho', 'ativo', 'pausado', 'encerrado', 'cancelado'
);

CREATE TYPE public.billing_periodicity AS ENUM (
  'mensal', 'bimestral', 'trimestral', 'semestral', 'anual'
);

CREATE TYPE public.billing_adjustment_index AS ENUM ('nenhum', 'ipca', 'igpm', 'inpc');

CREATE TYPE public.billing_payment_method AS ENUM (
  'pix', 'pix_automatico', 'boleto', 'transferencia', 'cartao', 'outro'
);

CREATE TYPE public.billing_charge_status AS ENUM (
  'prevista', 'aberta', 'enviada', 'paga', 'paga_parcial',
  'vencida', 'em_negociacao', 'cancelada', 'estornada'
);

-- NOME: `billing_customer_state`, não `..._status`. Em Postgres tipos e relações
-- dividem o mesmo namespace, e a VIEW derivada chama-se billing_customer_status.
CREATE TYPE public.billing_customer_state AS ENUM ('ativo', 'inativo', 'prospect');

CREATE TYPE public.billing_actor_kind AS ENUM ('manual', 'automatic', 'webhook', 'import');

-- ── 3) CLIENTE FINANCEIRO ──────────────────────────────────────────────────
-- Entidade PRÓPRIA, distinta de `farms`: um cliente pode ter várias fazendas.
CREATE TABLE public.billing_customers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name      text NOT NULL,
  trade_name      text,
  doc_type        public.billing_doc_type NOT NULL,
  doc_number      text NOT NULL,
  email_billing   text,
  phone_billing   text,
  whatsapp_billing text,
  endereco        text,
  city            text,
  state           text,
  zip_code        text,
  status          public.billing_customer_state NOT NULL DEFAULT 'ativo',
  notes           text,
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_customers_doc_not_blank CHECK (btrim(doc_number) <> ''),
  CONSTRAINT billing_customers_legal_name_not_blank CHECK (btrim(legal_name) <> '')
);

-- DUPLICIDADE DE DOCUMENTO: o unique é sobre o documento NORMALIZADO (só
-- dígitos). Sem isso, '12.345.678/0001-90' e '12345678000190' entrariam como
-- dois clientes — e o mesmo cliente receberia duas cobranças.
CREATE UNIQUE INDEX billing_customers_doc_norm_uniq
  ON public.billing_customers (regexp_replace(doc_number, '[^0-9]', '', 'g'));

-- ── 4) CLIENTE ↔ FAZENDAS ──────────────────────────────────────────────────
-- A PK composta já impede vínculo duplicado.
CREATE TABLE public.billing_customer_farms (
  customer_id uuid NOT NULL REFERENCES public.billing_customers(id) ON DELETE CASCADE,
  farm_id     uuid NOT NULL REFERENCES public.farms(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, farm_id)
);
-- ON DELETE RESTRICT em farms de propósito: apagar fazenda com vínculo
-- financeiro tem de ser decisão explícita, não efeito colateral.

CREATE INDEX billing_customer_farms_farm_idx ON public.billing_customer_farms (farm_id);

-- ── 5) CONTRATOS ───────────────────────────────────────────────────────────
CREATE TABLE public.billing_contracts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES public.billing_customers(id) ON DELETE RESTRICT,
  billing_type  public.billing_type NOT NULL,
  -- Texto editável por cliente. É o que sai no boleto e na discriminação da NF.
  description   text NOT NULL,
  amount_cents  bigint NOT NULL,
  currency      char(3) NOT NULL DEFAULT 'BRL',
  periodicity   public.billing_periodicity NOT NULL DEFAULT 'mensal',
  due_day       smallint NOT NULL DEFAULT 10,
  start_date    date NOT NULL,
  end_date      date,
  adjustment_index public.billing_adjustment_index NOT NULL DEFAULT 'nenhum',
  adjustment_month smallint,
  payment_method_preference public.billing_payment_method,
  auto_issue_charge boolean NOT NULL DEFAULT false,
  auto_charge       boolean NOT NULL DEFAULT false,
  auto_invoice      boolean NOT NULL DEFAULT false,
  status        public.billing_contract_status NOT NULL DEFAULT 'rascunho',
  notes         text,
  created_by    uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_contracts_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT billing_contracts_due_day_valid CHECK (due_day BETWEEN 1 AND 28),
  CONSTRAINT billing_contracts_adjustment_month_valid
    CHECK (adjustment_month IS NULL OR adjustment_month BETWEEN 1 AND 12),
  CONSTRAINT billing_contracts_period_order CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT billing_contracts_description_not_blank CHECK (btrim(description) <> ''),
  -- Alvo da FK composta de billing_contract_farms. É esta linha que torna
  -- impossível, no BANCO, um contrato apontar para fazenda de outro cliente.
  CONSTRAINT billing_contracts_id_customer_uniq UNIQUE (id, customer_id)
);
-- due_day limitado a 28: 29/30/31 não existem em todo mês e produziriam
-- vencimento inválido em fevereiro. Vencimento em fim de mês é caso do gerador
-- de cobranças (Etapa 2), não um dia fixo.

CREATE INDEX billing_contracts_customer_idx ON public.billing_contracts (customer_id);
CREATE INDEX billing_contracts_status_idx ON public.billing_contracts (status)
  WHERE status = 'ativo';

-- ── 6) CONTRATO ↔ FAZENDAS (subconjunto) ───────────────────────────────────
-- Um contrato cobre SOMENTE as fazendas listadas aqui. Não há "abrange todas
-- as fazendas do cliente" implícito.
--
-- INTEGRIDADE DECLARATIVA, não trigger: `customer_id` é carregado junto e as
-- duas FKs compostas se encadeiam —
--   (contract_id, customer_id) tem de existir em billing_contracts, e
--   (customer_id, farm_id)     tem de existir em billing_customer_farms.
-- Logo, anexar fazenda de OUTRO cliente é impossível: ou o par contrato/cliente
-- não bate, ou o par cliente/fazenda não existe. Não depende de frontend, nem
-- de trigger que alguém possa desabilitar.
CREATE TABLE public.billing_contract_farms (
  contract_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  farm_id     uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, farm_id),
  CONSTRAINT billing_contract_farms_contract_fk
    FOREIGN KEY (contract_id, customer_id)
    REFERENCES public.billing_contracts (id, customer_id) ON DELETE CASCADE,
  CONSTRAINT billing_contract_farms_customer_farm_fk
    FOREIGN KEY (customer_id, farm_id)
    REFERENCES public.billing_customer_farms (customer_id, farm_id) ON DELETE RESTRICT
);

CREATE INDEX billing_contract_farms_farm_idx ON public.billing_contract_farms (farm_id);

-- ── 7) COBRANÇAS ───────────────────────────────────────────────────────────
CREATE TABLE public.billing_charges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id      uuid NOT NULL REFERENCES public.billing_contracts(id) ON DELETE RESTRICT,
  customer_id      uuid NOT NULL REFERENCES public.billing_customers(id) ON DELETE RESTRICT,
  -- Primeiro dia do mês de competência: `date` normalizada evita o clássico
  -- '2026-09' vs '2026-9' em texto.
  competence_month date NOT NULL,
  due_date         date NOT NULL,
  amount_cents     bigint NOT NULL,
  discount_cents   bigint NOT NULL DEFAULT 0,
  interest_cents   bigint NOT NULL DEFAULT 0,
  fine_cents       bigint NOT NULL DEFAULT 0,
  -- GERADA: total nunca diverge das parcelas. Não há caminho para gravar um
  -- total inconsistente com os componentes.
  total_cents      bigint GENERATED ALWAYS AS
                     (amount_cents - discount_cents + interest_cents + fine_cents) STORED,
  status           public.billing_charge_status NOT NULL DEFAULT 'prevista',
  idempotency_key  text NOT NULL,
  paid_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_charges_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT billing_charges_components_non_negative
    CHECK (discount_cents >= 0 AND interest_cents >= 0 AND fine_cents >= 0),
  CONSTRAINT billing_charges_discount_not_above_amount CHECK (discount_cents <= amount_cents),
  CONSTRAINT billing_charges_competence_is_month_start
    CHECK (competence_month = date_trunc('month', competence_month)::date),
  CONSTRAINT billing_charges_idem_not_blank CHECK (btrim(idempotency_key) <> '')
);

-- IDEMPOTÊNCIA (1): a chave é única de forma absoluta.
CREATE UNIQUE INDEX billing_charges_idempotency_uniq
  ON public.billing_charges (idempotency_key);

-- IDEMPOTÊNCIA (2): duas defesas, não uma. A chave protege contra o gerador
-- rodar duas vezes; este índice protege contra a MESMA competência ser criada
-- por outro caminho (correção manual, importação) com chave diferente.
-- PARCIAL: exclui 'cancelada'/'estornada' para que reemitir depois de cancelar
-- continue possível — que é operação legítima.
CREATE UNIQUE INDEX billing_charges_contract_competence_uniq
  ON public.billing_charges (contract_id, competence_month)
  WHERE status NOT IN ('cancelada', 'estornada');

CREATE INDEX billing_charges_customer_status_idx
  ON public.billing_charges (customer_id, status);
CREATE INDEX billing_charges_due_open_idx ON public.billing_charges (due_date)
  WHERE status IN ('prevista', 'aberta', 'enviada', 'vencida', 'em_negociacao');

-- ── 8) PAGAMENTOS ──────────────────────────────────────────────────────────
-- Independente de provider: `provider` e `provider_payment_id` são nullable
-- para permitir baixa manual (transferência, acerto) desde já.
CREATE TABLE public.billing_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id           uuid NOT NULL REFERENCES public.billing_charges(id) ON DELETE RESTRICT,
  amount_cents        bigint NOT NULL,
  paid_at             timestamptz NOT NULL,
  method              public.billing_payment_method NOT NULL,
  provider            text,
  provider_payment_id text,
  raw_payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciled_by       public.billing_actor_kind NOT NULL DEFAULT 'manual',
  reconciled_by_user  uuid REFERENCES auth.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_payments_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT billing_payments_provider_pair
    CHECK ((provider IS NULL) = (provider_payment_id IS NULL))
);

-- IDEMPOTÊNCIA DE WEBHOOK: reprocessar o mesmo evento do provedor não pode
-- gerar dois pagamentos. Parcial porque baixa manual não tem id de provedor.
CREATE UNIQUE INDEX billing_payments_provider_uniq
  ON public.billing_payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE INDEX billing_payments_charge_idx ON public.billing_payments (charge_id);

-- ── 9) TRILHA APPEND-ONLY ──────────────────────────────────────────────────
CREATE TABLE public.billing_events (
  id             bigserial PRIMARY KEY,
  entity_type    text NOT NULL,
  entity_id      uuid,
  event          text NOT NULL,
  actor_user_id  uuid REFERENCES auth.users(id),
  actor_kind     public.billing_actor_kind NOT NULL DEFAULT 'manual',
  provider       text,
  before         jsonb,
  after          jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX billing_events_entity_idx ON public.billing_events (entity_type, entity_id, occurred_at DESC);

-- APPEND-ONLY em duas camadas: (a) nenhuma policy de UPDATE/DELETE existe, e
-- (b) trigger que aborta mesmo se alguém adicionar policy depois. Só um
-- superusuário desabilitando o trigger explicitamente contorna.
CREATE OR REPLACE FUNCTION public.billing_events_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'billing_events é append-only: % não é permitido', TG_OP;
END $$;

CREATE TRIGGER billing_events_no_update
  BEFORE UPDATE ON public.billing_events
  FOR EACH ROW EXECUTE FUNCTION public.billing_events_append_only();

CREATE TRIGGER billing_events_no_delete
  BEFORE DELETE ON public.billing_events
  FOR EACH ROW EXECUTE FUNCTION public.billing_events_append_only();

-- ── 10) updated_at ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE TRIGGER billing_customers_touch BEFORE UPDATE ON public.billing_customers
  FOR EACH ROW EXECUTE FUNCTION public.billing_touch_updated_at();
CREATE TRIGGER billing_contracts_touch BEFORE UPDATE ON public.billing_contracts
  FOR EACH ROW EXECUTE FUNCTION public.billing_touch_updated_at();
CREATE TRIGGER billing_charges_touch BEFORE UPDATE ON public.billing_charges
  FOR EACH ROW EXECUTE FUNCTION public.billing_touch_updated_at();

-- ── 11) VIEW DERIVADA ──────────────────────────────────────────────────────
-- Inadimplência e "vence em breve" são DERIVADOS, nunca colunas. Guardar como
-- boolean cria a divergência clássica entre o campo e a realidade quando o job
-- não roda.
-- security_invoker = true: a view respeita a RLS de quem consulta. Sem isso ela
-- rodaria com os direitos do dono e furaria todo o isolamento abaixo.
CREATE VIEW public.billing_customer_status
WITH (security_invoker = true) AS
SELECT
  c.id AS customer_id,
  c.legal_name,
  c.doc_number,
  c.status AS customer_status,
  count(ch.id) FILTER (WHERE ch.status IN ('aberta','enviada','vencida','em_negociacao')) AS open_charges,
  COALESCE(sum(ch.total_cents) FILTER (WHERE ch.status IN ('aberta','enviada','vencida','em_negociacao')), 0) AS open_cents,
  COALESCE(sum(ch.total_cents) FILTER (WHERE ch.due_date < current_date
           AND ch.status IN ('aberta','enviada','vencida','em_negociacao')), 0) AS overdue_cents,
  max(current_date - ch.due_date) FILTER (WHERE ch.due_date < current_date
      AND ch.status IN ('aberta','enviada','vencida','em_negociacao')) AS max_days_overdue,
  EXISTS (SELECT 1 FROM public.billing_charges x
           WHERE x.customer_id = c.id AND x.due_date < current_date
             AND x.status IN ('aberta','enviada','vencida','em_negociacao')) AS is_delinquent,
  EXISTS (SELECT 1 FROM public.billing_charges x
           WHERE x.customer_id = c.id AND x.status IN ('aberta','enviada')
             AND x.due_date BETWEEN current_date AND current_date + 5) AS due_soon
FROM public.billing_customers c
LEFT JOIN public.billing_charges ch ON ch.customer_id = c.id
GROUP BY c.id, c.legal_name, c.doc_number, c.status;

-- ── 12) RLS E GRANTS ───────────────────────────────────────────────────────
-- anon: ZERO. authenticated comum: ZERO (tem GRANT, mas nenhuma policy o
-- alcança — toda policy exige can_read/can_write/can_admin_billing).
-- Não existe policy ampla do tipo `TO authenticated USING (true)`.
ALTER TABLE public.billing_roles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_customers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_customer_farms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_contracts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_contract_farms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_charges        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_events         ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_roles','billing_customers','billing_customer_farms',
                           'billing_contracts','billing_contract_farms','billing_charges',
                           'billing_payments','billing_events'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon;', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated;', t);
  END LOOP;
  -- A trilha não recebe UPDATE/DELETE nem no nível de privilégio.
  EXECUTE 'REVOKE UPDATE, DELETE ON public.billing_events FROM authenticated;';
END $$;

REVOKE ALL ON public.billing_customer_status FROM PUBLIC, anon;
GRANT SELECT ON public.billing_customer_status TO authenticated;
REVOKE ALL ON SEQUENCE public.billing_events_id_seq FROM PUBLIC, anon;
GRANT USAGE ON SEQUENCE public.billing_events_id_seq TO authenticated;

-- billing_roles: só admin da plataforma vê e administra.
CREATE POLICY billing_roles_admin_all ON public.billing_roles FOR ALL TO authenticated
  USING (public.can_admin_billing(auth.uid()))
  WITH CHECK (public.can_admin_billing(auth.uid()));

-- Demais tabelas: leitura para quem pode ler; escrita só para quem pode escrever.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_customers','billing_customer_farms','billing_contracts',
                           'billing_contract_farms','billing_charges','billing_payments'] LOOP
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
                      USING (public.can_read_billing(auth.uid()));$p$, t||'_read', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR INSERT TO authenticated
                      WITH CHECK (public.can_write_billing(auth.uid()));$p$, t||'_insert', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
                      USING (public.can_write_billing(auth.uid()))
                      WITH CHECK (public.can_write_billing(auth.uid()));$p$, t||'_update', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR DELETE TO authenticated
                      USING (public.can_write_billing(auth.uid()));$p$, t||'_delete', t);
  END LOOP;
END $$;

-- Trilha: lê quem lê; grava quem escreve; ninguém altera nem apaga.
CREATE POLICY billing_events_read ON public.billing_events FOR SELECT TO authenticated
  USING (public.can_read_billing(auth.uid()));
CREATE POLICY billing_events_insert ON public.billing_events FOR INSERT TO authenticated
  WITH CHECK (public.can_write_billing(auth.uid()));

COMMENT ON TABLE public.billing_events IS
  'Trilha append-only do financeiro. Sem policy de UPDATE/DELETE e com trigger de bloqueio.';
COMMENT ON TABLE public.billing_contract_farms IS
  'Fazendas COBERTAS pelo contrato. FKs compostas garantem que a fazenda pertence ao mesmo cliente.';
