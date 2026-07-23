
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
  post_window_end timestamptz;
  entry_window_end timestamptz;             -- cycle_start + 6h (janela para regra acumulada)
  today_peak_start timestamptz;
  today_peak_end timestamptz;
  pre_peak_target timestamptz;

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
  post_window_end := cycle_start + interval '9 hours';
  entry_window_end := cycle_start + interval '6 hours';
  today_peak_start := (((cycle_start_local::date + 1)::text || ' 18:00')::timestamp AT TIME ZONE tz);
  today_peak_end   := (((cycle_start_local::date + 1)::text || ' 21:00')::timestamp AT TIME ZONE tz);
  pre_peak_target  := (((cycle_start_local::date + 1)::text || ' 17:45')::timestamp AT TIME ZONE tz);
  in_or_after_today_peak := now() >= today_peak_start;
  after_today_peak := now() >= cycle_start;

  SELECT COUNT(*) INTO pumps_running_now_v
    FROM equipments
   WHERE farm_id = _farm_id AND active = true
     AND type::text IN ('poco','bombeamento','conjunto','rio')
     AND (
       COALESCE(last_outputs_state,'') = '1'
       OR (last_outputs_state ~ '^[01]{1,6}$'
           AND saida IS NOT NULL
           AND saida BETWEEN 1 AND char_length(last_outputs_state)
           AND substring(last_outputs_state from saida for 1) = '1')
     );

  WITH pump_equipment AS (
    SELECT e.id, e.saida, e.local_ack_at
      FROM equipments e
     WHERE e.farm_id = _farm_id AND e.active = true
       AND e.type::text IN ('poco','bombeamento','conjunto','rio')
  ),
  scheduled_pumps AS (
    SELECT DISTINCT s.equipment_id
      FROM automation_schedules s
     WHERE s.farm_id = _farm_id AND s.active = true
       AND s.equipment_id IS NOT NULL
  ),
  raw_events AS (
    SELECT al.equipment_id, al.occurred_at AS event_at, al.action
      FROM automation_log al JOIN pump_equipment pe ON pe.id = al.equipment_id
     WHERE al.farm_id = _farm_id AND al.result = 'success'
       AND al.action IN ('turn_on','turn_off') AND al.occurred_at < cycle_end
    UNION ALL
    SELECT c.equipment_id,
           COALESCE(c.responded_at, c.sent_at, c.created_at) AS event_at,
           public.infer_pump_action_from_command_frame(c.frame, pe.saida) AS action
      FROM commands c JOIN pump_equipment pe ON pe.id = c.equipment_id
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
  operated AS (
    SELECT DISTINCT equipment_id FROM valid_sessions
     WHERE off_at > cycle_start AND on_at < LEAST(cycle_end, today_peak_start)
  ),
  expected_pumps AS (
    SELECT equipment_id FROM scheduled_pumps
    UNION
    SELECT equipment_id FROM operated
  ),
  -- Sessões dentro da janela pós-ponta (21:00 -> 06:00)
  post_sessions AS (
    SELECT vs.equipment_id, vs.on_at, vs.off_at, vs.on_minutes
      FROM valid_sessions vs
     WHERE vs.on_at < LEAST(post_window_end, cycle_end)
       AND vs.off_at > cycle_start
  ),
  -- Regra A: qualquer sessão contínua ≥ 30 min
  rule_a AS (
    SELECT DISTINCT equipment_id
      FROM post_sessions
     WHERE on_minutes >= 30
        OR off_at >= cycle_end  -- sessão ainda em curso conta como válida
  ),
  -- Regra B: soma de tempo dentro das primeiras 6h ≥ 60 min
  rule_b AS (
    SELECT equipment_id
      FROM post_sessions
     WHERE on_at < entry_window_end
     GROUP BY equipment_id
    HAVING SUM(
      EXTRACT(epoch FROM (
        LEAST(off_at, entry_window_end) - GREATEST(on_at, cycle_start)
      ))/60.0
    ) >= 60
  ),
  qualified AS (
    SELECT equipment_id FROM rule_a
    UNION
    SELECT equipment_id FROM rule_b
  ),
  -- first_on = primeiro on_at (clipado a cycle_start) entre sessões da bomba qualificada
  first_valid_on AS (
    SELECT ps.equipment_id, MIN(GREATEST(ps.on_at, cycle_start)) AS first_on
      FROM post_sessions ps
     WHERE ps.equipment_id IN (SELECT equipment_id FROM qualified)
     GROUP BY ps.equipment_id
  ),
  post_per_pump AS (
    SELECT ep.equipment_id,
           fvo.first_on,
           CASE
             WHEN fvo.first_on IS NULL THEN 540
             ELSE LEAST(540,
                    GREATEST(0, FLOOR(EXTRACT(epoch FROM (fvo.first_on - cycle_start))/60))::int)
           END AS late_min,
           (fvo.first_on IS NULL) AS not_started
      FROM expected_pumps ep
      LEFT JOIN first_valid_on fvo ON fvo.equipment_id = ep.equipment_id
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
             EXTRACT(epoch FROM (s.last_off - s.first_on))/60.0 - COALESCE(t.on_minutes, 0)
           ) AS gap_minutes
      FROM pump_span s LEFT JOIN pump_on_total t ON t.equipment_id = s.equipment_id
  )
  SELECT COALESCE(SUM(pp.late_min), 0)::int,
         COUNT(*) FILTER (WHERE pp.late_min > 8)::int,
         COALESCE(MAX(pp.late_min), 0)::int,
         MIN(pp.first_on),
         MAX(pp.first_on),
         COUNT(*) FILTER (WHERE pp.late_min <= 8 AND NOT pp.not_started)::int,
         COUNT(*)::int,
         COUNT(*) FILTER (WHERE pp.not_started)::int,
         COALESCE(FLOOR((SELECT SUM(gap_minutes) FROM pump_gaps))::int, 0),
         COALESCE((SELECT COUNT(*)::int FROM pump_gaps WHERE gap_minutes >= 1), 0)
    INTO post_lost_pump_min_v, post_late_pumps_v, post_lost_min_v,
         post_on_v, post_last_on_v,
         post_ok_v, post_pumps_seen_v, post_not_started_v,
         gap_min_v, gap_pumps_v
    FROM post_per_pump pp;

  SELECT COUNT(DISTINCT equipment_id) INTO pumps_operated_v
    FROM (
      SELECT equipment_id FROM automation_log
       WHERE farm_id = _farm_id AND action = 'turn_on' AND result = 'success'
         AND equipment_id IS NOT NULL
         AND occurred_at >= cycle_start AND occurred_at < cycle_end
      UNION
      SELECT equipment_id FROM automation_schedules
       WHERE farm_id = _farm_id AND active = true AND equipment_id IS NOT NULL
    ) x;
  IF pumps_running_now_v > pumps_operated_v THEN pumps_operated_v := pumps_running_now_v; END IF;
  IF post_pumps_seen_v > pumps_operated_v THEN pumps_operated_v := post_pumps_seen_v; END IF;

  IF in_or_after_today_peak THEN
    SELECT MAX(occurred_at) INTO pre_off_v
      FROM automation_log
     WHERE farm_id = _farm_id AND action = 'turn_off' AND result = 'success'
       AND occurred_at >= cycle_start AND occurred_at < today_peak_start;

    WITH pump_equipment AS (
      SELECT e.id, e.local_ack_at
        FROM equipments e
       WHERE e.farm_id = _farm_id AND e.active = true
         AND e.type::text IN ('poco','bombeamento','conjunto','rio')
    ),
    last_off_pre AS (
      SELECT vs.equipment_id, MAX(vs.off_at) AS last_off
        FROM (
          SELECT equipment_id, off_at FROM (
            SELECT equipment_id, off_at,
                   ROW_NUMBER() OVER (PARTITION BY equipment_id ORDER BY off_at DESC) rn
              FROM (
                SELECT al.equipment_id, al.occurred_at AS off_at
                  FROM automation_log al
                 WHERE al.farm_id = _farm_id AND al.action = 'turn_off' AND al.result = 'success'
                   AND al.occurred_at >= cycle_start AND al.occurred_at < today_peak_start
              ) t
          ) r WHERE rn = 1
        ) vs
       GROUP BY vs.equipment_id
    ),
    pre_calc AS (
      SELECT lop.equipment_id, lop.last_off,
             GREATEST(0, FLOOR(EXTRACT(epoch FROM (pre_peak_target - lop.last_off))/60))::int AS early_min,
             COALESCE(pe.local_ack_at, 'epoch'::timestamptz) > cycle_start AS is_local
        FROM last_off_pre lop
        LEFT JOIN pump_equipment pe ON pe.id = lop.equipment_id
       WHERE lop.last_off < pre_peak_target
    )
    SELECT COALESCE(SUM(early_min), 0)::int,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE is_local)::int,
           MAX(last_off)
      INTO pre_lost_pump_min_v, pre_early_off_pumps_v, pre_local_pumps_v, pre_last_off_v
      FROM pre_calc;

    SELECT COUNT(DISTINCT equipment_id) INTO pre_ok_v
      FROM automation_log
     WHERE farm_id = _farm_id AND action = 'turn_off' AND result = 'success'
       AND equipment_id IS NOT NULL
       AND occurred_at >= pre_peak_target AND occurred_at < today_peak_start;

    WITH pump_equipment AS (
      SELECT e.id, e.saida
        FROM equipments e
       WHERE e.farm_id = _farm_id AND e.active = true
         AND e.type::text IN ('poco','bombeamento','conjunto','rio')
    ),
    raw_events AS (
      SELECT al.equipment_id, al.occurred_at AS event_at, al.action
        FROM automation_log al JOIN pump_equipment pe ON pe.id = al.equipment_id
       WHERE al.farm_id = _farm_id AND al.result = 'success'
         AND al.action IN ('turn_on','turn_off') AND al.occurred_at < cycle_end
      UNION ALL
      SELECT c.equipment_id,
             COALESCE(c.responded_at, c.sent_at, c.created_at) AS event_at,
             public.infer_pump_action_from_command_frame(c.frame, pe.saida) AS action
        FROM commands c JOIN pump_equipment pe ON pe.id = c.equipment_id
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
    tb AS (SELECT * FROM carry_on UNION ALL SELECT * FROM period_events),
    oe AS (
      SELECT equipment_id, event_at, action,
             LAG(action) OVER (PARTITION BY equipment_id ORDER BY event_at, action::text) AS prev_action
        FROM tb
    ),
    se AS (
      SELECT equipment_id, event_at, action FROM oe
       WHERE prev_action IS NULL OR prev_action <> action
    ),
    rk AS (
      SELECT equipment_id, event_at, action,
             LEAD(event_at) OVER (PARTITION BY equipment_id ORDER BY event_at, action::text) AS next_at,
             LEAD(action) OVER (PARTITION BY equipment_id ORDER BY event_at, action::text) AS next_action
        FROM se
    ),
    sess AS (
      SELECT equipment_id, event_at AS on_at,
             CASE WHEN next_action = 'turn_off'::public.event_action THEN next_at ELSE cycle_end END AS off_at
        FROM rk WHERE action = 'turn_on'::public.event_action
    ),
    vs AS (
      SELECT equipment_id, on_at, off_at
        FROM sess
       WHERE off_at > on_at AND off_at > cycle_start AND on_at < cycle_end
    ),
    peak_sessions AS (
      SELECT equipment_id,
             GREATEST(on_at, today_peak_start) AS peak_on,
             LEAST(off_at, today_peak_end)    AS peak_off
        FROM vs
       WHERE on_at < today_peak_end AND off_at > today_peak_start
    )
    SELECT COUNT(DISTINCT equipment_id),
           COALESCE(ROUND(AVG(GREATEST(0, EXTRACT(epoch FROM (peak_off - today_peak_start))/60.0)))::int, 0)
      INTO pre_late_pumps_v, pre_avg_late_v
      FROM peak_sessions;
  END IF;

  IF in_or_after_today_peak THEN
    WITH pump_equipment AS (
      SELECT id,
             CASE
               WHEN COALESCE(last_outputs_state,'') = '1' THEN true
               WHEN last_outputs_state ~ '^[01]{1,6}$' AND saida IS NOT NULL
                 AND saida BETWEEN 1 AND char_length(last_outputs_state)
                 THEN substring(last_outputs_state from saida for 1) = '1'
               ELSE false
             END AS running_now
        FROM equipments
       WHERE farm_id = _farm_id AND active = true
         AND type::text IN ('poco','bombeamento','conjunto','rio')
    ),
    peak_turnons AS (
      SELECT DISTINCT equipment_id FROM automation_log
       WHERE farm_id = _farm_id AND action = 'turn_on' AND result = 'success'
         AND equipment_id IS NOT NULL
         AND occurred_at >= today_peak_start AND occurred_at < today_peak_end
    ),
    still_running_peak AS (
      SELECT id AS equipment_id FROM pump_equipment
       WHERE running_now AND now() >= today_peak_start AND now() < today_peak_end
    ),
    peak_hits AS (
      SELECT equipment_id FROM peak_turnons
      UNION SELECT equipment_id FROM still_running_peak
    )
    SELECT COUNT(*) INTO pumps_peak_v FROM peak_hits;

    IF now() >= today_peak_start AND now() < today_peak_end THEN
      minutes_peak_v := pumps_peak_v * GREATEST(0, FLOOR(EXTRACT(epoch FROM (now() - today_peak_start))/60))::int;
    ELSE
      minutes_peak_v := pumps_peak_v * 180;
    END IF;
  END IF;

  lost_pump_min_v := COALESCE(post_lost_pump_min_v, 0)
                   + COALESCE(gap_min_v, 0)
                   + COALESCE(pre_lost_pump_min_v, 0)
                   + COALESCE(minutes_peak_v, 0);

  cycle_capacity_min := GREATEST(pumps_operated_v, post_pumps_seen_v) * 1260;

  IF pumps_operated_v = 0 THEN
    eff := NULL;
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
    'pre_peak_target_time', pre_peak_target,
    'in_peak_window', in_or_after_today_peak,
    'after_peak_window', after_today_peak,
    'cycle_start', cycle_start,
    'cycle_start_label', to_char(cycle_start AT TIME ZONE tz, 'DD/MM HH24:MI'),
    'cycle_capacity_pump_minutes', cycle_capacity_min,
    'avg_7d', avg_7,
    'avg_30d', avg_30,
    'lost_minutes_7d', lost_pump_min_7d_v,
    'lost_minutes_30d', lost_pump_min_30d_v,
    'lost_pump_minutes_7d', lost_pump_min_7d_v,
    'lost_pump_minutes_30d', lost_pump_min_30d_v
  );
END;
$function$;
