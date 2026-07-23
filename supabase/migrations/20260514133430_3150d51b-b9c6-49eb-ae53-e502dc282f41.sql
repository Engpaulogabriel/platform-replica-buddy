
ALTER TABLE public.energy_efficiency_daily
  ADD COLUMN IF NOT EXISTS pumps_operated integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS minutes_on_during_peak integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pre_peak_ok_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS post_peak_ok_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.compute_energy_efficiency(_farm_id uuid, _date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tz text;
  day_start timestamptz;
  day_end timestamptz;
  peak_start timestamptz;
  peak_end timestamptz;
  pumps_operated_v int := 0;
  pumps_peak_v int := 0;
  minutes_peak_v int := 0;
  lost_min_v int := 0;
  pre_off_v timestamptz;
  post_on_v timestamptz;
  pre_ok_v int := 0;
  post_ok_v int := 0;
  eff numeric := 100;
  penalty_peak numeric;
  penalty_lost numeric;
BEGIN
  SELECT COALESCE(timezone, 'America/Sao_Paulo') INTO tz FROM farms WHERE id = _farm_id;
  IF tz IS NULL THEN RETURN; END IF;

  day_start := ((_date::text || ' 00:00')::timestamp AT TIME ZONE tz);
  day_end   := day_start + interval '1 day';
  peak_start := ((_date::text || ' 18:00')::timestamp AT TIME ZONE tz);
  peak_end   := ((_date::text || ' 21:00')::timestamp AT TIME ZONE tz);

  -- CTE: reconstrói sessões ON→OFF de cada bomba no dia, considerando carryover
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
           LEAD(action) OVER w AS next_action,
           LEAD(occurred_at) OVER w AS next_at
      FROM all_ev
    WINDOW w AS (PARTITION BY equipment_id ORDER BY occurred_at)
  ),
  sessions AS (
    SELECT equipment_id,
           occurred_at AS on_at,
           COALESCE(next_at, LEAST(day_end, now())) AS off_at
      FROM ranked
     WHERE action = 'turn_on'
  ),
  sessions_clipped AS (
    SELECT equipment_id, on_at, off_at,
           GREATEST(on_at, peak_start) AS peak_lo,
           LEAST(off_at, peak_end) AS peak_hi
      FROM sessions
     WHERE off_at > on_at
  ),
  per_pump AS (
    SELECT equipment_id,
           SUM(GREATEST(0, EXTRACT(epoch FROM (peak_hi - peak_lo))/60)) AS peak_min,
           BOOL_OR(off_at > peak_start AND on_at < peak_end) AS hit_peak
      FROM sessions_clipped
     GROUP BY equipment_id
  )
  SELECT
    COALESCE((SELECT COUNT(DISTINCT equipment_id) FROM day_events WHERE action='turn_on'), 0),
    COALESCE((SELECT COUNT(*) FROM per_pump WHERE hit_peak), 0),
    COALESCE((SELECT FLOOR(SUM(peak_min))::int FROM per_pump), 0)
  INTO pumps_operated_v, pumps_peak_v, minutes_peak_v;

  -- Pré-ponta: último OFF antes das 18:00 no dia (e quantas bombas desligaram a tempo)
  SELECT MAX(occurred_at) INTO pre_off_v FROM automation_log
   WHERE farm_id = _farm_id AND action = 'turn_off' AND result = 'success'
     AND occurred_at >= day_start AND occurred_at < peak_start;

  SELECT COUNT(DISTINCT equipment_id) INTO pre_ok_v FROM automation_log
   WHERE farm_id = _farm_id AND action = 'turn_off' AND result = 'success'
     AND occurred_at >= day_start AND occurred_at < peak_start
     AND equipment_id IS NOT NULL;

  -- Pós-ponta: primeiro ON após 21:00 + soma dos atrasos por bomba
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

  -- Eficiência: penaliza só quem operou. Sem operação no dia → 100%.
  IF pumps_operated_v = 0 THEN
    eff := 100;
  ELSE
    -- Tarifa de ponta = 3x → minuto na ponta vale 3x penalidade
    penalty_peak := (minutes_peak_v::numeric * 3) / GREATEST(1, pumps_operated_v);
    -- Atraso pós-ponta normalizado por bomba que operou
    penalty_lost := lost_min_v::numeric / GREATEST(1, pumps_operated_v);
    eff := 100 - penalty_peak - penalty_lost;
    IF eff < 0 THEN eff := 0; END IF;
    IF eff > 100 THEN eff := 100; END IF;
  END IF;

  INSERT INTO energy_efficiency_daily
    (farm_id, date, pre_peak_shutdown_time, post_peak_startup_time,
     lost_minutes, pumps_on_during_peak, efficiency_percent,
     pumps_operated, minutes_on_during_peak, pre_peak_ok_count, post_peak_ok_count, updated_at)
  VALUES (_farm_id, _date, pre_off_v, post_on_v, lost_min_v, pumps_peak_v, eff,
          pumps_operated_v, minutes_peak_v, pre_ok_v, post_ok_v, now())
  ON CONFLICT (farm_id, date) DO UPDATE SET
    pre_peak_shutdown_time = EXCLUDED.pre_peak_shutdown_time,
    post_peak_startup_time = EXCLUDED.post_peak_startup_time,
    lost_minutes           = EXCLUDED.lost_minutes,
    pumps_on_during_peak   = EXCLUDED.pumps_on_during_peak,
    efficiency_percent     = EXCLUDED.efficiency_percent,
    pumps_operated         = EXCLUDED.pumps_operated,
    minutes_on_during_peak = EXCLUDED.minutes_on_during_peak,
    pre_peak_ok_count      = EXCLUDED.pre_peak_ok_count,
    post_peak_ok_count     = EXCLUDED.post_peak_ok_count,
    updated_at             = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.get_energy_efficiency_summary(_farm_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tz text;
  today_local date;
  row energy_efficiency_daily%ROWTYPE;
  avg_7 numeric;
  avg_30 numeric;
BEGIN
  IF NOT (has_farm_access(auth.uid(), _farm_id) OR is_platform_staff(auth.uid())) THEN
    RETURN jsonb_build_object('error','forbidden');
  END IF;

  SELECT COALESCE(timezone,'America/Sao_Paulo') INTO tz FROM farms WHERE id = _farm_id;
  today_local := (now() AT TIME ZONE tz)::date;

  SELECT * INTO row FROM energy_efficiency_daily
   WHERE farm_id = _farm_id AND date = today_local;

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
    'efficiency_percent', COALESCE(row.efficiency_percent, 100),
    'pre_peak_shutdown_time', row.pre_peak_shutdown_time,
    'post_peak_startup_time', row.post_peak_startup_time,
    'lost_minutes', COALESCE(row.lost_minutes, 0),
    'pumps_on_during_peak', COALESCE(row.pumps_on_during_peak, 0),
    'pumps_operated', COALESCE(row.pumps_operated, 0),
    'minutes_on_during_peak', COALESCE(row.minutes_on_during_peak, 0),
    'pre_peak_ok_count', COALESCE(row.pre_peak_ok_count, 0),
    'post_peak_ok_count', COALESCE(row.post_peak_ok_count, 0),
    'avg_7d', avg_7,
    'avg_30d', avg_30
  );
END;
$$;
