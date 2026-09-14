-- ============================================================================
-- SPRINT 1 — DASHBOARD FINANCEIRO: RPC AGREGADORA
-- ----------------------------------------------------------------------------
-- UMA chamada serve o dashboard inteiro. Não são dez queries do frontend: além
-- do custo, indicadores calculados em momentos diferentes divergem entre si na
-- tela, e o operador não tem como saber qual está certo.
--
-- TUDO DERIVADO, NADA PERSISTIDO. Sem tabela de cache, sem materialized view.
-- Guardar inadimplência como coluna cria a divergência clássica entre o campo e
-- a realidade quando o job não roda — é o mesmo erro que já evitamos em
-- `billing_customer_status`.
--
-- ISOLAMENTO: lê exclusivamente billing_*. Nenhuma tabela operacional é lida ou
-- escrita — nem `farms`.
--
-- DEFINIÇÃO CANÔNICA DE SALDO, usada por todo indicador de dívida:
--   saldo(charge) = total_cents − COALESCE(soma dos billing_payments, 0)
-- `paid_amount_cents` NÃO existe como coluna, de propósito.
--
-- EIXOS DIFERENTES, DE PROPÓSITO:
--   faturado  → por COMPETÊNCIA (competence_month)
--   recebido  → por DATA DE PAGAMENTO (paid_at)
-- São perguntas distintas; o nome de cada campo diz qual eixo usa.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.billing_dashboard_summary(
  _ref_month date DEFAULT NULL   -- mês de referência; NULL = mês corrente
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_mes   date := date_trunc('month', COALESCE(_ref_month, current_date))::date;
  v_fim   date := (v_mes + interval '1 month')::date;
  v_out   jsonb;
BEGIN
  IF NOT public.can_read_billing(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  WITH saldo AS (
    -- Saldo por cobrança. LEFT JOIN + agregação: cobrança sem pagamento tem
    -- saldo integral, e não some do conjunto.
    SELECT c.id, c.customer_id, c.contract_id, c.competence_month, c.due_date,
           c.total_cents, c.status,
           c.total_cents - COALESCE(SUM(p.amount_cents), 0) AS saldo_cents
      FROM public.billing_charges c
      LEFT JOIN public.billing_payments p ON p.charge_id = c.id
     GROUP BY c.id
  ),
  -- Em aberto = ainda deve. Cancelada e estornada nunca contam como dívida.
  devedoras AS (
    SELECT * FROM saldo
     WHERE status NOT IN ('cancelada', 'estornada') AND saldo_cents > 0
  ),
  vencidas AS (SELECT * FROM devedoras WHERE due_date < current_date),
  faturado_mes AS (
    SELECT COALESCE(SUM(total_cents), 0) AS v FROM public.billing_charges
     WHERE competence_month = v_mes AND status NOT IN ('cancelada', 'estornada')
  ),
  recebido_mes AS (
    SELECT COALESCE(SUM(p.amount_cents), 0) AS v
      FROM public.billing_payments p
     WHERE p.paid_at >= v_mes AND p.paid_at < v_fim
  ),
  mrr AS (
    -- Contratos ativos normalizados para MÊS. Sem isso, um anual de R$ 12k
    -- apareceria como se fossem R$ 12k por mês.
    SELECT COALESCE(SUM(
      CASE periodicity
        WHEN 'mensal'     THEN amount_cents
        WHEN 'bimestral'  THEN amount_cents / 2
        WHEN 'trimestral' THEN amount_cents / 3
        WHEN 'semestral'  THEN amount_cents / 6
        WHEN 'anual'      THEN amount_cents / 12
        ELSE amount_cents END), 0)::bigint AS v
      FROM public.billing_contracts
     WHERE status = 'ativo'
       AND start_date <= current_date
       AND (end_date IS NULL OR end_date >= current_date)
  ),
  historico AS (
    -- 12 meses. `generate_series` garante mês sem movimento no eixo, em vez de
    -- um buraco no gráfico.
    SELECT to_char(m, 'YYYY-MM') AS mes,
           COALESCE((SELECT SUM(total_cents) FROM public.billing_charges c
                      WHERE c.competence_month = m::date
                        AND c.status NOT IN ('cancelada','estornada')), 0) AS faturado_cents,
           COALESCE((SELECT SUM(p.amount_cents) FROM public.billing_payments p
                      WHERE p.paid_at >= m AND p.paid_at < m + interval '1 month'), 0) AS recebido_cents
      FROM generate_series(v_mes - interval '11 months', v_mes, interval '1 month') AS m
  ),
  por_tipo AS (
    SELECT ct.billing_type::text AS tipo,
           COALESCE(SUM(c.total_cents), 0) AS faturado_cents,
           count(DISTINCT ct.id) AS contratos
      FROM public.billing_contracts ct
      LEFT JOIN public.billing_charges c
             ON c.contract_id = ct.id AND c.competence_month = v_mes
            AND c.status NOT IN ('cancelada','estornada')
     WHERE ct.status = 'ativo'
     GROUP BY ct.billing_type
  )
  SELECT jsonb_build_object(
    'reference_month', to_char(v_mes, 'YYYY-MM'),
    'generated_at', now(),
    'mrr_cents',              (SELECT v FROM mrr),
    'billed_month_cents',     (SELECT v FROM faturado_mes),
    'received_month_cents',   (SELECT v FROM recebido_mes),
    'open_cents',             (SELECT COALESCE(SUM(saldo_cents),0) FROM devedoras),
    'overdue_cents',          (SELECT COALESCE(SUM(saldo_cents),0) FROM vencidas),
    -- Inadimplência sobre o FATURADO do mês. Divisor zero devolve 0, não erro.
    'delinquency_pct', CASE WHEN (SELECT v FROM faturado_mes) > 0
      THEN round(((SELECT COALESCE(SUM(saldo_cents),0) FROM vencidas)::numeric
                  / (SELECT v FROM faturado_mes)::numeric) * 100, 2) ELSE 0 END,
    'delinquent_customers',   (SELECT count(DISTINCT customer_id) FROM vencidas),
    'active_contracts',       (SELECT count(*) FROM public.billing_contracts WHERE status = 'ativo'),
    'total_customers',        (SELECT count(*) FROM public.billing_customers WHERE status = 'ativo'),
    'revenue_by_type',        (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                 'type', tipo, 'billed_cents', faturado_cents,
                                 'contracts', contratos) ORDER BY faturado_cents DESC), '[]'::jsonb)
                               FROM por_tipo),
    'monthly_history',        (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                 'month', mes, 'billed_cents', faturado_cents,
                                 'received_cents', recebido_cents) ORDER BY mes), '[]'::jsonb)
                               FROM historico),
    'upcoming_due',           (SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'due_date')), '[]'::jsonb)
                               FROM (SELECT jsonb_build_object(
                                       'charge_id', d.id, 'customer_id', d.customer_id,
                                       'customer_name', cu.legal_name, 'due_date', d.due_date,
                                       'amount_cents', d.saldo_cents, 'status', d.status) AS x
                                       FROM devedoras d
                                       JOIN public.billing_customers cu ON cu.id = d.customer_id
                                      WHERE d.due_date >= current_date
                                      ORDER BY d.due_date LIMIT 15) t),
    'recent_payments',        (SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'paid_at') DESC), '[]'::jsonb)
                               FROM (SELECT jsonb_build_object(
                                       'payment_id', p.id, 'customer_name', cu.legal_name,
                                       'paid_at', p.paid_at, 'amount_cents', p.amount_cents,
                                       'method', p.method::text) AS x
                                       FROM public.billing_payments p
                                       JOIN public.billing_charges c ON c.id = p.charge_id
                                       JOIN public.billing_customers cu ON cu.id = c.customer_id
                                      ORDER BY p.paid_at DESC LIMIT 15) t),
    'recent_charges',         (SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'created_at') DESC), '[]'::jsonb)
                               FROM (SELECT jsonb_build_object(
                                       'charge_id', c.id, 'customer_name', cu.legal_name,
                                       'competence_month', c.competence_month, 'due_date', c.due_date,
                                       'total_cents', c.total_cents, 'status', c.status::text,
                                       'created_at', c.created_at) AS x
                                       FROM public.billing_charges c
                                       JOIN public.billing_customers cu ON cu.id = c.customer_id
                                      ORDER BY c.created_at DESC LIMIT 15) t)
  ) INTO v_out;

  RETURN v_out;
END $$;

COMMENT ON FUNCTION public.billing_dashboard_summary(date) IS
  'Dashboard financeiro em UMA chamada. Tudo derivado de billing_* em tempo real; nada persistido.';

REVOKE ALL ON FUNCTION public.billing_dashboard_summary(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_dashboard_summary(date) TO authenticated;
