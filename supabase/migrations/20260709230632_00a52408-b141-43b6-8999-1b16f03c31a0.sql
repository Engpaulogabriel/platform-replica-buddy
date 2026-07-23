CREATE OR REPLACE FUNCTION public.calculate_pump_peak_minutes_for_window(
  _farm_id uuid,
  _window_start timestamp with time zone,
  _window_end timestamp with time zone
)
RETURNS TABLE(equipment_id uuid, peak_minutes integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH pump_equipment AS (
    SELECT e.id, e.saida
      FROM public.equipments e
     WHERE e.farm_id = _farm_id
       AND e.active = true
       AND e.type::text IN ('poco','bombeamento','conjunto','rio')
       AND COALESCE(e.participates_night_cycle, true) = true
  ),
  raw_events AS (
    SELECT al.equipment_id,
           al.occurred_at AS event_at,
           al.action::public.event_action AS action
      FROM public.automation_log al
      JOIN pump_equipment pe ON pe.id = al.equipment_id
     WHERE al.farm_id = _farm_id
       AND al.result = 'success'
       AND al.action IN ('turn_on','turn_off')
       AND al.occurred_at < _window_end
    UNION ALL
    SELECT c.equipment_id,
           COALESCE(c.responded_at, c.sent_at, c.created_at) AS event_at,
           public.infer_pump_action_from_command_frame(c.frame, pe.saida) AS action
      FROM public.commands c
      JOIN pump_equipment pe ON pe.id = c.equipment_id
     WHERE c.farm_id = _farm_id
       AND c.type = 'manual'::public.command_type
       AND c.status = 'executed'::public.command_status
       AND COALESCE(c.responded_at, c.sent_at, c.created_at) < _window_end
       AND public.infer_pump_action_from_command_frame(c.frame, pe.saida) IN ('turn_on','turn_off')
  ),
  last_before AS (
    SELECT DISTINCT ON (equipment_id) equipment_id, event_at, action
      FROM raw_events
     WHERE event_at < _window_start
     ORDER BY equipment_id, event_at DESC
  ),
  carry_on AS (
    SELECT equipment_id, _window_start AS event_at, 'turn_on'::public.event_action AS action
      FROM last_before
     WHERE action = 'turn_on'::public.event_action
  ),
  period_events AS (
    SELECT equipment_id, event_at, action
      FROM raw_events
     WHERE event_at >= _window_start AND event_at < _window_end
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
           CASE WHEN next_action = 'turn_off'::public.event_action THEN next_at ELSE _window_end END AS off_at
      FROM ranked
     WHERE action = 'turn_on'::public.event_action
  ),
  overlapped_sessions AS (
    SELECT s.equipment_id,
           GREATEST(0, EXTRACT(epoch FROM (LEAST(s.off_at, _window_end) - GREATEST(s.on_at, _window_start))) / 60.0) AS minutes
      FROM sessions s
     WHERE s.off_at > _window_start
       AND s.on_at < _window_end
  )
  SELECT os.equipment_id,
         FLOOR(SUM(os.minutes))::integer AS peak_minutes
    FROM overlapped_sessions os
   GROUP BY os.equipment_id
  HAVING FLOOR(SUM(os.minutes))::integer > 0;
$function$;

GRANT EXECUTE ON FUNCTION public.calculate_pump_peak_minutes_for_window(uuid, timestamp with time zone, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_pump_peak_minutes_for_window(uuid, timestamp with time zone, timestamp with time zone) TO service_role;

DO $migration$
DECLARE
  ddl text;
  new_ddl text;
BEGIN
  ddl := pg_get_functiondef('public.calculate_energy_efficiency_for_date(uuid,date)'::regprocedure);
  new_ddl := replace(
    ddl,
$old$
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
$old$,
$new$
  peak_per_pump AS (
    SELECT h.equipment_id, h.peak_minutes::numeric AS peak_minutes
      FROM public.calculate_pump_peak_minutes_for_window(
        _farm_id,
        (((_date - 1)::text || ' ' || peak_start_local::text)::timestamp AT TIME ZONE tz),
        (((_date - 1)::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz)
      ) h
     WHERE NOT is_free
  ),
$new$
  );

  IF new_ddl = ddl THEN
    RAISE EXCEPTION 'calculate_energy_efficiency_for_date peak CTE not replaced';
  END IF;

  EXECUTE new_ddl;
END;
$migration$;

DO $migration$
DECLARE
  ddl text;
  new_ddl text;
BEGIN
  ddl := pg_get_functiondef('public.calculate_energy_efficiency_pumps_for_date(uuid,date)'::regprocedure);
  new_ddl := replace(
    ddl,
$old$
  peak_per_pump AS (
    SELECT equipment_id,
           SUM(GREATEST(0,
             EXTRACT(epoch FROM (LEAST(off_at, peak_end) - GREATEST(on_at, peak_start)))/60.0
           ))::int AS peak_minutes
      FROM valid_sessions
     WHERE NOT is_free AND off_at > peak_start AND on_at < peak_end
     GROUP BY equipment_id
  )
$old$,
$new$
  peak_per_pump AS (
    SELECT h.equipment_id, h.peak_minutes
      FROM public.calculate_pump_peak_minutes_for_window(
        _farm_id,
        (((_date - 1)::text || ' ' || peak_start_local::text)::timestamp AT TIME ZONE tz),
        (((_date - 1)::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz)
      ) h
     WHERE NOT is_free
  )
$new$
  );

  IF new_ddl = ddl THEN
    RAISE EXCEPTION 'calculate_energy_efficiency_pumps_for_date peak CTE not replaced';
  END IF;

  EXECUTE new_ddl;
END;
$migration$;

DO $migration$
DECLARE
  ddl text;
  new_ddl text;
BEGIN
  ddl := pg_get_functiondef('public.get_energy_efficiency_summary(uuid)'::regprocedure);
  new_ddl := replace(
    ddl,
$old$
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
$old$,
$new$
  peak_per_pump AS (
    SELECT h.equipment_id, h.peak_minutes::numeric AS peak_minutes
      FROM public.calculate_pump_peak_minutes_for_window(
        _farm_id,
        ((cycle_start_local::date::text || ' ' || peak_start_local::text)::timestamp AT TIME ZONE tz),
        ((cycle_start_local::date::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz)
      ) h
     WHERE NOT is_free_today
  )
$new$
  );

  IF new_ddl = ddl THEN
    RAISE EXCEPTION 'get_energy_efficiency_summary peak CTE not replaced';
  END IF;

  EXECUTE new_ddl;
END;
$migration$;

DO $recalc$
DECLARE
  farm_row record;
  recalc_date date;
BEGIN
  FOR farm_row IN SELECT id FROM public.farms LOOP
    FOR recalc_date IN
      SELECT generate_series((now() AT TIME ZONE 'America/Sao_Paulo')::date - 30, (now() AT TIME ZONE 'America/Sao_Paulo')::date, interval '1 day')::date
    LOOP
      PERFORM public.compute_energy_efficiency(farm_row.id, recalc_date);
    END LOOP;
  END LOOP;
END;
$recalc$;