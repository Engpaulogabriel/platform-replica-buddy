CREATE OR REPLACE FUNCTION public.get_water_balance(_farm_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_active_pumps int := 0;
  v_total_pumps  int := 0;
  v_avg_rate     numeric;
  v_avg_level    numeric;
  v_status       text;
  v_prediction_h numeric;
  v_sensors_with_data int := 0;
  v_window_minutes numeric;
  v_thr_min      numeric := 0.00167; -- ~0.1 %/h
BEGIN
  SELECT
    count(*) FILTER (
      WHERE desired_running = true
         OR (
           saida IS NOT NULL
           AND last_outputs_state IS NOT NULL
           AND length(last_outputs_state) >= saida::int
           AND substr(last_outputs_state, saida::int, 1) = '1'
         )
    ),
    count(*)
  INTO v_active_pumps, v_total_pumps
  FROM equipments
  WHERE farm_id = _farm_id
    AND active = true
    AND type IN ('poco','bombeamento');

  WITH sensors AS (
    SELECT
      id, level_last_raw, level_last_raw_at,
      CASE
        WHEN level_last_raw IS NOT NULL
         AND level_cal_digital IS NOT NULL AND level_cal_digital > 0
         AND level_cal_meters IS NOT NULL AND level_cal_meters > 0
         AND COALESCE(NULLIF(level_max_meters,0), NULLIF(max_height,0)) IS NOT NULL
         AND COALESCE(NULLIF(level_max_meters,0), NULLIF(max_height,0)) > 0
        THEN LEAST(100, GREATEST(0,
          (((level_last_raw::numeric / level_cal_digital) * level_cal_meters)
            / COALESCE(NULLIF(level_max_meters,0), NULLIF(max_height,0))) * 100))
        ELSE NULL
      END AS percent_now
    FROM equipments
    WHERE farm_id = _farm_id AND active = true AND type = 'nivel'
      AND level_last_raw_at >= now() - interval '60 minutes'
  ),
  recent AS (
    SELECT id AS equipment_id, percent_now, level_last_raw_at AS now_at
    FROM sensors WHERE percent_now IS NOT NULL
  ),
  anchor AS (
    SELECT DISTINCT ON (s.id)
      s.id AS equipment_id,
      lh.percent::numeric AS percent_then,
      lh.read_at AS then_at
    FROM sensors s
    JOIN level_history lh ON lh.equipment_id = s.id
    WHERE lh.read_at <= s.level_last_raw_at - interval '5 minutes'
      AND lh.read_at >= s.level_last_raw_at - interval '24 hours'
      AND lh.percent IS NOT NULL
    ORDER BY s.id, lh.read_at ASC
  ),
  per_sensor AS (
    SELECT r.equipment_id, r.percent_now,
      (r.percent_now - a.percent_then)
        / NULLIF(EXTRACT(EPOCH FROM (r.now_at - a.then_at))/60.0, 0) AS rate_per_min,
      EXTRACT(EPOCH FROM (r.now_at - a.then_at))/60.0 AS window_min
    FROM recent r JOIN anchor a USING (equipment_id)
  )
  SELECT avg(rate_per_min), avg(percent_now), count(*), avg(window_min)
  INTO v_avg_rate, v_avg_level, v_sensors_with_data, v_window_minutes
  FROM per_sensor;

  IF v_avg_level IS NULL THEN
    SELECT avg(percent_now), count(*) FILTER (WHERE percent_now IS NOT NULL)
    INTO v_avg_level, v_sensors_with_data
    FROM (
      SELECT
        CASE
          WHEN level_last_raw IS NOT NULL
           AND level_cal_digital IS NOT NULL AND level_cal_digital > 0
           AND level_cal_meters IS NOT NULL AND level_cal_meters > 0
           AND COALESCE(NULLIF(level_max_meters,0), NULLIF(max_height,0)) IS NOT NULL
           AND COALESCE(NULLIF(level_max_meters,0), NULLIF(max_height,0)) > 0
          THEN LEAST(100, GREATEST(0,
            (((level_last_raw::numeric / level_cal_digital) * level_cal_meters)
              / COALESCE(NULLIF(level_max_meters,0), NULLIF(max_height,0))) * 100))
          ELSE NULL
        END AS percent_now
      FROM equipments
      WHERE farm_id = _farm_id AND active = true AND type = 'nivel'
    ) s;
  END IF;

  IF v_sensors_with_data = 0 OR v_avg_rate IS NULL THEN
    v_status := 'sem_dados';
    v_prediction_h := NULL;
  ELSIF v_avg_rate > v_thr_min THEN
    v_status := 'positiva';
    v_prediction_h := CASE WHEN v_avg_level < 100 THEN ((100 - v_avg_level) / (v_avg_rate * 60)) ELSE NULL END;
  ELSIF v_avg_rate < -v_thr_min THEN
    v_status := CASE WHEN v_active_pumps > 0 THEN 'insuficiente' ELSE 'sem_captacao' END;
    v_prediction_h := CASE WHEN v_avg_level > 0 THEN (v_avg_level / (abs(v_avg_rate) * 60)) ELSE NULL END;
  ELSE
    v_status := 'equilibrada';
    v_prediction_h := NULL;
  END IF;

  RETURN jsonb_build_object(
    'active_pumps', v_active_pumps,
    'total_pumps', v_total_pumps,
    'avg_level_percent', round(coalesce(v_avg_level,0)::numeric, 1),
    'rate_per_hour', round(coalesce(v_avg_rate,0)::numeric * 60, 2),
    'status', v_status,
    'prediction_hours', CASE WHEN v_prediction_h IS NULL THEN NULL ELSE round(v_prediction_h::numeric, 1) END,
    'sensors_with_data', v_sensors_with_data,
    'window_minutes', CASE WHEN v_window_minutes IS NULL THEN NULL ELSE round(v_window_minutes::numeric, 1) END
  );
END;
$function$;