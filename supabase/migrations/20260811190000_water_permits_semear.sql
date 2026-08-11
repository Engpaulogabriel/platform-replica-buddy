-- ============================================================================
-- OUTORGAS (water_permits) — estrutura normalizada: 1 portaria → N poços +
-- condicionantes. Diferente de inema_permits (1 linha por equipamento), que NÃO
-- comporta uma portaria com vários poços. Seed: Fazenda Semear (+ Agronave).
-- Aplicar via push (Lovable) OU colar no SQL Editor. Idempotente.
-- ============================================================================

-- ── Schema ──────────────────────────────────────────────────────────────────
-- OBS: farm_id ficou NULLABLE (o pedido original era NOT NULL, mas a Agronave
-- pode não ter fazenda no sistema — "use farm_id NULL").
CREATE TABLE IF NOT EXISTS public.water_permits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  permit_number text NOT NULL,
  permit_date date NOT NULL,
  process_number text NOT NULL,
  holder_name text NOT NULL,
  holder_cpf_cnpj text,
  validity_start date NOT NULL,
  validity_end date NOT NULL,
  municipality text DEFAULT 'São Desidério',
  basin text,
  purpose text DEFAULT 'Irrigação por pivô central',
  irrigated_area_ha numeric,
  regime_hours_per_day integer DEFAULT 18,
  status text DEFAULT 'vigente',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.water_permit_wells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id uuid NOT NULL REFERENCES public.water_permits(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES public.equipments(id) ON DELETE SET NULL,
  well_name text NOT NULL,
  latitude text,
  longitude text,
  flow_rate_m3_day numeric NOT NULL,
  datum text DEFAULT 'Sirgas 2000',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.water_permit_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id uuid NOT NULL REFERENCES public.water_permits(id) ON DELETE CASCADE,
  condition_number integer,
  description text NOT NULL,
  deadline_days integer,
  is_critical boolean DEFAULT false,
  status text DEFAULT 'pendente',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_water_permits_farm ON public.water_permits(farm_id);
CREATE INDEX IF NOT EXISTS idx_water_permit_wells_permit ON public.water_permit_wells(permit_id);
CREATE INDEX IF NOT EXISTS idx_water_permit_conditions_permit ON public.water_permit_conditions(permit_id);

ALTER TABLE public.water_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_permit_wells ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_permit_conditions ENABLE ROW LEVEL SECURITY;

-- ⚠️ RLS conforme solicitado: USING(true)/WITH CHECK(true) = QUALQUER usuário
-- autenticado lê/edita TODAS as outorgas (inclui CPF). Para restringir por
-- fazenda, troque pelas políticas comentadas ao final deste arquivo.
DROP POLICY IF EXISTS water_permits_select ON public.water_permits;
CREATE POLICY water_permits_select ON public.water_permits FOR SELECT USING (true);
DROP POLICY IF EXISTS water_permits_insert ON public.water_permits;
CREATE POLICY water_permits_insert ON public.water_permits FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS water_permits_update ON public.water_permits;
CREATE POLICY water_permits_update ON public.water_permits FOR UPDATE USING (true);

DROP POLICY IF EXISTS water_permit_wells_select ON public.water_permit_wells;
CREATE POLICY water_permit_wells_select ON public.water_permit_wells FOR SELECT USING (true);
DROP POLICY IF EXISTS water_permit_wells_insert ON public.water_permit_wells;
CREATE POLICY water_permit_wells_insert ON public.water_permit_wells FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS water_permit_conditions_select ON public.water_permit_conditions;
CREATE POLICY water_permit_conditions_select ON public.water_permit_conditions FOR SELECT USING (true);
DROP POLICY IF EXISTS water_permit_conditions_insert ON public.water_permit_conditions;
CREATE POLICY water_permit_conditions_insert ON public.water_permit_conditions FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS water_permit_conditions_update ON public.water_permit_conditions;
CREATE POLICY water_permit_conditions_update ON public.water_permit_conditions FOR UPDATE USING (true);

GRANT SELECT, INSERT, UPDATE ON public.water_permits TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.water_permit_wells TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.water_permit_conditions TO authenticated;

-- ── Seed (idempotente): 6 outorgas ─────────────────────────────────────────
-- status calculado por validity_end vs hoje (vencida / vencendo <6m / vigente).
-- equipment_id dos poços = NULL de propósito: os nºs de poço das portarias NÃO
-- mapeiam 1:1 com os equipamentos físicos (o "Poço 8" aparece em portarias
-- diferentes com coordenadas diferentes) — vínculo deve ser manual/verificado.
DO $$
DECLARE
  v_semear   uuid;
  v_agronave uuid;
  p_id       uuid;
  v_status   text;
BEGIN
  SELECT id INTO v_semear   FROM public.farms WHERE name ILIKE 'Semear'   LIMIT 1;
  SELECT id INTO v_agronave FROM public.farms WHERE name ILIKE 'Agronave' LIMIT 1; -- pode ser NULL

  IF v_semear IS NULL THEN
    RAISE NOTICE 'Fazenda "Semear" não encontrada — seed de outorgas IGNORADO. Rode de novo após criar a fazenda.';
    RETURN;
  END IF;

  -- ── OUTORGA 1: 33.285 ─────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.water_permits WHERE permit_number = '33.285') THEN
    v_status := CASE WHEN DATE '2029-06-07' < CURRENT_DATE THEN 'vencida'
                     WHEN DATE '2029-06-07' < CURRENT_DATE + INTERVAL '6 months' THEN 'vencendo'
                     ELSE 'vigente' END;
    INSERT INTO public.water_permits
      (farm_id, permit_number, permit_date, process_number, holder_name, holder_cpf_cnpj,
       validity_start, validity_end, basin, irrigated_area_ha, status, notes)
    VALUES
      (v_semear, '33.285', '2025-06-06', '2024.001.009426/INEMA/LIC-09426',
       'José Silmar Nogueira', '438.811.651-34', '2025-06-07', '2029-06-07', 'Rio Grande', 423.5, v_status,
       'Localização: Fazendas Semear (Gleba 01 e 02) e Semear II (Gleba 2, 3 e 4)')
    RETURNING id INTO p_id;
    INSERT INTO public.water_permit_wells (permit_id, well_name, latitude, longitude, flow_rate_m3_day) VALUES
      (p_id, 'Poço 8',  '13°01''25,3"S',  '45°24''32"W',    5400),
      (p_id, 'Poço 9',  '13°2''3,02"S',   '45°24''5,39"W',  5400),
      (p_id, 'Poço 10', '13°2''25,82"S',  '45°24''49,41"W', 5400),
      (p_id, 'Poço 11', '13°02''15,7"S',  '45°25''22,5"W',  5400),
      (p_id, 'Poço 16', '13°02''46,43"S', '45°25''34,29"W', 5400);
    INSERT INTO public.water_permit_conditions (permit_id, condition_number, description, is_critical) VALUES
      (p_id, 1, 'Monitoramento conforme Portaria INEMA 22.181/2021', false),
      (p_id, 2, 'Não captar até sistema de medição instalado', false),
      (p_id, 3, 'Atender licenças ambientais', false),
      (p_id, 4, 'Eficiência e sustentabilidade', false),
      (p_id, 5, 'Projeto técnico de uso racional', false);
  END IF;

  -- ── OUTORGA 2: 33.281 ─────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.water_permits WHERE permit_number = '33.281') THEN
    v_status := CASE WHEN DATE '2029-06-06' < CURRENT_DATE THEN 'vencida'
                     WHEN DATE '2029-06-06' < CURRENT_DATE + INTERVAL '6 months' THEN 'vencendo'
                     ELSE 'vigente' END;
    INSERT INTO public.water_permits
      (farm_id, permit_number, permit_date, process_number, holder_name, holder_cpf_cnpj,
       validity_start, validity_end, basin, irrigated_area_ha, status, notes)
    VALUES
      (v_semear, '33.281', '2025-06-05', '2024.001.002938/INEMA/LIC-02938',
       'José Silmar Nogueira', '438.811.651-34', '2025-06-06', '2029-06-06', 'Rio Grande', 423.5, v_status,
       'Localização: Fazendas Semear (Gleba 01 e 03) e Semear II (Gleba 2 e 04)')
    RETURNING id INTO p_id;
    INSERT INTO public.water_permit_wells (permit_id, well_name, latitude, longitude, flow_rate_m3_day) VALUES
      (p_id, 'Poço 6',  '13°0''2,34"S',   '45°25''23,28"W', 5400),
      (p_id, 'Poço 8',  '13°00''28,56"S', '45°26''3,66"W',  5400),
      (p_id, 'Poço 12', '13°00''59,28"S', '45°25''56,22"W', 5400),
      (p_id, 'Poço 14', '13°01''47,82"S', '45°26''37,31"W', 5400),
      (p_id, 'Poço 15', '13°02''00,48"S', '45°26''29,16"W', 5400);
    INSERT INTO public.water_permit_conditions (permit_id, condition_number, description, deadline_days, is_critical) VALUES
      (p_id, 1, 'Monitoramento conforme Portaria INEMA 22.181/2021', NULL, false),
      (p_id, 2, 'Não captar até sistema de medição instalado', NULL, false),
      (p_id, 3, 'Atender licenças ambientais', NULL, false),
      (p_id, 4, 'Eficiência e sustentabilidade', NULL, false),
      (p_id, 5, 'Projeto técnico de uso racional', NULL, false),
      (p_id, 6, 'Teste de interferência de 120h com medidor de nível no piezômetro. Protocolar no SEI em até 180 dias.', 180, true);
  END IF;

  -- ── OUTORGA 3: 33.737 ─────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.water_permits WHERE permit_number = '33.737') THEN
    v_status := CASE WHEN DATE '2029-09-09' < CURRENT_DATE THEN 'vencida'
                     WHEN DATE '2029-09-09' < CURRENT_DATE + INTERVAL '6 months' THEN 'vencendo'
                     ELSE 'vigente' END;
    INSERT INTO public.water_permits
      (farm_id, permit_number, permit_date, process_number, holder_name, holder_cpf_cnpj,
       validity_start, validity_end, basin, irrigated_area_ha, status, notes)
    VALUES
      (v_semear, '33.737', '2025-09-08', '2024.001.000056/INEMA/LIC-00056',
       'José Silmar Nogueira', '438.811.651-34', '2025-09-09', '2029-09-09', 'Rio Grande', 84.7, v_status,
       'Localização: Fazenda Semear II (Gleba 02)')
    RETURNING id INTO p_id;
    INSERT INTO public.water_permit_wells (permit_id, well_name, latitude, longitude, flow_rate_m3_day) VALUES
      (p_id, 'Poço 7', '13°0''43,58"S', '45°24''59,48"W', 5400);
    INSERT INTO public.water_permit_conditions (permit_id, condition_number, description, deadline_days, is_critical) VALUES
      (p_id, 1, 'Monitoramento conforme Portaria INEMA 22.181/2021', NULL, false),
      (p_id, 2, 'Não captar até sistema de medição instalado', NULL, false),
      (p_id, 3, 'Atender licenças ambientais', NULL, false),
      (p_id, 4, 'Eficiência e sustentabilidade', NULL, false),
      (p_id, 5, 'CRÍTICO: teste de interferência de 120h ininterruptas com medidor de nível no piezômetro enquanto o poço produtor é bombeado. Protocolar no SEI o resultado em até 180 dias após a publicação.', 180, true),
      (p_id, 6, 'Projeto técnico de uso racional', NULL, false);
  END IF;

  -- ── OUTORGA 4: 25.560 (VENCIDA em 17/03/2026) ─────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.water_permits WHERE permit_number = '25.560') THEN
    v_status := CASE WHEN DATE '2026-03-17' < CURRENT_DATE THEN 'vencida'
                     WHEN DATE '2026-03-17' < CURRENT_DATE + INTERVAL '6 months' THEN 'vencendo'
                     ELSE 'vigente' END;
    INSERT INTO public.water_permits
      (farm_id, permit_number, permit_date, process_number, holder_name, holder_cpf_cnpj,
       validity_start, validity_end, basin, irrigated_area_ha, status, notes)
    VALUES
      (v_semear, '25.560', '2022-03-16', '2021.001.008744/INEMA/LIC-08744',
       'José Silmar Nogueira', '438.811.651-34', '2022-03-17', '2026-03-17', 'Rio São Francisco', 282.31, v_status,
       'Localização: Fazenda Semear II')
    RETURNING id INTO p_id;
    INSERT INTO public.water_permit_wells (permit_id, well_name, latitude, longitude, flow_rate_m3_day) VALUES
      (p_id, 'Poço 1', '13°1''25,86"S', '45°23''36,15"W', 9000),
      (p_id, 'Poço 2', '13°0''21,54"S', '45°24''28,45"W', 9000);
    INSERT INTO public.water_permit_conditions (permit_id, condition_number, description, is_critical) VALUES
      (p_id, 1, 'Monitoramento conforme Portaria INEMA 22.181/2021', false),
      (p_id, 2, 'Não captar até sistema de medição instalado', false),
      (p_id, 3, 'Atender licenças ambientais', false),
      (p_id, 4, 'Eficiência e sustentabilidade', false),
      (p_id, 5, 'Apresentar avaliação de demanda de água por cultura', false);
  END IF;

  -- ── OUTORGA 5: 27.368 (VENCENDO em 11/11/2026) ────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.water_permits WHERE permit_number = '27.368') THEN
    v_status := CASE WHEN DATE '2026-11-11' < CURRENT_DATE THEN 'vencida'
                     WHEN DATE '2026-11-11' < CURRENT_DATE + INTERVAL '6 months' THEN 'vencendo'
                     ELSE 'vigente' END;
    INSERT INTO public.water_permits
      (farm_id, permit_number, permit_date, process_number, holder_name, holder_cpf_cnpj,
       validity_start, validity_end, basin, irrigated_area_ha, status, notes)
    VALUES
      (v_semear, '27.368', '2022-11-10', '2022.001.004154/INEMA/LIC-04154',
       'José Silmar Nogueira', '438.811.651-34', '2022-11-11', '2026-11-11', 'Rio São Francisco', 450, v_status,
       'Localização: Fazendas Semear e Semear II')
    RETURNING id INTO p_id;
    INSERT INTO public.water_permit_wells (permit_id, well_name, latitude, longitude, flow_rate_m3_day) VALUES
      (p_id, 'Poço 1', '13°00''49,53"S', '45°25''49,48"W', 9000),
      (p_id, 'Poço 2', '13°02''06,29"S', '45°26''17"W',    9000),
      (p_id, 'Poço 3', '13°01''52,77"S', '45°24''54,7"W',  9000);
    INSERT INTO public.water_permit_conditions (permit_id, condition_number, description, is_critical) VALUES
      (p_id, 1, 'Monitoramento conforme Portaria INEMA 22.181/2021', false),
      (p_id, 2, 'Não captar até sistema de medição instalado', false),
      (p_id, 3, 'Atender licenças ambientais', false),
      (p_id, 4, 'Eficiência e sustentabilidade', false),
      (p_id, 5, 'Apresentar avaliação de demanda de água por cultura', false),
      (p_id, 6, 'CRÍTICO: instalar horímetro no sistema de medição de vazão implantado no empreendimento.', true);
  END IF;

  -- ── OUTORGA 6: 28.608 (Fazenda AGRONAVE — titular diferente) ──────────────
  IF NOT EXISTS (SELECT 1 FROM public.water_permits WHERE permit_number = '28.608') THEN
    v_status := CASE WHEN DATE '2027-05-13' < CURRENT_DATE THEN 'vencida'
                     WHEN DATE '2027-05-13' < CURRENT_DATE + INTERVAL '6 months' THEN 'vencendo'
                     ELSE 'vigente' END;
    INSERT INTO public.water_permits
      (farm_id, permit_number, permit_date, process_number, holder_name, holder_cpf_cnpj,
       validity_start, validity_end, basin, irrigated_area_ha, status, notes)
    VALUES
      (v_agronave, '28.608', '2023-05-12', '2022.001.006563/INEMA/LIC-06563',
       'Nelson Antônio Troian Júnior', '029.923.369-39', '2023-05-13', '2027-05-13', 'Rio São Francisco', 122.75, v_status,
       'Localização: Fazenda Agronave. farm_id=' || COALESCE(v_agronave::text, 'NULL (fazenda Agronave não cadastrada)'))
    RETURNING id INTO p_id;
    INSERT INTO public.water_permit_wells (permit_id, well_name, latitude, longitude, flow_rate_m3_day) VALUES
      (p_id, 'Poço 1', '13°02''57,08"S', '45°27''22,19"W', 9000);
    INSERT INTO public.water_permit_conditions (permit_id, condition_number, description, is_critical) VALUES
      (p_id, 1, 'Monitoramento conforme Portaria INEMA 22.181/2021', false),
      (p_id, 2, 'Não captar até sistema de medição instalado', false),
      (p_id, 3, 'Atender licenças ambientais', false),
      (p_id, 4, 'Eficiência e sustentabilidade', false);
  END IF;
END $$;

-- ── ALTERNATIVA RECOMENDADA de RLS (farm-scoped) — descomente e troque acima ──
-- CREATE POLICY water_permits_select ON public.water_permits FOR SELECT TO authenticated
--   USING (farm_id IS NULL OR public.has_farm_access(auth.uid(), farm_id));
-- CREATE POLICY water_permits_write ON public.water_permits FOR ALL TO authenticated
--   USING (farm_id IS NOT NULL AND public.can_write_farm(auth.uid(), farm_id))
--   WITH CHECK (farm_id IS NOT NULL AND public.can_write_farm(auth.uid(), farm_id));
