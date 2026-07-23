CREATE OR REPLACE FUNCTION public.get_energy_efficiency_summary(_farm_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  tz text;
  today_local date;
  now_local timestamp;
  cycle_start_local timestamp;
  cycle_start timestamptz;
  cycle_end timestamptz;
  today_peak_start timestamptz;
  today_peak_end timestamptz;
  pumps_operated_v int := 0;
  pumps_running_now_v int := 0;
  pumps_updated_cycle_v int := 0;
  pumps_peak_v int := 0;
  minutes_peak_v int := 0;
  lost_min_v int := 0;
  pre_off_v timestamptz;
  post_on_v timestamptz;
  post_on_fallback_v timestamptz;
  pre_ok_v int := 0;
  post_ok_v int := 0;
  eff numeric := 100;
  avg_7 numeric;
  avg_30 numeric;
  in_or_after_today_peak boolean;
  after_today_peak boolean;
  running_condition_sql text := 'active = true AND type::text IN (''poco'',''bombeamento'',''conjunto'',''rio'') AND last_outputs_state/saida indicate output = 1';
BEGIN
  IF NOT (has_farm_access(auth.uid(), _farm_id) OR is_platform_staff(auth.uid())) THEN
    RETURN jsonb_build_object('error','forbidden');
  END IF;

  SELECT COALESCE(timezone,'America/Sao_Paulo') INTO tz FROM farms WHERE id = _farm_id;
  IF tz IS NULL THEN
    RETURN jsonb_build_object('error','farm_not_found');
  END IF;

  today_local := (now() AT TIME ZONE tz)::date;
  now_local := (now() AT TIME ZONE tz);
  cycle_start_local := CASE
    WHEN now_local::time >= time '21:00' THEN today_local::timestamp + time '21:00'
    ELSE (today_local - 1)::timestamp + time '21:00'
  END;
  cycle_start := cycle_start_local AT TIME ZONE tz;
  cycle_end := now();
  today_peak_start := (today_local::text || ' 18:00')::timestamp AT TIME ZONE tz;
  today_peak_end := (today_local::text || ' 21:00')::timestamp AT TIME ZONE tz;
  in_or_after_today_peak := now() >= today_peak_start;
  after_today_peak := now() >= today_peak_end;

  WITH pump_equipment AS (
    SELECT id, updated_at, last_communication, last_outputs_state, saida,
           CASE
             WHEN COALESCE(last_outputs_state, '') = '1' THEN true
             WHEN last_outputs_state ~ '^[01]{1,6}$'
              AND saida IS NOT NULL
              AND saida BETWEEN 1 AND char_length(last_outputs_state)
              THEN substring(last_outputs_state from saida for 1) = '1'
             ELSE false
           END AS running_now
      FROM equipments
     WHERE farm_id = _farm_id
       AND active = true
       AND type::text IN ('poco','bombeamento','conjunto','rio')
  )
  SELECT
    COUNT(*) FILTER (WHERE running_now),
    COUNT(*) FILTER (WHERE updated_at >= cycle_start OR last_communication >= cycle_start),
    COUNT(*) FILTER (WHERE running_now OR updated_at >= cycle_start OR last_communication >= cycle_start)
  INTO pumps_running_now_v, pumps_updated_cycle_v, pumps_operated_v
  FROM pump_equipment;

  post_on_fallback_v := CASE WHEN pumps_running_now_v > 0 THEN cycle_start ELSE NULL END;

  SELECT MIN(occurred_at) INTO post_on_v
    FROM automation_log
   WHERE farm_id = _farm_id
     AND action = 'turn_on'
     AND result = 'success'
     AND occurred_at >= cycle_start
     AND occurred_at < cycle_start + interval '3 hours';

  post_on_v := COALESCE(post_on_v, post_on_fallback_v);

  IF in_or_after_today_peak THEN
    SELECT MAX(occurred_at) INTO pre_off_v
      FROM automation_log
     WHERE farm_id = _farm_id
       AND action = 'turn_off'
       AND result = 'success'
       AND occurred_at >= cycle_start
       AND occurred_at < today_peak_start;

    SELECT COUNT(DISTINCT equipment_id) INTO pre_ok_v
      FROM automation_log
     WHERE farm_id = _farm_id
       AND action = 'turn_off'
       AND result = 'success'
       AND equipment_id IS NOT NULL
       AND occurred_at >= cycle_start
       AND occurred_at < today_peak_start;
  END IF;

  IF after_today_peak THEN
    WITH first_post_today AS (
      SELECT equipment_id, MIN(occurred_at) AS first_on
        FROM automation_log
       WHERE farm_id = _farm_id
         AND action = 'turn_on'
         AND result = 'success'
         AND equipment_id IS NOT NULL
         AND occurred_at >= today_peak_end
         AND occurred_at < today_peak_end + interval '3 hours'
       GROUP BY equipment_id
    )
    SELECT
      COALESCE(SUM(GREATEST(0, FLOOR(EXTRACT(epoch FROM (first_on - today_peak_end))/60))::int), 0),
      COUNT(*) FILTER (WHERE first_on <= today_peak_end + interval '5 minutes'),
      COALESCE(MIN(first_on), post_on_fallback_v)
    INTO lost_min_v, post_ok_v, post_on_v
    FROM first_post_today;

    IF post_on_v IS NOT NULL AND post_ok_v = 0 AND pumps_running_now_v > 0 THEN
      post_ok_v := pumps_running_now_v;
    END IF;
  ELSE
    post_ok_v := CASE WHEN post_on_v IS NOT NULL THEN GREATEST(pumps_running_now_v, pumps_operated_v) ELSE 0 END;
  END IF;

  IF in_or_after_today_peak THEN
    WITH pump_equipment AS (
      SELECT id,
             CASE
               WHEN COALESCE(last_outputs_state, '') = '1' THEN true
               WHEN last_outputs_state ~ '^[01]{1,6}$'
                AND saida IS NOT NULL
                AND saida BETWEEN 1 AND char_length(last_outputs_state)
                THEN substring(last_outputs_state from saida for 1) = '1'
               ELSE false
             END AS running_now
        FROM equipments
       WHERE farm_id = _farm_id
         AND active = true
         AND type::text IN ('poco','bombeamento','conjunto','rio')
    ),
    peak_turnons AS (
      SELECT DISTINCT equipment_id
        FROM automation_log
       WHERE farm_id = _farm_id
         AND action = 'turn_on'
         AND result = 'success'
         AND equipment_id IS NOT NULL
         AND occurred_at >= today_peak_start
         AND occurred_at < today_peak_end
    ),
    still_running_peak AS (
      SELECT id AS equipment_id FROM pump_equipment WHERE running_now AND now() >= today_peak_start AND now() < today_peak_end
    ),
    peak_hits AS (
      SELECT equipment_id FROM peak_turnons
      UNION
      SELECT equipment_id FROM still_running_peak
    )
    SELECT COUNT(*) INTO pumps_peak_v FROM peak_hits;

    IF now() >= today_peak_start AND now() < today_peak_end THEN
      minutes_peak_v := pumps_peak_v * GREATEST(0, FLOOR(EXTRACT(epoch FROM (now() - today_peak_start))/60))::int;
    ELSE
      minutes_peak_v := pumps_peak_v * 180;
    END IF;
  END IF;

  IF pumps_operated_v = 0 THEN
    eff := NULL;
  ELSIF NOT in_or_after_today_peak THEN
    eff := NULL;
  ELSE
    eff := 100
       - (minutes_peak_v::numeric * 3) / GREATEST(1, pumps_operated_v)
       - lost_min_v::numeric / GREATEST(1, pumps_operated_v);
    IF eff < 0 THEN eff := 0; END IF;
    IF eff > 100 THEN eff := 100; END IF;
  END IF;

  SELECT ROUND(AVG(efficiency_percent), 1) INTO avg_7
    FROM energy_efficiency_daily
   WHERE farm_id = _farm_id AND date >= today_local - 7 AND date < today_local
     AND pumps_operated > 0;

  SELECT ROUND(AVG(efficiency_percent), 1) INTO avg_30
    FROM energy_efficiency_daily
   WHERE farm_id = _farm_id AND date >= today_local - 30 AND date < today_local
     AND pumps_operated > 0;

  RETURN jsonb_build_object(
    'date', today_local,
    'efficiency_percent', eff,
    'pre_peak_shutdown_time', pre_off_v,
    'post_peak_startup_time', post_on_v,
    'lost_minutes', lost_min_v,
    'pumps_on_during_peak', pumps_peak_v,
    'pumps_operated', pumps_operated_v,
    'pumps_running_now', pumps_running_now_v,
    'pumps_updated_cycle', pumps_updated_cycle_v,
    'minutes_on_during_peak', minutes_peak_v,
    'pre_peak_ok_count', pre_ok_v,
    'post_peak_ok_count', post_ok_v,
    'in_peak_window', in_or_after_today_peak,
    'after_peak_window', after_today_peak,
    'cycle_start', cycle_start,
    'cycle_start_label', to_char(cycle_start AT TIME ZONE tz, 'DD/MM HH24:MI'),
    'avg_7d', avg_7,
    'avg_30d', avg_30,
    'debug', jsonb_build_object(
      'source', 'equipments.last_outputs_state + saida; updated_at/last_communication since cycle start; automation_log only for timestamps when available',
      'running_condition', running_condition_sql,
      'cycle_window', jsonb_build_object('start', cycle_start, 'end', cycle_end, 'timezone', tz),
      'counts', jsonb_build_object('running_now', pumps_running_now_v, 'updated_since_cycle_start', pumps_updated_cycle_v, 'operated_cycle', pumps_operated_v)
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_energy_efficiency_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_energy_efficiency_summary(uuid) TO authenticated;