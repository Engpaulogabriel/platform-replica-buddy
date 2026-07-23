CREATE OR REPLACE FUNCTION public.calculate_energy_efficiency_for_date(_farm_id uuid, _date date)
 RETURNS TABLE(cycle_date date, efficiency_percent numeric, pumps_operated integer, post_peak_startup_time timestamp with time zone, pre_peak_shutdown_time timestamp with time zone, lost_minutes integer, pumps_on_during_peak integer, minutes_on_during_peak integer, pre_peak_ok_count integer, post_peak_ok_count integer)
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
  SELECT COALESCE(f.timezone,'America/Sao_Paulo') INTO tz FROM public.farms f WHERE f.id = _farm_id;
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
    peak_end    := ((_date::text || ' ' || peak_end_local::text)::timestamp   AT TIME ZONE tz);
    cycle_end   := peak_end;
  END IF;

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
     WHERE off_at > cycle_start AND on_at < CASE WHEN is_free THEN cycle_end ELSE peak_start END
  ),
  cycle_universe AS (
    SELECT equipment_id FROM operated_in_cycle
    UNION
    SELECT equipment_id FROM scheduled_for_cycle WHERE NOT is_free
  ),
  first_cycle_on AS (
    SELECT equipment_id, MIN(GREATEST(on_at, cycle_start)) AS first_on
      FROM valid_sessions
     WHERE off_at > cycle_start AND on_at < CASE WHEN is_free THEN cycle_end ELSE peak_start END
     GROUP BY equipment_id
  ),
  post_per_pump AS (
    SELECT cu.equipment_id, fco.first_on,
           CASE
             WHEN is_free THEN 0
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
     WHERE NOT is_free AND off_at > peak_start AND on_at < peak_end
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
                 WHERE NOT is_free
                   AND action = 'turn_off'::public.event_action
                   AND event_at >= peak_start - interval '30 minutes'
                   AND event_at < peak_start + interval '10 minutes'), NULL) AS pre_off_v,
      COALESCE((SELECT COUNT(DISTINCT equipment_id)::int FROM valid_sessions
                 WHERE NOT is_free AND on_at < peak_start AND off_at <= peak_start), 0) AS pre_ok_v,
      COALESCE((SELECT COUNT(*)::int FROM post_per_pump
                 WHERE is_free OR (first_on IS NOT NULL AND late_min <= 8)), 0) AS post_ok_v
    FROM cycle_universe cu LEFT JOIN post_per_pump pp ON pp.equipment_id = cu.equipment_id
  )
  SELECT
    _date AS cycle_date,
    CASE WHEN COALESCE(m.pumps_operated_v, 0) = 0 THEN NULL::numeric
    ELSE ROUND(GREATEST(0::numeric, LEAST(100::numeric,
      100::numeric - (
        (CASE WHEN is_free THEN COALESCE(m.gap_min_v, 0)
              ELSE COALESCE(m.post_lost_pump_min_v, 0) + COALESCE(m.gap_min_v, 0) + COALESCE(m.minutes_peak_v, 0)
         END)::numeric
        * 100::numeric / GREATEST(1::numeric, COALESCE(m.pumps_operated_v, 0)::numeric * CASE WHEN is_free THEN 1440::numeric ELSE 1260::numeric END)
      )
    )), 1) END AS efficiency_percent,
    COALESCE(m.pumps_operated_v, 0)::int AS pumps_operated,
    CASE WHEN is_free THEN NULL ELSE m.post_on_v END AS post_peak_startup_time,
    CASE WHEN is_free THEN NULL ELSE m.pre_off_v END AS pre_peak_shutdown_time,
    (CASE WHEN is_free THEN COALESCE(m.gap_min_v, 0)
          ELSE COALESCE(m.post_lost_pump_min_v, 0) + COALESCE(m.gap_min_v, 0) + COALESCE(m.minutes_peak_v, 0)
     END)::int AS lost_minutes,
    CASE WHEN is_free THEN 0 ELSE COALESCE(m.pumps_peak_v, 0) END::int AS pumps_on_during_peak,
    CASE WHEN is_free THEN 0 ELSE COALESCE(m.minutes_peak_v, 0) END::int AS minutes_on_during_peak,
    CASE WHEN is_free THEN COALESCE(m.pumps_operated_v, 0) ELSE COALESCE(m.pre_ok_v, 0) END::int AS pre_peak_ok_count,
    CASE WHEN is_free THEN COALESCE(m.pumps_operated_v, 0) ELSE COALESCE(m.post_ok_v, 0) END::int AS post_peak_ok_count
  FROM metrics m;
