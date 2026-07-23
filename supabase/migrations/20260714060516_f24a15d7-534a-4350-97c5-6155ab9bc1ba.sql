-- Módulo de Vazão e Consumo (Estimado / Real)

-- 1) Novos campos em equipments
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS vazao_mode text NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS vazao_cadastrada_m3h real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flow_total_m3 integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flow_rate_m3h real NOT NULL DEFAULT 0;

ALTER TABLE public.equipments
  DROP CONSTRAINT IF EXISTS equipments_vazao_mode_check;
ALTER TABLE public.equipments
  ADD CONSTRAINT equipments_vazao_mode_check
  CHECK (vazao_mode IN ('off','estimated','real'));

-- 2) Tabela de consumo diário
CREATE TABLE IF NOT EXISTS public.daily_consumption (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES public.equipments(id) ON DELETE CASCADE,
  date date NOT NULL,
  total_m3 real NOT NULL DEFAULT 0,
  mode text NOT NULL DEFAULT 'estimated' CHECK (mode IN ('estimated','real')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (equipment_id, date)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_consumption TO authenticated;
GRANT ALL ON public.daily_consumption TO service_role;

ALTER TABLE public.daily_consumption ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS daily_consumption_select_members ON public.daily_consumption;
CREATE POLICY daily_consumption_select_members
  ON public.daily_consumption FOR SELECT
  USING (has_farm_access(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));

DROP POLICY IF EXISTS daily_consumption_write_writers ON public.daily_consumption;
CREATE POLICY daily_consumption_write_writers
  ON public.daily_consumption FOR ALL
  USING (can_write_farm(auth.uid(), farm_id) OR is_platform_staff(auth.uid()))
  WITH CHECK (can_write_farm(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));

CREATE INDEX IF NOT EXISTS idx_daily_consumption_farm_date
  ON public.daily_consumption (farm_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_consumption_equipment_date
  ON public.daily_consumption (equipment_id, date DESC);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at_daily_consumption()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_daily_consumption_updated_at ON public.daily_consumption;
CREATE TRIGGER trg_daily_consumption_updated_at
  BEFORE UPDATE ON public.daily_consumption
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_daily_consumption();

-- 3) RPC para calcular consumo estimado do dia (chamada por cron ou edge function)
--    Baseado em horímetro: usa pump_runtime (segundos ligada) por equipamento
CREATE OR REPLACE FUNCTION public.compute_estimated_consumption(_farm_id uuid, _date date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer := 0;
  r record;
  v_hours real;
  v_m3 real;
BEGIN
  FOR r IN
    SELECT e.id, e.farm_id, e.vazao_cadastrada_m3h
    FROM public.equipments e
    WHERE e.farm_id = _farm_id
      AND e.vazao_mode = 'estimated'
      AND COALESCE(e.vazao_cadastrada_m3h, 0) > 0
  LOOP
    -- soma segundos ligada no dia via pump_runtime (se existir)
    SELECT COALESCE(SUM(pr.seconds_on), 0) / 3600.0
      INTO v_hours
    FROM public.pump_runtime pr
    WHERE pr.equipment_id = r.id
      AND pr.day = _date;

    v_m3 := COALESCE(v_hours, 0) * r.vazao_cadastrada_m3h;

    INSERT INTO public.daily_consumption (farm_id, equipment_id, date, total_m3, mode)
    VALUES (r.farm_id, r.id, _date, v_m3, 'estimated')
    ON CONFLICT (equipment_id, date) DO UPDATE
      SET total_m3 = EXCLUDED.total_m3,
          mode = 'estimated',
          updated_at = now();
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END; $$;

GRANT EXECUTE ON FUNCTION public.compute_estimated_consumption(uuid, date) TO authenticated, service_role;