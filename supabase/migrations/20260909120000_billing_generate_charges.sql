-- ============================================================================
-- SPRINT 2 — GERAÇÃO AUTOMÁTICA DE COBRANÇAS
-- ----------------------------------------------------------------------------
-- REUTILIZA a infraestrutura de idempotência que JÁ EXISTE em billing_charges:
--   • UNIQUE (idempotency_key)
--   • UNIQUE (contract_id, competence_month) WHERE status NOT IN ('cancelada','estornada')
-- Nenhuma tabela nova. Nenhum enum novo. Nenhum índice novo.
--
-- ISOLAMENTO: lê e escreve exclusivamente billing_*. Nenhuma tabela operacional
-- é tocada — nem `farms`.
--
-- DIA DE VENCIMENTO: `billing_contracts_due_day_valid CHECK (due_day BETWEEN 1
-- AND 28)` já existe na fundação. Por isso fevereiro, ano bissexto e meses de
-- 30/31 dias NÃO PODEM produzir data inválida — o dia 28 existe em todo mês de
-- todo ano. A garantia é estrutural, não uma correção aqui.
-- ============================================================================

-- Meses entre duas competências, por periodicidade. IMMUTABLE: o planejador
-- pode dobrar a chamada, e o resultado é determinístico.
CREATE OR REPLACE FUNCTION public.billing_period_months(_p public.billing_periodicity)
RETURNS int LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE _p WHEN 'mensal' THEN 1 WHEN 'bimestral' THEN 2 WHEN 'trimestral' THEN 3
                 WHEN 'semestral' THEN 6 WHEN 'anual' THEN 12 ELSE 1 END;
$$;

/**
 * A competência VIGENTE de um contrato numa data de referência.
 *
 * Regra determinística: as competências caem em `start_date` e daí de N em N
 * meses. A vigente é a última que não passou da referência — ancorada no mês de
 * início, nunca no mês corrente. Sem essa âncora, um contrato trimestral
 * iniciado em fevereiro geraria em jan/abr/jul, e não em fev/mai/ago.
 *
 * Devolve NULL quando o contrato ainda não começou ou já terminou.
 */
CREATE OR REPLACE FUNCTION public.billing_current_competence(
  _start_date date, _end_date date, _periodicity public.billing_periodicity, _ref date
) RETURNS date LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_ini date := date_trunc('month', _start_date)::date;
  v_ref date := date_trunc('month', _ref)::date;
  v_n   int  := public.billing_period_months(_periodicity);
  v_dif int;
  v_comp date;
BEGIN
  IF _start_date IS NULL OR v_ref < v_ini THEN RETURN NULL; END IF;   -- ainda não começou

  -- Quantos meses inteiros desde o início, arredondados PARA BAIXO ao múltiplo
  -- do período: é o que torna o cálculo determinístico e sem acúmulo de erro.
  v_dif := (EXTRACT(YEAR FROM v_ref)::int - EXTRACT(YEAR FROM v_ini)::int) * 12
         + (EXTRACT(MONTH FROM v_ref)::int - EXTRACT(MONTH FROM v_ini)::int);
  v_comp := (v_ini + ((v_dif / v_n) * v_n || ' months')::interval)::date;

  -- Encerrado: nada depois do mês do término.
  IF _end_date IS NOT NULL AND v_comp > date_trunc('month', _end_date)::date THEN
    RETURN NULL;
  END IF;
  RETURN v_comp;
END $$;

/**
 * Gera as cobranças da competência vigente de cada contrato ATIVO.
 *
 * IDEMPOTENTE POR CONSTRUÇÃO: `ON CONFLICT DO NOTHING` sobre a chave
 * `contract:<id>:<YYYY-MM>`. Rodar duas vezes no mesmo dia — ou dez — produz
 * exatamente uma linha por contrato/competência. O segundo unique parcial da
 * fundação cobre o caso de a mesma competência entrar por outro caminho
 * (importação, correção manual) com chave diferente.
 *
 * Só `status = 'ativo'`. Rascunho, pausado, encerrado e cancelado NUNCA geram —
 * e `pausado` é a pausa FINANCEIRA, sem qualquer relação com suspensão
 * operacional de fazenda.
 */