END;
$function$;

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
  peak_start timestamptz;
  peak_end timestamptz;
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
  pre_target  := peak_start - interval '15 minutes';

  RETURN QUERY
  WITH pump_equipment AS (
    SELECT e.id, e.name, e.saida, e.local_ack_at
      FROM public.equipments e
     WHERE e.farm_id = _farm_id AND e.active = true
       AND e.type::text IN ('poco','bombeamento','conjunto','rio')
       AND COALESCE(e.participates_night_cycle, true) = true
  ),
  scheduled_for_cycle AS (
    SELECT DISTINCT s.equipment_id FROM public.automation_schedules s
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
    SELECT c.equipment_id, COALESCE(c.responded_at, c.sent_at, c.created_at) AS event_at,
           public.infer_pump_action_from_command_frame(c.frame, pe.saida) AS action
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
    SELECT equipment_id, on_at, off_at,
           EXTRACT(epoch FROM (off_at - on_at))/60.0 AS on_minutes
      FROM sessions
     WHERE off_at > on_at AND off_at > cycle_start AND on_at < cycle_end
  ),
  operated_in_cycle AS (SELECT DISTINCT equipment_id FROM valid_sessions),
  cycle_universe AS (
    SELECT equipment_id FROM operated_in_cycle
    UNION
    SELECT equipment_id FROM scheduled_for_cycle WHERE NOT is_free
  ),
  post_sessions AS (
    SELECT vs.equipment_id, vs.on_at, vs.off_at, vs.on_minutes
      FROM valid_sessions vs
     WHERE NOT is_free AND vs.on_at < LEAST(cycle_start + interval '9 hours', cycle_end) AND vs.off_at > cycle_start
  ),
  rule_a AS (SELECT DISTINCT equipment_id FROM post_sessions WHERE on_minutes >= 30),
  rule_b AS (
    SELECT equipment_id FROM post_sessions
     WHERE on_at < cycle_start + interval '6 hours'
     GROUP BY equipment_id
    HAVING SUM(EXTRACT(epoch FROM (LEAST(off_at, cycle_start + interval '6 hours') - GREATEST(on_at, cycle_start)))/60.0) >= 60
  ),
  qualified AS (SELECT equipment_id FROM rule_a UNION SELECT equipment_id FROM rule_b),
  first_valid_on AS (
    SELECT ps.equipment_id, MIN(GREATEST(ps.on_at, cycle_start)) AS first_on
      FROM post_sessions ps
     WHERE ps.equipment_id IN (SELECT equipment_id FROM qualified)
     GROUP BY ps.equipment_id
  ),
  first_cycle_on AS (
    SELECT vs.equipment_id, MIN(GREATEST(vs.on_at, cycle_start)) AS first_on
      FROM valid_sessions vs
     GROUP BY vs.equipment_id
  ),
  last_off_pre AS (
    SELECT equipment_id, MAX(off_at) AS last_off FROM valid_sessions
     WHERE NOT is_free AND off_at <= peak_start
     GROUP BY equipment_id
  ),
  peak_per_pump AS (
    SELECT equipment_id,
           SUM(GREATEST(0,
             EXTRACT(epoch FROM (LEAST(off_at, peak_end) - GREATEST(on_at, peak_start)))/60.0
           ))::int AS peak_minutes
      FROM valid_sessions
     WHERE NOT is_free AND off_at > peak_start AND on_at < peak_end
     GROUP BY equipment_id
  )
  SELECT
    pe.id AS equipment_id,
    pe.name AS equipment_name,
    CASE WHEN is_free THEN fco.first_on ELSE fvo.first_on END AS first_on,
    CASE
      WHEN is_free THEN 0
      WHEN fvo.first_on IS NULL THEN 540
      ELSE LEAST(540, GREATEST(0, FLOOR(EXTRACT(epoch FROM (fvo.first_on - cycle_start))/60))::int)
    END AS late_min,
    CASE WHEN is_free THEN NULL ELSE lop.last_off END AS last_off,
    CASE
      WHEN is_free THEN 0
      WHEN lop.last_off IS NULL THEN 0
      WHEN lop.last_off >= pre_target THEN 0
      ELSE GREATEST(0, FLOOR(EXTRACT(epoch FROM (pre_target - lop.last_off))/60))::int
    END AS early_off_min,
    CASE
      WHEN COALESCE(pe.local_ack_at, 'epoch'::timestamptz) > cycle_start THEN 'local'
      ELSE 'remote'
    END AS mode,
    CASE WHEN is_free THEN 0 ELSE COALESCE(pk.peak_minutes, 0) END AS peak_minutes,
    CASE
      WHEN is_free THEN 'ok'
      WHEN fvo.first_on IS NULL THEN 'not_started'
      WHEN LEAST(540, GREATEST(0, FLOOR(EXTRACT(epoch FROM (fvo.first_on - cycle_start))/60))::int) > 8 THEN 'late'
      ELSE 'ok'
    END AS post_status,
    CASE
      WHEN is_free THEN 'ok'
      WHEN lop.last_off IS NULL THEN 'no_off'
      WHEN lop.last_off >= pre_target THEN 'ok'
      ELSE 'early'
    END AS pre_status,
    CASE WHEN is_free THEN false ELSE COALESCE(pk.peak_minutes, 0) > 0 END AS peak_violation
  FROM pump_equipment pe
  JOIN cycle_universe cu ON cu.equipment_id = pe.id
  LEFT JOIN first_valid_on fvo ON fvo.equipment_id = pe.id
  LEFT JOIN first_cycle_on fco ON fco.equipment_id = pe.id
  LEFT JOIN last_off_pre lop  ON lop.equipment_id = pe.id
  LEFT JOIN peak_per_pump pk  ON pk.equipment_id = pe.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_energy_efficiency_summary(_farm_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  tz text;
  today_local date;
  now_local timestamp;
  cycle_start_local timestamp;
  cycle_start timestamptz;
  cycle_end timestamptz;
  post_window_end timestamptz;
  entry_window_end timestamptz;
  today_peak_start timestamptz;
  today_peak_end timestamptz;
  pre_peak_target timestamptz;
  peak_start_local time := time '18:00';
  peak_end_local   time := time '21:00';
  pumps_operated_v int := 0;
  pumps_running_now_v int := 0;
  pumps_peak_v int := 0;
  minutes_peak_v int := 0;
  post_lost_pump_min_v int := 0;
  post_lost_min_v int := 0;
  post_late_pumps_v int := 0;
  post_ok_v int := 0;
  post_pumps_seen_v int := 0;
  post_not_started_v int := 0;
  post_on_v timestamptz;
  post_last_on_v timestamptz;
  pre_lost_pump_min_v int := 0;
  pre_early_off_pumps_v int := 0;
  pre_local_pumps_v int := 0;
  pre_off_v timestamptz;
  pre_last_off_v timestamptz;
  pre_late_pumps_v int := 0;
  pre_avg_late_v int := 0;
  pre_ok_v int := 0;
  gap_min_v int := 0;
  gap_pumps_v int := 0;
  lost_pump_min_v int := 0;
  lost_pump_min_7d_v int := 0;
  lost_pump_min_30d_v int := 0;
  eff numeric := 100;
  avg_7 numeric;
  avg_30 numeric;
  in_or_after_today_peak boolean;
  after_today_peak boolean;
  cycle_capacity_min int;
  is_free_today boolean;
BEGIN
  IF NOT (has_farm_access(auth.uid(), _farm_id) OR is_platform_staff(auth.uid())) THEN
    RETURN jsonb_build_object('error','forbidden');
  END IF;

  SELECT COALESCE(timezone,'America/Sao_Paulo') INTO tz FROM farms WHERE id = _farm_id;
  IF tz IS NULL THEN RETURN jsonb_build_object('error','farm_not_found'); END IF;

  SELECT COALESCE(peak_hour_start, time '18:00'),
         COALESCE(peak_hour_end,   time '21:00')
    INTO peak_start_local, peak_end_local
    FROM farm_productivity_config WHERE farm_id = _farm_id;

  today_local := (now() AT TIME ZONE tz)::date;
  now_local := (now() AT TIME ZONE tz);
  is_free_today := public.is_free_demand_day(today_local, _farm_id);

  IF is_free_today THEN
    cycle_start_local := today_local::timestamp;
    cycle_start := cycle_start_local AT TIME ZONE tz;
    cycle_end := now();
    today_peak_start := ((today_local::text || ' ' || peak_start_local::text)::timestamp AT TIME ZONE tz);
    today_peak_end   := ((today_local::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz);
  ELSE
    cycle_start_local := CASE
      WHEN now_local::time >= peak_end_local THEN today_local::timestamp + peak_end_local
      ELSE (today_local - 1)::timestamp + peak_end_local
    END;
    cycle_start := cycle_start_local AT TIME ZONE tz;
    cycle_end := now();
    today_peak_start := (((cycle_start_local::date + 1)::text || ' ' || peak_start_local::text)::timestamp AT TIME ZONE tz);
    today_peak_end   := (((cycle_start_local::date + 1)::text || ' ' || peak_end_local::text)::timestamp   AT TIME ZONE tz);
  END IF;

  pre_peak_target  := today_peak_start - interval '15 minutes';
  post_window_end := cycle_start + interval '9 hours';
  entry_window_end := cycle_start + interval '6 hours';
  in_or_after_today_peak := now() >= today_peak_start;
  after_today_peak := now() >= cycle_start;

  WITH pump_equipment AS (
    SELECT e.id, e.name, e.saida, e.local_ack_at, e.desired_running, e.last_outputs_state
      FROM equipments e
     WHERE e.farm_id = _farm_id AND e.active = true
       AND e.type::text IN ('poco','bombeamento','conjunto','rio')
       AND COALESCE(e.participates_night_cycle, true) = true
  ),
  scheduled_for_cycle AS (
    SELECT DISTINCT s.equipment_id
      FROM automation_schedules s
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
      FROM automation_log al JOIN pump_equipment pe ON pe.id = al.equipment_id
     WHERE al.farm_id = _farm_id AND al.result = 'success'
       AND al.action IN ('turn_on','turn_off') AND al.occurred_at < cycle_end
    UNION ALL
    SELECT c.equipment_id, COALESCE(c.responded_at, c.sent_at, c.created_at),
           infer_pump_action_from_command_frame(c.frame, pe.saida)
      FROM commands c JOIN pump_equipment pe ON pe.id = c.equipment_id
     WHERE c.farm_id = _farm_id AND c.type = 'manual'::command_type
       AND c.status = 'executed'::command_status
       AND COALESCE(c.responded_at, c.sent_at, c.created_at) < cycle_end
       AND infer_pump_action_from_command_frame(c.frame, pe.saida) IN ('turn_on','turn_off')
  ),
  last_before AS (
    SELECT DISTINCT ON (equipment_id) equipment_id, event_at, action
      FROM raw_events WHERE event_at < cycle_start
     ORDER BY equipment_id, event_at DESC
  ),
  carry_on AS (
    SELECT equipment_id, cycle_start AS event_at, 'turn_on'::event_action AS action
      FROM last_before WHERE action = 'turn_on'::event_action
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
           CASE WHEN next_action = 'turn_off'::event_action THEN next_at ELSE cycle_end END AS off_at
      FROM ranked WHERE action = 'turn_on'::event_action
  ),
  valid_sessions AS (
    SELECT equipment_id, on_at, off_at,
           EXTRACT(epoch FROM (off_at - on_at))/60.0 AS on_minutes
      FROM sessions
     WHERE off_at > on_at AND off_at > cycle_start AND on_at < cycle_end
  ),
  operated_in_cycle AS (SELECT DISTINCT equipment_id FROM valid_sessions),
  cycle_universe AS (
    SELECT equipment_id FROM operated_in_cycle
    UNION
    SELECT equipment_id FROM scheduled_for_cycle WHERE NOT is_free_today
  ),
  post_sessions AS (
    SELECT vs.equipment_id, vs.on_at, vs.off_at, vs.on_minutes
      FROM valid_sessions vs
     WHERE NOT is_free_today AND vs.on_at < LEAST(post_window_end, cycle_end) AND vs.off_at > cycle_start
  ),
  rule_a AS (SELECT DISTINCT equipment_id FROM post_sessions WHERE on_minutes >= 30),
  rule_b AS (
    SELECT equipment_id FROM post_sessions
     WHERE on_at < entry_window_end
     GROUP BY equipment_id
    HAVING SUM(EXTRACT(epoch FROM (LEAST(off_at, entry_window_end) - GREATEST(on_at, cycle_start)))/60.0) >= 60
  ),
  qualified AS (SELECT equipment_id FROM rule_a UNION SELECT equipment_id FROM rule_b),
  first_valid_on AS (
    SELECT ps.equipment_id, MIN(GREATEST(ps.on_at, cycle_start)) AS first_on
      FROM post_sessions ps
     WHERE ps.equipment_id IN (SELECT equipment_id FROM qualified)
     GROUP BY ps.equipment_id
  ),
  post_per_pump AS (
    SELECT pe.id AS equipment_id, fvo.first_on,
           CASE WHEN is_free_today THEN 0
                WHEN fvo.first_on IS NULL THEN 540
                ELSE LEAST(540, GREATEST(0, FLOOR(EXTRACT(epoch FROM (fvo.first_on - cycle_start))/60))::int)
           END AS late_min,
           (NOT is_free_today AND fvo.first_on IS NULL) AS not_started
      FROM pump_equipment pe
      JOIN cycle_universe cu ON cu.equipment_id = pe.id
      LEFT JOIN first_valid_on fvo ON fvo.equipment_id = pe.id
  ),
  operated AS (
    SELECT DISTINCT equipment_id FROM valid_sessions
     WHERE off_at > cycle_start AND on_at < CASE WHEN is_free_today THEN cycle_end ELSE today_peak_start END
  ),
  pump_span AS (
    SELECT equipment_id, MIN(on_at) AS first_on, MAX(off_at) AS last_off
      FROM valid_sessions
     WHERE equipment_id IN (SELECT equipment_id FROM operated)
     GROUP BY equipment_id
  ),
  pump_on_total AS (
    SELECT equipment_id, SUM(EXTRACT(epoch FROM (off_at - on_at))/60.0) AS on_minutes
      FROM valid_sessions
     WHERE equipment_id IN (SELECT equipment_id FROM operated)
     GROUP BY equipment_id
  ),
  pump_gaps AS (
    SELECT s.equipment_id,
           GREATEST(0,
             EXTRACT(epoch FROM (s.last_off - s.first_on))/60.0
             - COALESCE(t.on_minutes, 0)
             - COALESCE(pump_lock_overlap_minutes(_farm_id, s.equipment_id, s.first_on, s.last_off), 0)
           ) AS gap_minutes
      FROM pump_span s LEFT JOIN pump_on_total t ON t.equipment_id = s.equipment_id
  ),
  peak_sessions AS (
    SELECT equipment_id,
           SUM(GREATEST(0,
             EXTRACT(epoch FROM (LEAST(off_at, today_peak_end) - GREATEST(on_at, today_peak_start)))/60.0
           )) AS peak_minutes
      FROM valid_sessions
     WHERE NOT is_free_today AND off_at > today_peak_start AND on_at < today_peak_end
     GROUP BY equipment_id
  ),
  peak_per_pump AS (SELECT equipment_id, peak_minutes FROM peak_sessions WHERE peak_minutes > 0)
  SELECT COALESCE(SUM(pp.late_min), 0)::int,
         COUNT(*) FILTER (WHERE pp.late_min > 8)::int,
         COALESCE(MAX(pp.late_min), 0)::int,
         MIN(pp.first_on), MAX(pp.first_on),
         COUNT(*) FILTER (WHERE pp.late_min <= 8 AND NOT pp.not_started)::int,
         COUNT(*)::int,
         COUNT(*) FILTER (WHERE pp.not_started)::int,
         COALESCE(FLOOR((SELECT SUM(gap_minutes) FROM pump_gaps))::int, 0),
         COALESCE((SELECT COUNT(*)::int FROM pump_gaps WHERE gap_minutes >= 1), 0),
         COALESCE((SELECT COUNT(*)::int FROM peak_per_pump), 0),
         COALESCE((SELECT FLOOR(SUM(peak_minutes))::int FROM peak_per_pump), 0)
    INTO post_lost_pump_min_v, post_late_pumps_v, post_lost_min_v,
         post_on_v, post_last_on_v,
         post_ok_v, post_pumps_seen_v, post_not_started_v,
         gap_min_v, gap_pumps_v,
         pumps_peak_v, minutes_peak_v
    FROM post_per_pump pp;

  SELECT COUNT(DISTINCT equipment_id) INTO pumps_operated_v
    FROM (
      SELECT equipment_id FROM automation_log
       WHERE farm_id = _farm_id AND action = 'turn_on' AND result = 'success'
         AND equipment_id IS NOT NULL AND occurred_at >= cycle_start AND occurred_at < cycle_end
    ) x;
  IF pumps_running_now_v > pumps_operated_v THEN pumps_operated_v := pumps_running_now_v; END IF;
  IF post_pumps_seen_v > pumps_operated_v THEN pumps_operated_v := post_pumps_seen_v; END IF;

  IF in_or_after_today_peak AND NOT is_free_today THEN
    SELECT MAX(occurred_at) INTO pre_off_v
      FROM automation_log
     WHERE farm_id = _farm_id AND action = 'turn_off' AND result = 'success'
       AND occurred_at >= cycle_start AND occurred_at < today_peak_start;

    WITH pe_pre AS (
      SELECT e.id, e.local_ack_at FROM equipments e
       WHERE e.farm_id = _farm_id AND e.active = true
         AND e.type::text IN ('poco','bombeamento','conjunto','rio')
         AND COALESCE(e.participates_night_cycle, true) = true
    ),
    last_off_pre AS (
      SELECT r.equipment_id, MAX(r.off_at) AS last_off
        FROM (
          SELECT al.equipment_id, al.occurred_at AS off_at,
                 ROW_NUMBER() OVER (PARTITION BY al.equipment_id ORDER BY al.occurred_at DESC) rn
            FROM automation_log al
           WHERE al.farm_id = _farm_id AND al.action = 'turn_off' AND al.result = 'success'
             AND al.occurred_at >= cycle_start AND al.occurred_at < today_peak_start
        ) r WHERE rn = 1
       GROUP BY r.equipment_id
    ),
    pre_calc AS (
      SELECT lop.equipment_id, lop.last_off,
             GREATEST(0, FLOOR(EXTRACT(epoch FROM (pre_peak_target - lop.last_off))/60))::int AS early_min,
             COALESCE(pe.local_ack_at, 'epoch'::timestamptz) > cycle_start AS is_local
        FROM last_off_pre lop JOIN pe_pre pe ON pe.id = lop.equipment_id
       WHERE lop.last_off < pre_peak_target
    )
    SELECT COALESCE(SUM(early_min), 0)::int, COUNT(*)::int,
           COUNT(*) FILTER (WHERE is_local)::int, MAX(last_off)
      INTO pre_lost_pump_min_v, pre_early_off_pumps_v, pre_local_pumps_v, pre_last_off_v
      FROM pre_calc;

    SELECT COUNT(DISTINCT equipment_id) INTO pre_ok_v
      FROM automation_log
     WHERE farm_id = _farm_id AND action = 'turn_off' AND result = 'success'
       AND equipment_id IS NOT NULL
       AND occurred_at >= pre_peak_target AND occurred_at < today_peak_start;

    pre_late_pumps_v := pumps_peak_v;
    pre_avg_late_v := CASE WHEN pumps_peak_v > 0 THEN (minutes_peak_v / pumps_peak_v)::int ELSE 0 END;
  END IF;

  IF is_free_today THEN
    pumps_peak_v := 0;
    minutes_peak_v := 0;
    post_lost_pump_min_v := 0;
    post_lost_min_v := 0;
    post_late_pumps_v := 0;
    post_not_started_v := 0;
    post_on_v := NULL;
    post_last_on_v := NULL;
    post_ok_v := pumps_operated_v;
    pre_lost_pump_min_v := 0;
    pre_early_off_pumps_v := 0;
    pre_local_pumps_v := 0;
    pre_late_pumps_v := 0;
    pre_avg_late_v := 0;
    pre_off_v := NULL;
    pre_last_off_v := NULL;
    pre_ok_v := pumps_operated_v;
  END IF;

  lost_pump_min_v := COALESCE(post_lost_pump_min_v,0) + COALESCE(gap_min_v,0)
                   + COALESCE(pre_lost_pump_min_v,0) + COALESCE(minutes_peak_v,0);

  cycle_capacity_min := GREATEST(pumps_operated_v, post_pumps_seen_v) * CASE WHEN is_free_today THEN 1440 ELSE 1260 END;
  IF pumps_operated_v = 0 THEN eff := NULL;
  ELSIF cycle_capacity_min > 0 THEN
    eff := ROUND(GREATEST(0::numeric, LEAST(100::numeric,
      100::numeric - (lost_pump_min_v::numeric * 100::numeric / cycle_capacity_min::numeric)
    )), 1);
  END IF;

  SELECT ROUND(AVG(h.efficiency_percent), 1), COALESCE(SUM(h.lost_minutes), 0)::int
    INTO avg_7, lost_pump_min_7d_v
    FROM public.get_energy_efficiency_history(_farm_id, 7) h
   WHERE h.pumps_operated > 0 AND h.efficiency_percent IS NOT NULL;

  SELECT ROUND(AVG(h.efficiency_percent), 1), COALESCE(SUM(h.lost_minutes), 0)::int
    INTO avg_30, lost_pump_min_30d_v
    FROM public.get_energy_efficiency_history(_farm_id, 30) h
   WHERE h.pumps_operated > 0 AND h.efficiency_percent IS NOT NULL;

  RETURN jsonb_build_object(
    'date', today_local,
    'efficiency_percent', eff,
    'pre_peak_shutdown_time', pre_off_v,
    'post_peak_startup_time', post_on_v,
    'lost_minutes', lost_pump_min_v,
    'lost_pump_minutes', lost_pump_min_v,
    'post_lost_minutes_today', post_lost_min_v,
    'post_lost_pump_minutes', post_lost_pump_min_v,
    'post_late_pumps', post_late_pumps_v,
    'post_not_started_pumps', post_not_started_v,
    'post_last_on', post_last_on_v,
    'post_tolerance_minutes', 8,
    'post_cap_minutes', 540,
    'peak_pump_minutes', minutes_peak_v,
    'gap_minutes_today', gap_min_v,
    'gap_pumps_today', gap_pumps_v,
    'pumps_on_during_peak', pumps_peak_v,
    'pumps_operated', pumps_operated_v,
    'pumps_in_cycle', pumps_operated_v,
    'pumps_running_now', pumps_running_now_v,
    'minutes_on_during_peak', minutes_peak_v,
    'pre_peak_ok_count', pre_ok_v,
    'post_peak_ok_count', post_ok_v,
    'pre_late_pumps', pre_late_pumps_v,
    'pre_avg_late', pre_avg_late_v,
    'pre_last_off', pre_last_off_v,
    'pre_lost_pump_minutes', pre_lost_pump_min_v,
    'pre_early_off_pumps', pre_early_off_pumps_v,
    'pre_local_pumps', pre_local_pumps_v,
    'pre_peak_target_time', CASE WHEN is_free_today THEN NULL ELSE pre_peak_target END,
    'peak_start_time', CASE WHEN is_free_today THEN NULL ELSE today_peak_start END,
    'peak_end_time', CASE WHEN is_free_today THEN NULL ELSE today_peak_end END,
    'peak_start_local', peak_start_local::text,
    'peak_end_local', peak_end_local::text,
    'in_peak_window', CASE WHEN is_free_today THEN false ELSE in_or_after_today_peak END,
    'after_peak_window', after_today_peak,
    'cycle_start', cycle_start,
    'cycle_start_label', to_char(cycle_start AT TIME ZONE tz, 'DD/MM HH24:MI'),
    'cycle_capacity_pump_minutes', cycle_capacity_min,
    'avg_7d', avg_7,
    'avg_30d', avg_30,
    'lost_minutes_7d', lost_pump_min_7d_v,
    'lost_minutes_30d', lost_pump_min_30d_v,
    'lost_pump_minutes_7d', lost_pump_min_7d_v,
    'lost_pump_minutes_30d', lost_pump_min_30d_v,
    'is_free_demand', is_free_today
  );
END;
$function$;