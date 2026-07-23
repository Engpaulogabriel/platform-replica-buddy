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
  day_start timestamptz;
  day_end timestamptz;
  peak_start timestamptz;
  peak_end timestamptz;
  pumps_operated_v int := 0;
  pumps_running_now_v int := 0;
  pumps_peak_v int := 0;
  minutes_peak_v int := 0;
  lost_min_v int := 0;
  pre_off_v timestamptz;
  post_on_v timestamptz;
  pre_ok_v int := 0;
  post_ok_v int := 0;
  eff numeric := 100;
  avg_7 numeric;
  avg_30 numeric;
  in_or_after_peak boolean;
  after_peak boolean;
BEGIN
  IF NOT (has_farm_access(auth.uid(), _farm_id) OR is_platform_staff(auth.uid())) THEN
    RETURN jsonb_build_object('error','forbidden');
  END IF;

  SELECT COALESCE(timezone,'America/Sao_Paulo') INTO tz FROM farms WHERE id = _farm_id;
  IF tz IS NULL THEN
    RETURN jsonb_build_object('error','farm_not_found');
  END IF;

  today_local := (now() AT TIME ZONE tz)::date;
  now_local   := (now() AT TIME ZONE tz);
  day_start   := ((today_local::text || ' 00:00')::timestamp AT TIME ZONE tz);
  day_end     := day_start + interval '1 day';
  peak_start  := ((today_local::text || ' 18:00')::timestamp AT TIME ZONE tz);
  peak_end    := ((today_local::text || ' 21:00')::timestamp AT TIME ZONE tz);
  in_or_after_peak := now() >= peak_start;
  after_peak       := now() >= peak_end;

  -- Bombas ligadas AGORA (verdade do equipments.last_outputs_state)
  SELECT COUNT(*) INTO pumps_running_now_v
    FROM equipments
   WHERE farm_id = _farm_id
     AND active = true
     AND type IN ('poco','bombeamento')
     AND saida IS NOT NULL
     AND last_outputs_state IS NOT NULL
     AND substring(last_outputs_state from saida for 1) = '1';

  -- Bombas que operaram hoje: ligadas agora UNION com qualquer turn_on registrado hoje
  WITH operated_today AS (
    SELECT id AS equipment_id
      FROM equipments
     WHERE farm_id = _farm_id
       AND active = true
       AND type IN ('poco','bombeamento')
       AND saida IS NOT NULL
       AND last_outputs_state IS NOT NULL
       AND substring(last_outputs_state from saida for 1) = '1'
    UNION
    SELECT DISTINCT equipment_id
      FROM automation_log
     WHERE farm_id = _farm_id
       AND action = 'turn_on'
       AND result = 'success'
       AND equipment_id IS NOT NULL
       AND occurred_at >= day_start
       AND occurred_at < day_end
  )
  SELECT COUNT(*) INTO pumps_operated_v FROM operated_today;

  -- Sessões de operação no dia (mesma lógica de compute_energy_efficiency)
  IF in_or_after_peak THEN
    WITH last_before AS (
      SELECT DISTINCT ON (equipment_id) equipment_id, action, occurred_at
        FROM automation_log
       WHERE farm_id = _farm_id AND result = 'success'
         AND action IN ('turn_on','turn_off') AND equipment_id IS NOT NULL
         AND occurred_at < day_start
       ORDER BY equipment_id, occurred_at DESC
    ),
    carry_on AS (
      SELECT equipment_id, day_start AS occurred_at, 'turn_on'::event_action AS action
        FROM last_before WHERE action = 'turn_on'
    ),
    day_events AS (
      SELECT equipment_id, occurred_at, action
        FROM automation_log
       WHERE farm_id = _farm_id AND result = 'success'
         AND action IN ('turn_on','turn_off') AND equipment_id IS NOT NULL
         AND occurred_at >= day_start AND occurred_at < day_end
    ),
    all_ev AS (
      SELECT * FROM carry_on UNION ALL SELECT * FROM day_events
    ),
    ranked AS (
      SELECT equipment_id, action, occurred_at,
             LEAD(occurred_at) OVER w AS next_at
        FROM all_ev
      WINDOW w AS (PARTITION BY equipment_id ORDER BY occurred_at)
    ),
    sessions AS (
      SELECT equipment_id, occurred_at AS on_at,
             COALESCE(next_at, LEAST(day_end, now())) AS off_at
        FROM ranked WHERE action = 'turn_on'
    ),
    sessions_clipped AS (
      SELECT equipment_id, on_at, off_at,
             GREATEST(on_at, peak_start) AS peak_lo,
             LEAST(off_at, peak_end) AS peak_hi
        FROM sessions WHERE off_at > on_at
    ),
    per_pump AS (
      SELECT equipment_id,
             SUM(GREATEST(0, EXTRACT(epoch FROM (peak_hi - peak_lo))/60)) AS peak_min,
             BOOL_OR(off_at > peak_start AND on_at < peak_end) AS hit_peak
        FROM sessions_clipped GROUP BY equipment_id
    )
    SELECT
      COALESCE((SELECT COUNT(*) FROM per_pump WHERE hit_peak), 0),
      COALESCE((SELECT FLOOR(SUM(peak_min))::int FROM per_pump), 0)
    INTO pumps_peak_v, minutes_peak_v;

    -- Pré-ponta: último OFF antes das 18:00
    SELECT MAX(occurred_at) INTO pre_off_v FROM automation_log
     WHERE farm_id = _farm_id AND action = 'turn_off' AND result = 'success'
       AND occurred_at >= day_start AND occurred_at < peak_start;

    SELECT COUNT(DISTINCT equipment_id) INTO pre_ok_v FROM automation_log
     WHERE farm_id = _farm_id AND action = 'turn_off' AND result = 'success'
       AND occurred_at >= day_start AND occurred_at < peak_start
       AND equipment_id IS NOT NULL;
  END IF;

  IF after_peak THEN
    SELECT MIN(occurred_at) INTO post_on_v FROM automation_log
     WHERE farm_id = _farm_id AND action = 'turn_on' AND result = 'success'
       AND occurred_at >= peak_end AND occurred_at < peak_end + interval '3 hours';

    WITH first_post AS (
      SELECT equipment_id, MIN(occurred_at) AS first_on
        FROM automation_log
       WHERE farm_id = _farm_id AND action = 'turn_on' AND result = 'success'
         AND occurred_at >= peak_end AND occurred_at < peak_end + interval '3 hours'
         AND equipment_id IS NOT NULL
       GROUP BY equipment_id
    )
    SELECT
      COALESCE(SUM(GREATEST(0, FLOOR(EXTRACT(epoch FROM (first_on - peak_end))/60))::int), 0),
      COUNT(*) FILTER (WHERE first_on <= peak_end + interval '5 minutes')
    INTO lost_min_v, post_ok_v
    FROM first_post;
  END IF;

  -- Eficiência: só penaliza se houve operação E já entrou na ponta
  IF pumps_operated_v = 0 OR NOT in_or_after_peak THEN
    eff := 100;
  ELSE
    eff := 100
         - (minutes_peak_v::numeric * 3) / GREATEST(1, pumps_operated_v)
         - lost_min_v::numeric / GREATEST(1, pumps_operated_v);
    IF eff < 0   THEN eff := 0;   END IF;
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
    'minutes_on_during_peak', minutes_peak_v,
    'pre_peak_ok_count', pre_ok_v,
    'post_peak_ok_count', post_ok_v,
    'in_peak_window', in_or_after_peak,
    'after_peak_window', after_peak,
    'avg_7d', avg_7,
    'avg_30d', avg_30
  );
END;
$function$;