CREATE OR REPLACE FUNCTION public.compute_estimated_consumption(_farm_id uuid, _date date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer := 0;
  r record;
  v_seconds bigint;
  v_hours real;
  v_m3 real;
  v_day_start timestamptz;
  v_day_end timestamptz;
BEGIN
  v_day_start := (_date::timestamp AT TIME ZONE 'America/Sao_Paulo');
  v_day_end := v_day_start + interval '1 day';

  FOR r IN
    SELECT e.id, e.farm_id, e.vazao_cadastrada_m3h
    FROM public.equipments e
    WHERE e.farm_id = _farm_id
      AND e.vazao_mode = 'estimated'
      AND COALESCE(e.vazao_cadastrada_m3h, 0) > 0
  LOOP
    -- Soma segundos ligada dentro do intervalo do dia, clampando sessões abertas
    SELECT COALESCE(SUM(
      GREATEST(0, EXTRACT(EPOCH FROM (
        LEAST(COALESCE(pr.ended_at, now()), v_day_end)
        - GREATEST(pr.started_at, v_day_start)
      )))
    ), 0)::bigint INTO v_seconds
    FROM public.pump_runtime pr
    WHERE pr.equipment_id = r.id
      AND pr.started_at < v_day_end
      AND COALESCE(pr.ended_at, now()) > v_day_start;

    v_hours := v_seconds / 3600.0;
    v_m3 := v_hours * r.vazao_cadastrada_m3h;

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