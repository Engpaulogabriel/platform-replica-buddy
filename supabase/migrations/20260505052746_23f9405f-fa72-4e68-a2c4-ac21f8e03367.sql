
-- 1) Config de produtividade/energia por fazenda
CREATE TABLE public.farm_productivity_config (
  farm_id uuid PRIMARY KEY,
  -- deslocamento
  travel_minutes_avg numeric NOT NULL DEFAULT 30,
  travel_distance_km numeric NOT NULL DEFAULT 10,
  worker_cost_per_hour numeric NOT NULL DEFAULT 25,
  vehicle_cost_per_km numeric NOT NULL DEFAULT 2.5,
  -- tarifas Coelba (R$)
  tariff_off_peak numeric NOT NULL DEFAULT 0.55,
  tariff_peak numeric NOT NULL DEFAULT 2.80,
  tariff_reserved numeric NOT NULL DEFAULT 0.32,
  contracted_demand_kw numeric NOT NULL DEFAULT 0,
  demand_cost_per_kw numeric NOT NULL DEFAULT 35,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE public.farm_productivity_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "prod_cfg_select_members" ON public.farm_productivity_config
  FOR SELECT TO authenticated USING (has_farm_access(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));
CREATE POLICY "prod_cfg_insert_admin" ON public.farm_productivity_config
  FOR INSERT TO authenticated WITH CHECK (is_platform_admin(auth.uid()));
CREATE POLICY "prod_cfg_update_admin" ON public.farm_productivity_config
  FOR UPDATE TO authenticated USING (is_platform_admin(auth.uid())) WITH CHECK (is_platform_admin(auth.uid()));
CREATE POLICY "prod_cfg_delete_admin" ON public.farm_productivity_config
  FOR DELETE TO authenticated USING (is_platform_admin(auth.uid()));

-- 2) Config INEMA por fazenda
CREATE TABLE public.farm_inema_config (
  farm_id uuid PRIMARY KEY,
  outorga_numero text,
  outorga_processo text,
  outorga_validade date,
  vazao_outorgada_m3h numeric,
  orgao text DEFAULT 'INEMA',
  responsavel_tecnico text,
  observacoes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE public.farm_inema_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inema_select_members" ON public.farm_inema_config
  FOR SELECT TO authenticated USING (has_farm_access(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));
CREATE POLICY "inema_insert_admin" ON public.farm_inema_config
  FOR INSERT TO authenticated WITH CHECK (is_platform_admin(auth.uid()));
CREATE POLICY "inema_update_admin" ON public.farm_inema_config
  FOR UPDATE TO authenticated USING (is_platform_admin(auth.uid())) WITH CHECK (is_platform_admin(auth.uid()));
CREATE POLICY "inema_delete_admin" ON public.farm_inema_config
  FOR DELETE TO authenticated USING (is_platform_admin(auth.uid()));

-- 3) Feriados nacionais
CREATE TABLE public.national_holidays (
  holiday_date date PRIMARY KEY,
  name text NOT NULL
);
ALTER TABLE public.national_holidays ENABLE ROW LEVEL SECURITY;
CREATE POLICY "holidays_read_all" ON public.national_holidays
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "holidays_admin_all" ON public.national_holidays
  FOR ALL TO authenticated USING (is_platform_admin(auth.uid())) WITH CHECK (is_platform_admin(auth.uid()));

INSERT INTO public.national_holidays (holiday_date, name) VALUES
('2025-01-01','Confraternização Universal'),
('2025-04-21','Tiradentes'),
('2025-05-01','Dia do Trabalho'),
('2025-09-07','Independência'),
('2025-10-12','N. Sra. Aparecida'),
('2025-11-02','Finados'),
('2025-11-15','Proclamação da República'),
('2025-12-25','Natal'),
('2025-03-03','Carnaval (segunda)'),
('2025-03-04','Carnaval (terça)'),
('2025-04-18','Sexta-feira Santa'),
('2025-06-19','Corpus Christi'),
('2026-01-01','Confraternização Universal'),
('2026-04-21','Tiradentes'),
('2026-05-01','Dia do Trabalho'),
('2026-09-07','Independência'),
('2026-10-12','N. Sra. Aparecida'),
('2026-11-02','Finados'),
('2026-11-15','Proclamação da República'),
('2026-12-25','Natal'),
('2026-02-16','Carnaval (segunda)'),
('2026-02-17','Carnaval (terça)'),
('2026-04-03','Sexta-feira Santa'),
('2026-06-04','Corpus Christi'),
('2027-01-01','Confraternização Universal'),
('2027-04-21','Tiradentes'),
('2027-05-01','Dia do Trabalho'),
('2027-09-07','Independência'),
('2027-10-12','N. Sra. Aparecida'),
('2027-11-02','Finados'),
('2027-11-15','Proclamação da República'),
('2027-12-25','Natal'),
('2027-02-08','Carnaval (segunda)'),
('2027-02-09','Carnaval (terça)'),
('2027-03-26','Sexta-feira Santa'),
('2027-05-27','Corpus Christi'),
('2028-01-01','Confraternização Universal'),
('2028-04-21','Tiradentes'),
('2028-05-01','Dia do Trabalho'),
('2028-09-07','Independência'),
('2028-10-12','N. Sra. Aparecida'),
('2028-11-02','Finados'),
('2028-11-15','Proclamação da República'),
('2028-12-25','Natal'),
('2028-02-28','Carnaval (segunda)'),
('2028-02-29','Carnaval (terça)'),
('2028-04-14','Sexta-feira Santa'),
('2028-06-15','Corpus Christi'),
('2029-01-01','Confraternização Universal'),
('2029-04-21','Tiradentes'),
('2029-05-01','Dia do Trabalho'),
('2029-09-07','Independência'),
('2029-10-12','N. Sra. Aparecida'),
('2029-11-02','Finados'),
('2029-11-15','Proclamação da República'),
('2029-12-25','Natal'),
('2029-02-12','Carnaval (segunda)'),
('2029-02-13','Carnaval (terça)'),
('2029-03-30','Sexta-feira Santa'),
('2029-05-31','Corpus Christi'),
('2030-01-01','Confraternização Universal'),
('2030-04-21','Tiradentes'),
('2030-05-01','Dia do Trabalho'),
('2030-09-07','Independência'),
('2030-10-12','N. Sra. Aparecida'),
('2030-11-02','Finados'),
('2030-11-15','Proclamação da República'),
('2030-12-25','Natal'),
('2030-03-04','Carnaval (segunda)'),
('2030-03-05','Carnaval (terça)'),
('2030-04-19','Sexta-feira Santa'),
('2030-06-20','Corpus Christi');

-- 4) Vazão e potência por equipamento
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS estimated_flow_m3h numeric,
  ADD COLUMN IF NOT EXISTS power_kw numeric;
