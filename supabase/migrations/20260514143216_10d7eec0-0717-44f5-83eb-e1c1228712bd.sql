-- ── 1. Recalcula histórico diário incluindo paradas (gaps) no tempo perdido ──
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
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  tz text;
  cycle_start timestamptz;
  peak_start timestamptz;
  peak_end timestamptz;
  cycle_end timestamptz;
BEGIN
  SELECT COALESCE(f.timezone, 'America/Sao_Paulo') INTO tz
  FROM public.farms f
  WHERE f.id = _farm_id;

  IF tz IS NULL THEN
    RETURN;
  END IF;

  cycle_start := (((_date - 1)::text || ' 21:00')::timestamp AT TIME ZONE tz);
  peak_start := ((_date::text || ' 18:00')::timestamp AT TIME ZONE tz);
  peak_end := ((_date::text || ' 21:00')::timestamp AT TIME ZONE tz);
  cycle_end := peak_end;

  RETURN QUERY
  WITH pump_equipment AS (
    SELECT e.id, e.name, e.saida
    FROM public.equipments e
    WHERE e.farm_id = _farm_id
      AND e.active = true
      AND e.type::text IN ('poco', 'bombeamento', 'conjunto', 'rio')
  ),
  raw_events AS (
    SELECT al.equipment_id, al.occurred_at AS event_at, al.action
    FROM public.automation_log al
    JOIN pump_equipment pe ON pe.id = al.equipment_id
    WHERE al.farm_id = _farm_id
      AND al.result = 'success'
      AND al.action IN ('turn_on', 'turn_off')
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
      AND public.infer_pump_action_from_command_frame(c.frame, pe.saida) IN ('turn_on', 'turn_off')
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
    SELECT * FROM carry_on UNION ALL SELECT * FROM period_events
  ),
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
    SELECT equipment_id,
           event_at AS on_at,
           CASE WHEN next_action = 'turn_off'::public.event_action THEN next_at ELSE cycle_end END AS off_at
    FROM ranked
    WHERE action = 'turn_on'::public.event_action
  ),
  valid_sessions AS (
    SELECT equipment_id, on_at, off_at FROM sessions
    WHERE off_at > on_at AND off_at > cycle_start AND on_at < cycle_end
  ),
  -- Span por bomba: do primeiro ON até o último OFF (capado em cycle_end)
  pump_span AS (
    SELECT equipment_id,
           MIN(on_at)  AS first_on,
           MAX(off_at) AS last_off
    FROM valid_sessions
    GROUP BY equipment_id
  ),
  pump_on_total AS (
    SELECT equipment_id,
           SUM(EXTRACT(epoch FROM (off_at - on_at)) / 60.0) AS on_minutes
    FROM valid_sessions
    GROUP BY equipment_id
  ),
  -- Tempo parada (gap) entre o primeiro ON e o último OFF que NÃO foi tempo ligada.
  -- Não conta o tempo antes do primeiro ON nem depois do último OFF.
  pump_gaps AS (
    SELECT s.equipment_id,
           GREATEST(0,
             EXTRACT(epoch FROM (s.last_off - s.first_on)) / 60.0
             - COALESCE(t.on_minutes, 0)
           ) AS gap_minutes
    FROM pump_span s
    LEFT JOIN pump_on_total t ON t.equipment_id = s.equipment_id
  ),
  operated AS (
    SELECT DISTINCT equipment_id FROM valid_sessions
    WHERE off_at > cycle_start AND on_at < peak_start
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
           SUM(GREATEST(0, EXTRACT(epoch FROM (peak_hi - peak_lo)) / 60)) AS peak_minutes
    FROM peak_sessions
    GROUP BY equipment_id
    HAVING SUM(GREATEST(0, EXTRACT(epoch FROM (peak_hi - peak_lo)) / 60)) > 0
  ),
  first_post AS (
    SELECT equipment_id, MIN(event_at) AS first_on
    FROM period_events
    WHERE action = 'turn_on'::public.event_action
      AND event_at >= cycle_start AND event_at < peak_start
    GROUP BY equipment_id
  ),
  metrics AS (
    SELECT
      COUNT(DISTINCT o.equipment_id)::int AS pumps_operated_v,
      MIN(fp.first_on) AS post_on_v,
      GREATEST(0, FLOOR(EXTRACT(epoch FROM (MIN(fp.first_on) - cycle_start)) / 60))::int AS post_lost_min_v,
      COALESCE((SELECT FLOOR(SUM(gap_minutes))::int FROM pump_gaps WHERE equipment_id IN (SELECT equipment_id FROM operated)), 0) AS gap_min_v,
      COALESCE((SELECT COUNT(*)::int FROM peak_per_pump), 0) AS pumps_peak_v,
      COALESCE((SELECT FLOOR(SUM(peak_minutes))::int FROM peak_per_pump), 0) AS minutes_peak_v,
      COALESCE((
        SELECT MAX(event_at) FROM period_events
        WHERE action = 'turn_off'::public.event_action
          AND event_at >= peak_start - interval '30 minutes'
          AND event_at < peak_start + interval '10 minutes'
      ), NULL) AS pre_off_v,
      COALESCE((
        SELECT COUNT(DISTINCT equipment_id)::int FROM valid_sessions
        WHERE on_at < peak_start AND off_at <= peak_start
      ), 0) AS pre_ok_v,
      COALESCE((
        SELECT COUNT(*)::int FROM first_post
        WHERE first_on <= cycle_start + interval '5 minutes'
      ), 0) AS post_ok_v
    FROM operated o
    LEFT JOIN first_post fp ON fp.equipment_id = o.equipment_id
  )
  SELECT
    _date AS cycle_date,
    CASE
      WHEN COALESCE(m.pumps_operated_v, 0) = 0 THEN NULL::numeric
      ELSE ROUND(GREATEST(0::numeric, LEAST(100::numeric,
        100::numeric
        - (COALESCE(m.post_lost_min_v, 0)::numeric / 60::numeric)
        - (COALESCE(m.gap_min_v, 0)::numeric / GREATEST(1::numeric, COALESCE(m.pumps_operated_v, 0)::numeric * 60::numeric))
        - ((COALESCE(m.minutes_peak_v, 0)::numeric * 3::numeric) / GREATEST(1::numeric, COALESCE(m.pumps_operated_v, 0)::numeric * 180::numeric))
      )), 1)
    END AS efficiency_percent,
    COALESCE(m.pumps_operated_v, 0)::int AS pumps_operated,
    m.post_on_v AS post_peak_startup_time,
    m.pre_off_v AS pre_peak_shutdown_time,
    -- lost_minutes agora soma: atraso pós-ponta + paradas no ciclo + minutos na ponta
    (COALESCE(m.post_lost_min_v, 0)
     + COALESCE(m.gap_min_v, 0)
     + COALESCE(m.minutes_peak_v, 0))::int AS lost_minutes,
    COALESCE(m.pumps_peak_v, 0)::int AS pumps_on_during_peak,
    COALESCE(m.minutes_peak_v, 0)::int AS minutes_on_during_peak,
    COALESCE(m.pre_ok_v, 0)::int AS pre_peak_ok_count,
    COALESCE(m.post_ok_v, 0)::int AS post_peak_ok_count
  FROM metrics m;
