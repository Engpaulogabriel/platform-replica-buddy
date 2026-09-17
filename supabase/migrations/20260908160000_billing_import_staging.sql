-- ============================================================================
-- ETAPA 1 — IMPORTAÇÃO DA CARTEIRA: STAGING E COMMIT TRANSACIONAL
-- ----------------------------------------------------------------------------
-- REGRA ABSOLUTA: antes da aprovação, ZERO INSERT em billing_customers,
-- billing_contracts, billing_charges ou qualquer tabela definitiva. As linhas
-- do arquivo vivem SÓ em `billing_import_rows` — staging fisicamente separado.
--
-- ISOLAMENTO: nada aqui lê ou escreve tabela operacional. `farms` aparece
-- apenas como LEITURA de identidade no matching (SELECT), nunca escrita.
--
-- O COMMIT É NO BANCO, não no frontend: uma função plpgsql roda dentro de UMA
-- transação. Se qualquer linha crítica falhar, nada é aplicado — não existe
-- "metade da importação". Fazer isso no cliente exigiria N chamadas sem
-- atomicidade, que é exatamente o modo de falha que precisamos evitar.
-- ============================================================================

CREATE TYPE public.billing_import_kind AS ENUM
  ('carteira', 'clientes', 'contratos', 'cobrancas');

CREATE TYPE public.billing_import_status AS ENUM
  ('criado', 'lido', 'mapeado', 'validado', 'aprovado', 'aplicado', 'descartado', 'erro');

CREATE TYPE public.billing_import_row_status AS ENUM
  ('valida', 'invalida', 'duplicada', 'ignorada', 'aplicada');

CREATE TABLE public.billing_import_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            public.billing_import_kind NOT NULL DEFAULT 'carteira',
  source_filename text NOT NULL,
  -- O BINÁRIO NÃO É GUARDADO. filename + sha256 + bytes + o `raw` de cada linha
  -- bastam para auditar a origem sem reter o arquivo.
  source_sha256   text NOT NULL,
  source_bytes    bigint NOT NULL,
  mime            text,
  column_mapping  jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          public.billing_import_status NOT NULL DEFAULT 'criado',
  total_rows      int NOT NULL DEFAULT 0,
  valid_rows      int NOT NULL DEFAULT 0,
  invalid_rows    int NOT NULL DEFAULT 0,
  duplicate_rows  int NOT NULL DEFAULT 0,
  summary         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid REFERENCES auth.users(id),
  approved_by     uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  parsed_at       timestamptz,
  approved_at     timestamptz,
  committed_at    timestamptz,
  error           text,
  CONSTRAINT billing_import_jobs_sha_len CHECK (length(source_sha256) = 64)
);

CREATE INDEX billing_import_jobs_status_idx ON public.billing_import_jobs (status, created_at DESC);
-- NÃO é unique: repetir um arquivo pode ser legítimo. O índice existe para
-- ALERTAR no preview ("este arquivo já foi importado"), exigindo decisão
-- humana — bloquear automaticamente seria pior que avisar.
CREATE INDEX billing_import_jobs_sha_idx ON public.billing_import_jobs (source_sha256);

CREATE TABLE public.billing_import_rows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES public.billing_import_jobs(id) ON DELETE CASCADE,
  row_number   int NOT NULL,
  raw          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- linha crua, nunca perdida
  mapped       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- após mapeamento/normalização
  validation   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- lista de problemas
  row_status   public.billing_import_row_status NOT NULL DEFAULT 'valida',
  reject_reason text,
  match_customer_id        uuid REFERENCES public.billing_customers(id) ON DELETE SET NULL,
  -- farm_id sem FK de propósito: o matching é SUGESTÃO e pode apontar para
  -- fazenda que o operador ainda vai revisar. FK aqui travaria o staging.
  match_farm_id            uuid,
  duplicate_of_customer_id uuid,
  duplicate_of_contract_id uuid,
  duplicate_of_charge_id   uuid,
  created_entity_type      text,
  created_entity_id        uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_import_rows_job_row_uniq UNIQUE (job_id, row_number)
);

