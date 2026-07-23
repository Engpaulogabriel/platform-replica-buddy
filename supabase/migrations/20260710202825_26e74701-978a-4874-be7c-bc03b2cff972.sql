CREATE OR REPLACE FUNCTION public.calculate_energy_efficiency_pumps_for_date(_farm_id uuid, _date date)
 RETURNS TABLE(equipment_id uuid, equipment_name text, first_on timestamp with time zone, late_min integer, last_off timestamp with time zone, early_off_min integer, mode text, peak_minutes integer, post_status text, pre_status text, peak_violation boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  tz text;
  cycle_start timestamptz;
  cycle_end timestamptz;
  effective_peak_end timestamptz;
  peak_start timestamptz;
  peak_end timestamptz;
  post_window_end timestamptz;
  pre_window_start timestamptz;
  pre_target timestamptz;
  peak_start_local time := time '18:00';
  peak_end_local   time := time '21:00';
  is_free boolean;
BEGIN
  SELECT COALESCE(timezone,'America/Sao_Paulo') INTO tz FROM public.farms WHERE id = _farm_id;
  IF tz IS NULL THEN RETURN; END IF;

  SELECT COALESCE(peak_hour_start, time '18:00'),
         COALESCE(peak_hour_end,   time '21:00')
    INTO peak_start_local, peak_end_local
    FROM public.farm_productivity_config WHERE farm_id = _farm_id;

  is_free := public.is_free_demand_day(_date, _farm_id);

  IF is_free THEN
    cycle_start := ((_date::text || ' 00:00:00')::timestamp AT TIME ZONE tz);
    cycle_end   := (((_date + 1)::text || ' 00:00:00')::timestamp AT TIME ZONE tz);
    peak_start  := cycle_start;
    peak_end    := cycle_start;
  ELSE
    cycle_start := (((_date - 1)::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz);
    peak_start  := ((_date::text || ' ' || peak_start_local::text)::timestamp AT TIME ZONE tz);
    peak_end    := ((_date::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz);
    cycle_end   := peak_end;
  END IF;
  effective_peak_end := LEAST(peak_end, now());
  post_window_end   := cycle_start + interval '3 hours';    -- 21:00 -> 00:00
  pre_window_start  := peak_start - interval '2 hours';
  pre_target        := peak_start - interval '15 minutes';

  RETURN QUERY
  WITH pump_equipment AS (
    SELECT e.id, e.name, e.saida, e.local_ack_at
      FROM public.equipments e
     WHERE e.farm_id = _farm_id AND e.active = true
       AND e.type::text IN ('poco','bombeamento','conjunto','rio')
       AND COALESCE(e.participates_night_cycle, true) = true
  ),
  runtime_sessions AS (
    SELECT pr.equipment_id,
           pr.started_at,
           COALESCE(pr.ended_at, now()) AS ended_at
      FROM public.pump_runtime pr
      JOIN pump_equipment pe ON pe.id = pr.equipment_id
     WHERE pr.farm_id = _farm_id
       AND pr.started_at < cycle_end
       AND COALESCE(pr.ended_at, now()) > cycle_start
  ),
  clamped_sessions AS (
    SELECT equipment_id,
           GREATEST(started_at, cycle_start) AS on_at,
           LEAST(ended_at, cycle_end)        AS off_at,
           started_at                        AS raw_started,
           ended_at                          AS raw_ended
      FROM runtime_sessions
     WHERE LEAST(ended_at, cycle_end) > GREATEST(started_at, cycle_start)
  ),
  operated_in_cycle AS (SELECT DISTINCT equipment_id FROM clamped_sessions),
  first_post_on AS (
    SELECT equipment_id, MIN(raw_started) AS first_on
      FROM clamped_sessions
     WHERE NOT is_free
       AND raw_started >= cycle_start
       AND raw_started <  post_window_end
     GROUP BY equipment_id
  ),
  last_off_pre AS (
    SELECT equipment_id, MAX(raw_ended) AS last_off
      FROM clamped_sessions
     WHERE NOT is_free
       AND raw_ended >= pre_window_start
       AND raw_ended <= peak_start
       AND raw_ended IN (SELECT ended_at FROM runtime_sessions WHERE ended_at < now())
     GROUP BY equipment_id
  ),
  first_cycle_on_free AS (
    SELECT equipment_id, MIN(on_at) AS first_on
      FROM clamped_sessions
     GROUP BY equipment_id
  ),
  peak_per_pump AS (
    SELECT h.equipment_id, h.peak_minutes
      FROM public.calculate_pump_peak_minutes_for_window(_farm_id, peak_start, effective_peak_end) h
     WHERE NOT is_free AND effective_peak_end > peak_start
  )
  SELECT
    pe.id, pe.name,
    CASE WHEN is_free THEN fcf.first_on ELSE fpo.first_on END,
    CASE
      WHEN is_free THEN 0
      WHEN fpo.first_on IS NULL THEN 0
      ELSE GREATEST(0, FLOOR(EXTRACT(epoch FROM (fpo.first_on - cycle_start))/60))::int
    END,
    CASE WHEN is_free THEN NULL ELSE lop.last_off END,
    CASE
      WHEN is_free THEN 0
      WHEN lop.last_off IS NULL THEN 0
      WHEN lop.last_off >= pre_target THEN 0
      ELSE GREATEST(0, FLOOR(EXTRACT(epoch FROM (pre_target - lop.last_off))/60))::int
    END,
    CASE
      WHEN COALESCE(pe.local_ack_at, 'epoch'::timestamptz) > cycle_start THEN 'local'
      ELSE 'remote'
    END,
    CASE WHEN is_free THEN 0 ELSE COALESCE(pk.peak_minutes, 0) END,
    CASE
      WHEN is_free THEN 'ok'
      WHEN fpo.first_on IS NULL THEN 'ok'
      WHEN GREATEST(0, FLOOR(EXTRACT(epoch FROM (fpo.first_on - cycle_start))/60))::int > 8 THEN 'late'
      ELSE 'ok'
    END,
    CASE
      WHEN is_free THEN 'ok'
      WHEN lop.last_off IS NULL THEN 'ok'
      WHEN lop.last_off >= pre_target THEN 'ok'
      ELSE 'early'
    END,
    CASE WHEN is_free THEN false ELSE COALESCE(pk.peak_minutes, 0) > 0 END
  FROM pump_equipment pe
  JOIN operated_in_cycle oi ON oi.equipment_id = pe.id
  LEFT JOIN first_post_on fpo       ON fpo.equipment_id = pe.id
  LEFT JOIN last_off_pre lop        ON lop.equipment_id = pe.id
  LEFT JOIN first_cycle_on_free fcf ON fcf.equipment_id = pe.id
  LEFT JOIN peak_per_pump pk        ON pk.equipment_id = pe.id;
END;
$function$;

-- Recompute last 31 days for all farms
DO $$
DECLARE
  d date;
BEGIN
  FOR d IN SELECT (CURRENT_DATE - i)::date FROM generate_series(0, 30) i LOOP
    PERFORM public.compute_all_energy_efficiency(d);
  END LOOP;
END $$;