CREATE OR REPLACE FUNCTION public.billing_generate_charges(_reference_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ref     date := COALESCE(_reference_date, current_date);
  v_ct      RECORD;
  v_comp    date;
  v_venc    date;
  v_idem    text;
  v_id      uuid;
  v_criadas int := 0;
  v_puladas int := 0;
  v_avaliados int := 0;
BEGIN
  -- Chamada pelo cron (service_role) ou por operador financeiro.
  IF auth.uid() IS NOT NULL AND NOT public.can_write_billing(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  FOR v_ct IN
    SELECT id, customer_id, amount_cents, periodicity, due_day,
           start_date, end_date, billing_type, description
      FROM public.billing_contracts
     WHERE status = 'ativo'          -- e SOMENTE ativo
     ORDER BY id
  LOOP
    v_avaliados := v_avaliados + 1;

    v_comp := public.billing_current_competence(
                v_ct.start_date, v_ct.end_date, v_ct.periodicity, v_ref);
    IF v_comp IS NULL THEN CONTINUE; END IF;   -- fora da vigência

    -- due_day é 1..28 por CHECK: soma direta jamais estoura o mês.
    v_venc := v_comp + (v_ct.due_day - 1);

    v_idem := 'contract:' || v_ct.id::text || ':' || to_char(v_comp, 'YYYY-MM');

    -- REAJUSTE: `adjustment_index`/`adjustment_month` existem na fundação, mas
    -- aplicar índice é decisão de produto (fonte do IPCA, arredondamento,
    -- retroatividade) e está fora desta Sprint. O valor usado é o do contrato;
    -- quando o reajuste entrar, é aqui que ele muda, sem tocar no resto.
    INSERT INTO public.billing_charges (
      contract_id, customer_id, competence_month, due_date,
      amount_cents, status, idempotency_key)
    VALUES (
      v_ct.id, v_ct.customer_id, v_comp, v_venc,
      v_ct.amount_cents, 'prevista', v_idem)
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NOT NULL THEN
      v_criadas := v_criadas + 1;
      INSERT INTO public.billing_events (entity_type, entity_id, event, actor_user_id, actor_kind, after)
      VALUES ('billing_charges', v_id, 'charge_generated', auth.uid(), 'automatic',
              jsonb_build_object('contract_id', v_ct.id, 'competence', to_char(v_comp,'YYYY-MM'),
                                 'idempotency_key', v_idem, 'amount_cents', v_ct.amount_cents));
    ELSE
      v_puladas := v_puladas + 1;   -- já existia: no-op silencioso
    END IF;
    v_id := NULL;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'reference_date', v_ref,
    'contracts_evaluated', v_avaliados, 'charges_created', v_criadas,
    'already_existed', v_puladas);
END $$;

COMMENT ON FUNCTION public.billing_generate_charges(date) IS
  'Gera a cobrança da competência vigente de cada contrato ATIVO. Idempotente por contract:<id>:<YYYY-MM>.';

REVOKE ALL ON FUNCTION public.billing_period_months(public.billing_periodicity) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.billing_current_competence(date, date, public.billing_periodicity, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.billing_generate_charges(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_period_months(public.billing_periodicity) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.billing_current_competence(date, date, public.billing_periodicity, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.billing_generate_charges(date) TO authenticated, service_role;

-- ── CRON DIÁRIO ────────────────────────────────────────────────────────────
-- Um job, uma chamada, nada mais. Rodar duas vezes é inofensivo: a RPC é
-- idempotente. Bloco tolerante para ambientes sem pg_cron (teste local).
DO $$
BEGIN
  PERFORM cron.unschedule('billing-generate-charges-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  -- 06:00 UTC = 03:00 America/Bahia: fora do horário de operação.
  PERFORM cron.schedule('billing-generate-charges-daily', '0 6 * * *',
                        'SELECT public.billing_generate_charges();');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron indisponível — agende billing-generate-charges-daily manualmente';
END $$;