CREATE INDEX billing_import_rows_job_status_idx ON public.billing_import_rows (job_id, row_status);

-- ── APROVAÇÃO ──────────────────────────────────────────────────────────────
-- Explícita e separada do commit: aprovar é decisão humana registrada;
-- aplicar é a consequência. `finance_viewer` não passa por can_write_billing.
CREATE OR REPLACE FUNCTION public.billing_import_approve(_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job RECORD;
BEGIN
  IF NOT public.can_write_billing(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  SELECT * INTO v_job FROM public.billing_import_jobs WHERE id = _job_id FOR UPDATE;
  IF v_job.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'job_not_found'); END IF;
  IF v_job.status = 'aplicado' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_applied');
  END IF;
  IF v_job.status <> 'validado' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_validated', 'status', v_job.status);
  END IF;

  UPDATE public.billing_import_jobs
     SET status = 'aprovado', approved_by = auth.uid(), approved_at = now()
   WHERE id = _job_id;

  INSERT INTO public.billing_events (entity_type, entity_id, event, actor_user_id, actor_kind, after)
  VALUES ('billing_import_jobs', _job_id, 'import_approved', auth.uid(), 'manual',
          jsonb_build_object('job_id', _job_id));
  RETURN jsonb_build_object('ok', true, 'job_id', _job_id);
END $$;

-- ── COMMIT TRANSACIONAL ────────────────────────────────────────────────────
-- Aplica SOMENTE row_status='valida'. Inválidas, duplicadas e ignoradas
-- permanecem no staging, auditáveis. Toda a função é UMA transação: exceção em
-- qualquer linha desfaz tudo.
CREATE OR REPLACE FUNCTION public.billing_import_commit(_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job RECORD; v_row RECORD;
  v_cust uuid; v_contract uuid;
  v_customers int := 0; v_contracts int := 0; v_charges int := 0;
  v_m jsonb;
BEGIN
  IF NOT public.can_write_billing(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  SELECT * INTO v_job FROM public.billing_import_jobs WHERE id = _job_id FOR UPDATE;
  IF v_job.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'job_not_found'); END IF;
  -- IDEMPOTÊNCIA: job aplicado nunca aplica de novo.
  IF v_job.status = 'aplicado' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_applied',
                              'committed_at', v_job.committed_at);
  END IF;
  IF v_job.status <> 'aprovado' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_approved', 'status', v_job.status);
  END IF;

  FOR v_row IN
    SELECT * FROM public.billing_import_rows
     WHERE job_id = _job_id AND row_status = 'valida'
     ORDER BY row_number
  LOOP
    v_m := v_row.mapped;

    -- CLIENTE: reusa o existente quando o matching achou; senão cria.
    IF v_row.match_customer_id IS NOT NULL THEN
      v_cust := v_row.match_customer_id;
    ELSE
      INSERT INTO public.billing_customers (
        legal_name, trade_name, doc_type, doc_number, email_billing,
        phone_billing, whatsapp_billing, endereco, city, state, zip_code, created_by)
      VALUES (
        v_m->>'legal_name', v_m->>'trade_name',
        (COALESCE(v_m->>'doc_type','cnpj'))::public.billing_doc_type,
        v_m->>'doc_number', v_m->>'email_billing',
        v_m->>'phone_billing', v_m->>'whatsapp_billing', v_m->>'endereco',
        v_m->>'city', v_m->>'state', v_m->>'zip_code', auth.uid())
      RETURNING id INTO v_cust;
      v_customers := v_customers + 1;
      INSERT INTO public.billing_events (entity_type, entity_id, event, actor_user_id, actor_kind, after)
      VALUES ('billing_customers', v_cust, 'customer_created', auth.uid(), 'import',
              jsonb_build_object('job_id', _job_id, 'row', v_row.row_number));
    END IF;

    -- VÍNCULO COM FAZENDA: só quando o matching foi determinístico. Nunca
    -- escreve em `farms` — apenas registra a associação do lado financeiro.
    IF v_row.match_farm_id IS NOT NULL THEN
      INSERT INTO public.billing_customer_farms (customer_id, farm_id)
      VALUES (v_cust, v_row.match_farm_id) ON CONFLICT DO NOTHING;
    END IF;

    -- CONTRATO
    IF v_m ? 'amount_cents' AND v_row.duplicate_of_contract_id IS NULL THEN
      INSERT INTO public.billing_contracts (
        customer_id, billing_type, description, amount_cents, periodicity,
        due_day, start_date, end_date, status, notes, created_by)
      VALUES (
        v_cust, (COALESCE(v_m->>'billing_type','personalizado'))::public.billing_type,
        COALESCE(NULLIF(btrim(v_m->>'description'),''), 'Importado da carteira'),
        (v_m->>'amount_cents')::bigint,
        (COALESCE(v_m->>'periodicity','mensal'))::public.billing_periodicity,
        COALESCE((v_m->>'due_day')::int, 10),
        COALESCE((v_m->>'start_date')::date, current_date),
        NULLIF(v_m->>'end_date','')::date,
        (COALESCE(v_m->>'status','ativo'))::public.billing_contract_status,
        v_m->>'notes', auth.uid())
      RETURNING id INTO v_contract;
      v_contracts := v_contracts + 1;

      IF v_row.match_farm_id IS NOT NULL THEN
        INSERT INTO public.billing_contract_farms (contract_id, customer_id, farm_id)
        VALUES (v_contract, v_cust, v_row.match_farm_id) ON CONFLICT DO NOTHING;
      END IF;

      INSERT INTO public.billing_events (entity_type, entity_id, event, actor_user_id, actor_kind, after)
      VALUES ('billing_contracts', v_contract, 'contract_created', auth.uid(), 'import',
              jsonb_build_object('job_id', _job_id, 'row', v_row.row_number));
    END IF;

    UPDATE public.billing_import_rows
       SET row_status = 'aplicada',
           created_entity_type = CASE WHEN v_contract IS NOT NULL THEN 'billing_contracts'
                                      ELSE 'billing_customers' END,
           created_entity_id = COALESCE(v_contract, v_cust)
     WHERE id = v_row.id;
    v_contract := NULL;
  END LOOP;

  UPDATE public.billing_import_jobs
     SET status = 'aplicado', committed_at = now(),
         summary = summary || jsonb_build_object(
           'customers_created', v_customers, 'contracts_created', v_contracts,
           'charges_created', v_charges)
   WHERE id = _job_id;

  INSERT INTO public.billing_events (entity_type, entity_id, event, actor_user_id, actor_kind, after)
  VALUES ('billing_import_jobs', _job_id, 'import_applied', auth.uid(), 'import',
          jsonb_build_object('customers_created', v_customers, 'contracts_created', v_contracts));

  RETURN jsonb_build_object('ok', true, 'customers_created', v_customers,
                            'contracts_created', v_contracts, 'charges_created', v_charges);
END $$;

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.billing_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_import_rows ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_import_jobs','billing_import_rows'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon;', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated;', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
                      USING (public.can_read_billing(auth.uid()));$p$, t||'_read', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR INSERT TO authenticated
                      WITH CHECK (public.can_write_billing(auth.uid()));$p$, t||'_insert', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
                      USING (public.can_write_billing(auth.uid()))
                      WITH CHECK (public.can_write_billing(auth.uid()));$p$, t||'_update', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR DELETE TO authenticated
                      USING (public.can_admin_billing(auth.uid()));$p$, t||'_delete', t);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.billing_import_approve(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.billing_import_commit(uuid)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_import_approve(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_import_commit(uuid)  TO authenticated;

COMMENT ON TABLE public.billing_import_jobs IS
  'Staging de importação. Nenhuma tabela financeira definitiva recebe INSERT antes de billing_import_commit.';
