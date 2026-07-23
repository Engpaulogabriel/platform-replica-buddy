CREATE OR REPLACE FUNCTION public.calculate_energy_efficiency_for_date(_farm_id uuid, _date date)
RETURNS TABLE(
  cycle_date date,
  efficiency_percent numeric,
  pumps_operated integer,
  post_peak_startup_time timestamptz,
  pre_peak_shutdown_time timestamptz,
  lost_minutes integer,
  pumps_on_during_peak integer,
  minutes_on_during_peak integer,
  pre_peak_ok_count integer,
  post_peak_ok_count integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  tz text;
  cycle_start timestamptz;
  peak_start timestamptz;
  peak_end timestamptz;
  cycle_end timestamptz;
  peak_start_local time := time '18:00';
  peak_end_local   time := time '21:00';
  is_free boolean;
BEGIN
  SELECT COALESCE(f.timezone,'America/Sao_Paulo') INTO tz
    FROM public.farms f
   WHERE f.id = _farm_id;
  IF tz IS NULL THEN RETURN; END IF;

  SELECT
    COALESCE((SELECT fpc.peak_hour_start FROM public.farm_productivity_config fpc WHERE fpc.farm_id = _farm_id LIMIT 1), time '18:00'),
    COALESCE((SELECT fpc.peak_hour_end   FROM public.farm_productivity_config fpc WHERE fpc.farm_id = _farm_id LIMIT 1), time '21:00')
    INTO peak_start_local, peak_end_local;

  is_free := public.is_free_demand_day(_date, _farm_id);

  IF is_free THEN
    cycle_start := ((_date::text || ' 00:00:00')::timestamp AT TIME ZONE tz);
    cycle_end   := (((_date + 1)::text || ' 00:00:00')::timestamp AT TIME ZONE tz);

    RETURN QUERY
    WITH pump_equipment AS (
      SELECT e.id, e.name, e.saida
        FROM public.equipments e
       WHERE e.farm_id = _farm_id
         AND e.active = true
         AND e.type::text IN ('poco','bombeamento','conjunto','rio')
         AND COALESCE(e.participates_night_cycle, true) = true
    ),
    raw_events AS (
      SELECT al.equipment_id, al.occurred_at AS event_at, al.action
        FROM public.automation_log al
        JOIN pump_equipment pe ON pe.id = al.equipment_id
       WHERE al.farm_id = _farm_id
         AND al.result = 'success'
         AND al.action IN ('turn_on','turn_off')
         AND al.occurred_at < cycle_end
      UNION ALL
      SELECT c.equipment_id,
             COALESCE(c.responded_at, c.sent_at, c.created_at) AS event_at,
             public.infer_pump_action_from_command_frame(c.frame, pe.saida) AS action
        FROM public.commands c
        JOIN pump_equipment pe ON pe.id = c.equipment_id
       WHERE c.farm_id = _farm_id
         AND c.type = 'manual'::public.command_type
         AND c.status = 'executed'::public.command_status
         AND COALESCE(c.responded_at, c.sent_at, c.created_at) < cycle_end
         AND public.infer_pump_action_from_command_frame(c.frame, pe.saida) IN ('turn_on','turn_off')
    ),
    last_before AS (
      SELECT DISTINCT ON (equipment_id) equipment_id, event_at, action
        FROM raw_events
       WHERE event_at < cycle_start
       ORDER BY equipment_id, event_at DESC
    ),
    carry_on AS (
      SELECT equipment_id, cycle_start AS event_at, 'turn_on'::public.event_action AS action
        FROM last_before
       WHERE action = 'turn_on'::public.event_action
    ),
    period_events AS (
      SELECT equipment_id, event_at, action
        FROM raw_events
       WHERE event_at >= cycle_start AND event_at < cycle_end
    ),
    timeline_base AS (
      SELECT * FROM carry_on
      UNION ALL
      SELECT * FROM period_events
    ),
    ordered_events AS (
      SELECT equipment_id, event_at, action,
             LAG(action) OVER (PARTITION BY equipment_id ORDER BY event_at, action::text) AS prev_action
        FROM timeline_base
    ),
    state_events AS (
      SELECT equipment_id, event_at, action
        FROM ordered_events
       WHERE prev_action IS NULL OR prev_action <> action
    ),
    ranked AS (
      SELECT equipment_id, event_at, action,
             LEAD(event_at) OVER (PARTITION BY equipment_id ORDER BY event_at, action::text) AS next_at,
             LEAD(action) OVER (PARTITION BY equipment_id ORDER BY event_at, action::text) AS next_action
        FROM state_events
    ),
    sessions AS (
      SELECT equipment_id,
             event_at AS on_at,
             CASE WHEN next_action = 'turn_off'::public.event_action THEN next_at ELSE cycle_end END AS off_at
        FROM ranked
       WHERE action = 'turn_on'::public.event_action
    ),
    valid_sessions AS (
      SELECT equipment_id, on_at, off_at
        FROM sessions
       WHERE off_at > on_at
         AND off_at > cycle_start
         AND on_at < cycle_end
    ),
    operated_in_cycle AS (
      SELECT DISTINCT equipment_id
        FROM valid_sessions
       WHERE off_at > cycle_start AND on_at < cycle_end
    ),
    first_cycle_on AS (
      SELECT equipment_id, MIN(GREATEST(on_at, cycle_start)) AS first_on
        FROM valid_sessions
       WHERE equipment_id IN (SELECT equipment_id FROM operated_in_cycle)
       GROUP BY equipment_id
    ),
    pump_span AS (
      SELECT equipment_id, MIN(on_at) AS first_on, MAX(off_at) AS last_off
        FROM valid_sessions
       WHERE equipment_id IN (SELECT equipment_id FROM operated_in_cycle)
       GROUP BY equipment_id
    ),
    pump_on_total AS (
      SELECT equipment_id, SUM(EXTRACT(epoch FROM (off_at - on_at))/60.0) AS on_minutes
        FROM valid_sessions
       WHERE equipment_id IN (SELECT equipment_id FROM operated_in_cycle)
       GROUP BY equipment_id
    ),
    pump_gaps AS (
      SELECT s.equipment_id,
             GREATEST(0,
               EXTRACT(epoch FROM (s.last_off - s.first_on))/60.0
               - COALESCE(t.on_minutes, 0)
               - COALESCE(public.pump_lock_overlap_minutes(_farm_id, s.equipment_id, s.first_on, s.last_off), 0)
             ) AS gap_minutes
        FROM pump_span s
        LEFT JOIN pump_on_total t ON t.equipment_id = s.equipment_id
    ),
    metrics AS (
      SELECT
        COUNT(DISTINCT oi.equipment_id)::int AS pumps_v,
        COALESCE((SELECT FLOOR(SUM(gap_minutes))::int FROM pump_gaps), 0) AS gap_min_v
        FROM operated_in_cycle oi
    )
    SELECT
      _date AS cycle_date,
      CASE WHEN COALESCE(m.pumps_v, 0) = 0 THEN NULL::numeric
           ELSE ROUND(GREATEST(0::numeric, LEAST(100::numeric,
             100::numeric - (COALESCE(m.gap_min_v, 0)::numeric * 100::numeric / GREATEST(1::numeric, COALESCE(m.pumps_v, 0)::numeric * 1440::numeric))
           )), 1)
      END AS efficiency_percent,
      COALESCE(m.pumps_v, 0)::int AS pumps_operated,
      NULL::timestamptz AS post_peak_startup_time,
      NULL::timestamptz AS pre_peak_shutdown_time,
      COALESCE(m.gap_min_v, 0)::int AS lost_minutes,
      0::int AS pumps_on_during_peak,
      0::int AS minutes_on_during_peak,
      COALESCE(m.pumps_v, 0)::int AS pre_peak_ok_count,
      COALESCE(m.pumps_v, 0)::int AS post_peak_ok_count
    FROM metrics m;
    RETURN;
  END IF;

  cycle_start := (((_date - 1)::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz);
  peak_start  := ((_date::text || ' ' || peak_start_local::text)::timestamp AT TIME ZONE tz);
  peak_end    := ((_date::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz);
  cycle_end   := peak_end;

  RETURN QUERY
  WITH pump_equipment AS (
    SELECT e.id, e.name, e.saida
      FROM public.equipments e
     WHERE e.farm_id = _farm_id AND e.active = true
       AND e.type::text IN ('poco','bombeamento','conjunto','rio')
       AND COALESCE(e.participates_night_cycle, true) = true
  ),
  scheduled_for_cycle AS (
    SELECT DISTINCT s.equipment_id
      FROM public.automation_schedules s
      JOIN pump_equipment pe ON pe.id = s.equipment_id
     WHERE s.farm_id = _farm_id AND s.active = true AND s.equipment_id IS NOT NULL
       AND s.time_on IS NOT NULL AND btrim(s.time_on) <> ''
       AND (
         (NULLIF(btrim(s.time_on),'')::time) >= peak_end_local
         OR (NULLIF(btrim(s.time_on),'')::time) < peak_start_local
       )
  ),
  raw_events AS (
    SELECT al.equipment_id, al.occurred_at AS event_at, al.action
      FROM public.automation_log al JOIN pump_equipment pe ON pe.id = al.equipment_id
     WHERE al.farm_id = _farm_id AND al.result = 'success'
       AND al.action IN ('turn_on','turn_off') AND al.occurred_at < cycle_end
    UNION ALL
    SELECT c.equipment_id, COALESCE(c.responded_at, c.sent_at, c.created_at),
           public.infer_pump_action_from_command_frame(c.frame, pe.saida)
      FROM public.commands c JOIN pump_equipment pe ON pe.id = c.equipment_id
     WHERE c.farm_id = _farm_id AND c.type = 'manual'::public.command_type
       AND c.status = 'executed'::public.command_status
       AND COALESCE(c.responded_at, c.sent_at, c.created_at) < cycle_end
       AND public.infer_pump_action_from_command_frame(c.frame, pe.saida) IN ('turn_on','turn_off')
  ),
  last_before AS (
    SELECT DISTINCT ON (equipment_id) equipment_id, event_at, action
      FROM raw_events WHERE event_at < cycle_start
     ORDER BY equipment_id, event_at DESC
  ),
  carry_on AS (
    SELECT equipment_id, cycle_start AS event_at, 'turn_on'::public.event_action AS action
      FROM last_before WHERE action = 'turn_on'::public.event_action
  ),
  period_events AS (
    SELECT equipment_id, event_at, action FROM raw_events
     WHERE event_at >= cycle_start AND event_at < cycle_end
  ),
  timeline_base AS (SELECT * FROM carry_on UNION ALL SELECT * FROM period_events),
  ordered_events AS (
    SELECT equipment_id, event_at, action,
           LAG(action) OVER (PARTITION BY equipment_id ORDER BY event_at, action::text) AS prev_action
      FROM timeline_base
  ),
  state_events AS (
    SELECT equipment_id, event_at, action FROM ordered_events
     WHERE prev_action IS NULL OR prev_action <> action
  ),
  ranked AS (
    SELECT equipment_id, event_at, action,
           LEAD(event_at) OVER (PARTITION BY equipment_id ORDER BY event_at, action::text) AS next_at,
           LEAD(action) OVER (PARTITION BY equipment_id ORDER BY event_at, action::text) AS next_action
      FROM state_events
  ),
  sessions AS (
    SELECT equipment_id, event_at AS on_at,
           CASE WHEN next_action = 'turn_off'::public.event_action THEN next_at ELSE cycle_end END AS off_at
      FROM ranked WHERE action = 'turn_on'::public.event_action
  ),
  valid_sessions AS (
    SELECT equipment_id, on_at, off_at FROM sessions
     WHERE off_at > on_at AND off_at > cycle_start AND on_at < cycle_end
  ),
  operated_in_cycle AS (
    SELECT DISTINCT equipment_id FROM valid_sessions
     WHERE off_at > cycle_start AND on_at < peak_start
  ),
  cycle_universe AS (
    SELECT equipment_id FROM operated_in_cycle
    UNION
    SELECT equipment_id FROM scheduled_for_cycle
  ),
  first_cycle_on AS (
    SELECT equipment_id, MIN(GREATEST(on_at, cycle_start)) AS first_on
      FROM valid_sessions
     WHERE off_at > cycle_start AND on_at < peak_start
     GROUP BY equipment_id
  ),
  post_per_pump AS (
    SELECT cu.equipment_id, fco.first_on,
           CASE
             WHEN fco.first_on IS NULL THEN 540
             ELSE LEAST(540, GREATEST(0, FLOOR(EXTRACT(epoch FROM (fco.first_on - cycle_start))/60))::int)
           END AS late_min
      FROM cycle_universe cu
      LEFT JOIN first_cycle_on fco ON fco.equipment_id = cu.equipment_id
  ),
  pump_span AS (
    SELECT equipment_id, MIN(on_at) AS first_on, MAX(off_at) AS last_off
      FROM valid_sessions
     WHERE equipment_id IN (SELECT equipment_id FROM operated_in_cycle)
     GROUP BY equipment_id
  ),
  pump_on_total AS (
    SELECT equipment_id, SUM(EXTRACT(epoch FROM (off_at - on_at))/60.0) AS on_minutes
      FROM valid_sessions
     WHERE equipment_id IN (SELECT equipment_id FROM operated_in_cycle)
     GROUP BY equipment_id
  ),
  pump_gaps AS (
    SELECT s.equipment_id,
           GREATEST(0,
             EXTRACT(epoch FROM (s.last_off - s.first_on))/60.0
             - COALESCE(t.on_minutes, 0)
             - COALESCE(public.pump_lock_overlap_minutes(_farm_id, s.equipment_id, s.first_on, s.last_off), 0)
           ) AS gap_minutes
      FROM pump_span s LEFT JOIN pump_on_total t ON t.equipment_id = s.equipment_id
  ),
  peak_sessions AS (
    SELECT equipment_id,
           GREATEST(on_at, peak_start) AS peak_lo,
           LEAST(off_at, peak_end) AS peak_hi
      FROM valid_sessions
     WHERE off_at > peak_start AND on_at < peak_end
  ),
  peak_per_pump AS (
    SELECT equipment_id,
           SUM(GREATEST(0, EXTRACT(epoch FROM (peak_hi - peak_lo))/60)) AS peak_minutes
      FROM peak_sessions
     GROUP BY equipment_id
    HAVING SUM(GREATEST(0, EXTRACT(epoch FROM (peak_hi - peak_lo))/60)) > 0
  ),
  metrics AS (
    SELECT
      COUNT(DISTINCT cu.equipment_id)::int AS pumps_operated_v,
      MIN(pp.first_on) AS post_on_v,
      COALESCE(SUM(pp.late_min), 0)::int AS post_lost_pump_min_v,
      COALESCE((SELECT FLOOR(SUM(gap_minutes))::int FROM pump_gaps), 0) AS gap_min_v,
      COALESCE((SELECT COUNT(*)::int FROM peak_per_pump), 0) AS pumps_peak_v,
      COALESCE((SELECT FLOOR(SUM(peak_minutes))::int FROM peak_per_pump), 0) AS minutes_peak_v,
      COALESCE((SELECT MAX(event_at) FROM period_events
                 WHERE action = 'turn_off'::public.event_action
                   AND event_at >= peak_start - interval '30 minutes'
                   AND event_at < peak_start + interval '10 minutes'), NULL) AS pre_off_v,
      COALESCE((SELECT COUNT(DISTINCT equipment_id)::int FROM valid_sessions
                 WHERE on_at < peak_start AND off_at <= peak_start), 0) AS pre_ok_v,
      COALESCE((SELECT COUNT(*)::int FROM post_per_pump
                 WHERE first_on IS NOT NULL AND late_min <= 8), 0) AS post_ok_v
    FROM cycle_universe cu LEFT JOIN post_per_pump pp ON pp.equipment_id = cu.equipment_id
  )
  SELECT
    _date AS cycle_date,
    CASE WHEN COALESCE(m.pumps_operated_v, 0) = 0 THEN NULL::numeric
    ELSE ROUND(GREATEST(0::numeric, LEAST(100::numeric,
      100::numeric - ((COALESCE(m.post_lost_pump_min_v, 0) + COALESCE(m.gap_min_v, 0) + COALESCE(m.minutes_peak_v, 0))::numeric
        * 100::numeric / GREATEST(1::numeric, COALESCE(m.pumps_operated_v, 0)::numeric * 1260::numeric))
    )), 1) END AS efficiency_percent,
    COALESCE(m.pumps_operated_v, 0)::int AS pumps_operated,
    m.post_on_v AS post_peak_startup_time,
    m.pre_off_v AS pre_peak_shutdown_time,
    (COALESCE(m.post_lost_pump_min_v, 0) + COALESCE(m.gap_min_v, 0) + COALESCE(m.minutes_peak_v, 0))::int AS lost_minutes,
    COALESCE(m.pumps_peak_v, 0)::int AS pumps_on_during_peak,
    COALESCE(m.minutes_peak_v, 0)::int AS minutes_on_during_peak,
    COALESCE(m.pre_ok_v, 0)::int AS pre_peak_ok_count,
    COALESCE(m.post_ok_v, 0)::int AS post_peak_ok_count
  FROM metrics m;
END;
$function$;

CREATE OR REPLACE FUNCTION public.compute_energy_efficiency(_farm_id uuid, _date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  is_free boolean;
BEGIN
  is_free := public.is_free_demand_day(_date, _farm_id);

  SELECT * INTO r
  FROM public.calculate_energy_efficiency_for_date(_farm_id, _date)
  LIMIT 1;

  IF r.cycle_date IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.energy_efficiency_daily
    (farm_id, date, pre_peak_shutdown_time, post_peak_startup_time,
     lost_minutes, pumps_on_during_peak, efficiency_percent,
     pumps_operated, minutes_on_during_peak, pre_peak_ok_count, post_peak_ok_count,
     is_free_demand, updated_at)
  VALUES (
    _farm_id,
    r.cycle_date,
    CASE WHEN is_free THEN NULL ELSE r.pre_peak_shutdown_time END,
    CASE WHEN is_free THEN NULL ELSE r.post_peak_startup_time END,
    r.lost_minutes,
    CASE WHEN is_free THEN 0 ELSE r.pumps_on_during_peak END,
    COALESCE(r.efficiency_percent, 100),
    r.pumps_operated,
    CASE WHEN is_free THEN 0 ELSE r.minutes_on_during_peak END,
    CASE WHEN is_free THEN r.pumps_operated ELSE r.pre_peak_ok_count END,
    CASE WHEN is_free THEN r.pumps_operated ELSE r.post_peak_ok_count END,
    is_free,
    now()
  )
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
    is_free_demand         = EXCLUDED.is_free_demand,
    updated_at             = now();

  DELETE FROM public.energy_efficiency_daily_pumps
   WHERE farm_id = _farm_id AND date = _date;

  INSERT INTO public.energy_efficiency_daily_pumps
    (farm_id, date, equipment_id, equipment_name, first_on, late_min,
     last_off, early_off_min, mode, peak_minutes,
     post_status, pre_status, peak_violation, updated_at)
  SELECT _farm_id,
         _date,
         p.equipment_id,
         p.equipment_name,
         p.first_on,
         CASE WHEN is_free THEN 0 ELSE p.late_min END,
         CASE WHEN is_free THEN NULL ELSE p.last_off END,
         CASE WHEN is_free THEN 0 ELSE p.early_off_min END,
         p.mode,
         CASE WHEN is_free THEN 0 ELSE p.peak_minutes END,
         CASE WHEN is_free THEN 'ok' ELSE p.post_status END,
         CASE WHEN is_free THEN 'ok' ELSE p.pre_status END,
         CASE WHEN is_free THEN false ELSE p.peak_violation END,
         now()
    FROM public.calculate_energy_efficiency_pumps_for_date(_farm_id, _date) p;
END;
$function$;

DO $$
DECLARE
  farm_row record;
  recalc_date date;
  today_local date;
BEGIN
  FOR farm_row IN SELECT id, COALESCE(timezone, 'America/Sao_Paulo') AS tz FROM public.farms LOOP
    today_local := (now() AT TIME ZONE farm_row.tz)::date;
    FOR recalc_date IN
      SELECT generate_series(today_local - 30, today_local - 1, interval '1 day')::date
    LOOP
      PERFORM public.compute_energy_efficiency(farm_row.id, recalc_date);
    END LOOP;
  END LOOP;
END $$;