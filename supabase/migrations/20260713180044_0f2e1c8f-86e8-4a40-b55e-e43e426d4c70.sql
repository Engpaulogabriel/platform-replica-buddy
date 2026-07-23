
-- 1. Novas colunas em equipments para vazão/consumo (acumulador em m³)
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS flow_accum_m3 bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flow_accum_at timestamptz,
  ADD COLUMN IF NOT EXISTS flow_daily_start_m3 bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flow_daily_start_at timestamptz;

-- 2. Tabela de histórico de vazão/consumo
CREATE TABLE IF NOT EXISTS public.flow_history (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  equipment_id uuid NOT NULL REFERENCES public.equipments(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL DEFAULT now(),
  accum_m3 bigint NOT NULL,
  daily_consumption_m3 bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.flow_history TO authenticated;
GRANT ALL ON public.flow_history TO service_role;

ALTER TABLE public.flow_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "flow_history_select_members"
  ON public.flow_history FOR SELECT
  USING (public.has_farm_access(auth.uid(), farm_id));

CREATE POLICY "flow_history_select_platform_staff"
  ON public.flow_history FOR SELECT
  USING (public.is_platform_staff(auth.uid()));

CREATE POLICY "flow_history_insert_writers"
  ON public.flow_history FOR INSERT
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

CREATE INDEX IF NOT EXISTS idx_flow_history_equipment_ts
  ON public.flow_history(equipment_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_flow_history_farm_ts
  ON public.flow_history(farm_id, ts DESC);

-- 3. RPC apply_flow_telemetry
CREATE OR REPLACE FUNCTION public.apply_flow_telemetry(
  _farm_id uuid,
  _plc_hw_id text,
  _raw_value integer,
  _raw_response text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_eq_id uuid;
  v_prev_daily_start bigint;
  v_prev_daily_start_at timestamptz;
  v_needs_reset boolean := false;
  v_daily bigint;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  -- Localiza equipamento tipo 'vazao' no mesmo grupo PLC
  SELECT e.id, e.flow_daily_start_m3, e.flow_daily_start_at
    INTO v_eq_id, v_prev_daily_start, v_prev_daily_start_at
    FROM public.equipments e
    JOIN public.plc_groups p ON p.id = e.plc_group_id
   WHERE e.farm_id = _farm_id
     AND e.type = 'vazao'
     AND upper(p.hw_id) = upper(_plc_hw_id)
   ORDER BY e.created_at ASC
   LIMIT 1;

  IF v_eq_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Precisa resetar o ponto de partida diário?
  IF v_prev_daily_start_at IS NULL
     OR date_trunc('day', (v_prev_daily_start_at AT TIME ZONE 'America/Sao_Paulo'))
        < date_trunc('day', (now() AT TIME ZONE 'America/Sao_Paulo'))
     OR _raw_value < COALESCE(v_prev_daily_start, 0) THEN
    v_needs_reset := true;
    v_prev_daily_start := _raw_value;
  END IF;

  v_daily := GREATEST(_raw_value - COALESCE(v_prev_daily_start, _raw_value), 0);

  UPDATE public.equipments
     SET flow_accum_m3 = _raw_value,
         flow_accum_at = now(),
         last_communication = now(),
         flow_daily_start_m3 = CASE WHEN v_needs_reset THEN _raw_value ELSE flow_daily_start_m3 END,
         flow_daily_start_at = CASE WHEN v_needs_reset THEN now() ELSE flow_daily_start_at END
   WHERE id = v_eq_id;

  INSERT INTO public.flow_history (equipment_id, farm_id, ts, accum_m3, daily_consumption_m3)
  VALUES (v_eq_id, _farm_id, now(), _raw_value, v_daily);

  RETURN v_eq_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_flow_telemetry(uuid, text, integer, text) TO authenticated, service_role;