END;
$function$;

REVOKE ALL ON FUNCTION public.calculate_energy_efficiency_for_date(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.calculate_energy_efficiency_for_date(uuid, date) FROM anon;

-- ── 2. Resumo do ciclo atual: calcula gaps das bombas operando hoje ──
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
  post_lost_min_v int := 0;
  gap_min_v int := 0;
  gap_pumps_v int := 0;
  lost_min_v int := 0;
  lost_min_7d_v int := 0;
  lost_min_30d_v int := 0;
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
    INTO post_lost_min_v, post_ok_v, post_on_v
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
      SELECT DISTINCT equipment_id FROM automation_log
       WHERE farm_id = _farm_id AND action = 'turn_on' AND result = 'success'
         AND equipment_id IS NOT NULL
         AND occurred_at >= today_peak_start AND occurred_at < today_peak_end
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

  -- ── Reconstrói sessões do ciclo atual e calcula paradas (gaps) ──
  WITH pump_equipment AS (
    SELECT e.id, e.saida
      FROM equipments e
     WHERE e.farm_id = _farm_id
       AND e.active = true
       AND e.type::text IN ('poco','bombeamento','conjunto','rio')
  ),
  raw_events AS (
    SELECT al.equipment_id, al.occurred_at AS event_at, al.action
      FROM automation_log al
      JOIN pump_equipment pe ON pe.id = al.equipment_id
     WHERE al.farm_id = _farm_id
       AND al.result = 'success'
       AND al.action IN ('turn_on','turn_off')
       AND al.occurred_at < cycle_end
    UNION ALL
    SELECT c.equipment_id,
           COALESCE(c.responded_at, c.sent_at, c.created_at) AS event_at,
           public.infer_pump_action_from_command_frame(c.frame, pe.saida) AS action
      FROM commands c
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
    SELECT equipment_id, event_at, action FROM raw_events
     WHERE event_at >= cycle_start AND event_at < cycle_end
  ),
  timeline_base AS (
    SELECT * FROM carry_on UNION ALL SELECT * FROM period_events
  ),
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
      FROM ranked
     WHERE action = 'turn_on'::public.event_action
  ),
  valid_sessions AS (
    SELECT equipment_id, on_at, off_at FROM sessions
     WHERE off_at > on_at AND off_at > cycle_start AND on_at < cycle_end
  ),
  pump_span AS (
    SELECT equipment_id, MIN(on_at) AS first_on, MAX(off_at) AS last_off
      FROM valid_sessions GROUP BY equipment_id
  ),
  pump_on_total AS (
    SELECT equipment_id, SUM(EXTRACT(epoch FROM (off_at - on_at))/60.0) AS on_minutes
      FROM valid_sessions GROUP BY equipment_id
  ),
  pump_gaps AS (
    SELECT s.equipment_id,
           GREATEST(0,
             EXTRACT(epoch FROM (s.last_off - s.first_on))/60.0
             - COALESCE(t.on_minutes, 0)
           ) AS gap_minutes
      FROM pump_span s
      LEFT JOIN pump_on_total t ON t.equipment_id = s.equipment_id
  )
  SELECT
    COALESCE(FLOOR(SUM(gap_minutes))::int, 0),
    COUNT(*) FILTER (WHERE gap_minutes >= 1)
  INTO gap_min_v, gap_pumps_v
  FROM pump_gaps;

  -- Tempo perdido total do ciclo de hoje
  lost_min_v := COALESCE(post_lost_min_v, 0) + COALESCE(gap_min_v, 0) + COALESCE(minutes_peak_v, 0);

  IF pumps_operated_v = 0 THEN
    eff := NULL;
  ELSIF NOT in_or_after_today_peak THEN
    -- Antes da ponta: ainda mostra eficiência baseada nos gaps detectados
    eff := 100 - (gap_min_v::numeric / GREATEST(1, pumps_operated_v * 60));
    IF eff < 0 THEN eff := 0; END IF;
    IF eff > 100 THEN eff := 100; END IF;
  ELSE
    eff := 100
       - (minutes_peak_v::numeric * 3) / GREATEST(1, pumps_operated_v)
       - post_lost_min_v::numeric / 60.0
       - gap_min_v::numeric / GREATEST(1, pumps_operated_v * 60);
    IF eff < 0 THEN eff := 0; END IF;
    IF eff > 100 THEN eff := 100; END IF;
  END IF;

  SELECT ROUND(AVG(h.efficiency_percent), 1) INTO avg_7
    FROM public.get_energy_efficiency_history(_farm_id, 7) h
   WHERE h.pumps_operated > 0 AND h.efficiency_percent IS NOT NULL;

  SELECT ROUND(AVG(h.efficiency_percent), 1) INTO avg_30
    FROM public.get_energy_efficiency_history(_farm_id, 30) h
   WHERE h.pumps_operated > 0 AND h.efficiency_percent IS NOT NULL;

  SELECT COALESCE(SUM(lost_minutes), 0)::int INTO lost_min_7d_v
    FROM public.energy_efficiency_daily
   WHERE farm_id = _farm_id
     AND date >= today_local - 7
     AND date < today_local;

  SELECT COALESCE(SUM(lost_minutes), 0)::int INTO lost_min_30d_v
    FROM public.energy_efficiency_daily
   WHERE farm_id = _farm_id
     AND date >= today_local - 30
     AND date < today_local;

  RETURN jsonb_build_object(
    'date', today_local,
    'efficiency_percent', eff,
    'pre_peak_shutdown_time', pre_off_v,
    'post_peak_startup_time', post_on_v,
    'lost_minutes', lost_min_v,
    'post_lost_minutes_today', post_lost_min_v,
    'gap_minutes_today', gap_min_v,
    'gap_pumps_today', gap_pumps_v,
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
    'lost_minutes_7d', lost_min_7d_v,
    'lost_minutes_30d', lost_min_30d_v
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_energy_efficiency_summary(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_energy_efficiency_summary(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_energy_efficiency_summary(uuid) TO authenticated;