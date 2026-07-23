
-- ============================================================================
-- calculate_energy_efficiency_pumps_for_date — versão baseada em pump_runtime
-- ============================================================================
CREATE OR REPLACE FUNCTION public.calculate_energy_efficiency_pumps_for_date(_farm_id uuid, _date date)
 RETURNS TABLE(equipment_id uuid, equipment_name text, first_on timestamptz, late_min integer,
               last_off timestamptz, early_off_min integer, mode text, peak_minutes integer,
               post_status text, pre_status text, peak_violation boolean)
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
  post_window_end   := cycle_start + interval '3 hours';    -- 21:00 → 00:00
  pre_window_start  := peak_start - interval '2 hours';     -- 16:00
  pre_target        := peak_start - interval '15 minutes';  -- 17:45

  RETURN QUERY
  WITH pump_equipment AS (
    SELECT e.id, e.name, e.saida, e.local_ack_at
      FROM public.equipments e
     WHERE e.farm_id = _farm_id AND e.active = true
       AND e.type::text IN ('poco','bombeamento','conjunto','rio')
       AND COALESCE(e.participates_night_cycle, true) = true
  ),
  -- Fonte canônica: sessões reais de funcionamento (pump_runtime).
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
  -- Sessão clampeada dentro do ciclo (para tempo ligado / gaps).
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
  -- Primeiro started_at REAL dentro da janela pós-ponta (21:00 → 00:00).
  first_post_on AS (
    SELECT equipment_id, MIN(raw_started) AS first_on
      FROM clamped_sessions
     WHERE NOT is_free
       AND raw_started >= cycle_start
       AND raw_started <  post_window_end
     GROUP BY equipment_id
  ),
  -- Último ended_at REAL dentro da janela pré-ponta (16:00 → 18:00).
  last_off_pre AS (
    SELECT equipment_id, MAX(raw_ended) AS last_off
      FROM clamped_sessions
     WHERE NOT is_free
       AND raw_ended >= pre_window_start
       AND raw_ended <= peak_start
       -- só desligamentos reais (não sessões abertas / não clamps por cycle_end)
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
    pe.id AS equipment_id,
    pe.name AS equipment_name,
    CASE WHEN is_free THEN fcf.first_on ELSE fpo.first_on END AS first_on,
    CASE
      WHEN is_free THEN 0
      WHEN fpo.first_on IS NULL THEN 0
      ELSE GREATEST(0, FLOOR(EXTRACT(epoch FROM (fpo.first_on - cycle_start))/60))::int
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
      WHEN fpo.first_on IS NULL THEN 'ok'
      WHEN GREATEST(0, FLOOR(EXTRACT(epoch FROM (fpo.first_on - cycle_start))/60))::int > 8 THEN 'late'
      ELSE 'ok'
    END AS post_status,
    CASE
      WHEN is_free THEN 'ok'
      WHEN lop.last_off IS NULL THEN 'ok'
      WHEN lop.last_off >= pre_target THEN 'ok'
      ELSE 'early'
    END AS pre_status,
    CASE WHEN is_free THEN false ELSE COALESCE(pk.peak_minutes, 0) > 0 END AS peak_violation
  FROM pump_equipment pe
  JOIN operated_in_cycle oi ON oi.equipment_id = pe.id
  LEFT JOIN first_post_on fpo       ON fpo.equipment_id = pe.id
  LEFT JOIN last_off_pre lop        ON lop.equipment_id = pe.id
  LEFT JOIN first_cycle_on_free fcf ON fcf.equipment_id = pe.id
  LEFT JOIN peak_per_pump pk        ON pk.equipment_id = pe.id;
END;
$function$;


-- ============================================================================
-- calculate_energy_efficiency_for_date — versão baseada em pump_runtime
-- ============================================================================
CREATE OR REPLACE FUNCTION public.calculate_energy_efficiency_for_date(_farm_id uuid, _date date)
 RETURNS TABLE(cycle_date date, efficiency_percent numeric, pumps_operated integer,
               post_peak_startup_time timestamptz, pre_peak_shutdown_time timestamptz,
               lost_minutes integer, pumps_on_during_peak integer, minutes_on_during_peak integer,
               pre_peak_ok_count integer, post_peak_ok_count integer)
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
  effective_peak_end timestamptz;
  post_window_end timestamptz;
  pre_window_start timestamptz;
  pre_target timestamptz;
  peak_start_local time := time '18:00';
  peak_end_local   time := time '21:00';
  is_free boolean;
BEGIN
  SELECT COALESCE(f.timezone,'America/Sao_Paulo') INTO tz FROM public.farms f WHERE f.id = _farm_id;
  IF tz IS NULL THEN RETURN; END IF;

  SELECT
    COALESCE((SELECT fpc.peak_hour_start FROM public.farm_productivity_config fpc WHERE fpc.farm_id = _farm_id LIMIT 1), time '18:00'),
    COALESCE((SELECT fpc.peak_hour_end   FROM public.farm_productivity_config fpc WHERE fpc.farm_id = _farm_id LIMIT 1), time '21:00')
    INTO peak_start_local, peak_end_local;

  is_free := public.is_free_demand_day(_date, _farm_id);

  IF is_free THEN
    cycle_start := ((_date::text || ' 00:00:00')::timestamp AT TIME ZONE tz);
    cycle_end   := (((_date + 1)::text || ' 00:00:00')::timestamptz AT TIME ZONE tz);
    peak_start  := cycle_start;
    peak_end    := cycle_start;
  ELSE
    cycle_start := (((_date - 1)::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz);
    peak_start  := ((_date::text || ' ' || peak_start_local::text)::timestamp AT TIME ZONE tz);
    peak_end    := ((_date::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz);
    cycle_end   := peak_end;
  END IF;
  effective_peak_end := LEAST(peak_end, now());
  post_window_end   := cycle_start + interval '3 hours';
  pre_window_start  := peak_start - interval '2 hours';
  pre_target        := peak_start - interval '15 minutes';

  RETURN QUERY
  WITH pump_equipment AS (
    SELECT e.id, e.name, e.saida
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
  pump_span AS (
    SELECT equipment_id, MIN(on_at) AS first_on, MAX(off_at) AS last_off
      FROM clamped_sessions GROUP BY equipment_id
  ),
  pump_on_total AS (
    SELECT equipment_id, SUM(EXTRACT(epoch FROM (off_at - on_at))/60.0) AS on_minutes
      FROM clamped_sessions GROUP BY equipment_id
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
  peak_per_pump AS (
    SELECT h.equipment_id, h.peak_minutes
      FROM public.calculate_pump_peak_minutes_for_window(_farm_id, peak_start, effective_peak_end) h
     WHERE NOT is_free AND effective_peak_end > peak_start
  ),
  metrics AS (
    SELECT
      (SELECT COUNT(*) FROM operated_in_cycle)::int AS pumps_v,
      COALESCE((SELECT FLOOR(SUM(gap_minutes))::int FROM pump_gaps), 0) AS gap_min_v,
      COALESCE((SELECT SUM(peak_minutes)::int FROM peak_per_pump), 0) AS peak_lost_v,
      COALESCE((SELECT COUNT(*) FROM peak_per_pump WHERE peak_minutes > 0), 0)::int AS pumps_on_peak_v,
      COALESCE((SELECT SUM(GREATEST(0, FLOOR(EXTRACT(epoch FROM (fpo.first_on - cycle_start))/60))::int) FROM first_post_on fpo), 0) AS post_lost_v,
      COALESCE((SELECT SUM(CASE WHEN lop.last_off >= pre_target THEN 0
                                ELSE GREATEST(0, FLOOR(EXTRACT(epoch FROM (pre_target - lop.last_off))/60))::int END)
                 FROM last_off_pre lop), 0) AS pre_lost_v,
      COALESCE((SELECT COUNT(*) FROM first_post_on fpo
                 WHERE GREATEST(0, FLOOR(EXTRACT(epoch FROM (fpo.first_on - cycle_start))/60))::int <= 8), 0)::int AS post_ok_v,
      COALESCE((SELECT COUNT(*) FROM last_off_pre lop WHERE lop.last_off >= pre_target), 0)::int AS pre_ok_v,
      (SELECT MIN(first_on) FROM first_post_on) AS post_time_v,
      (SELECT MAX(last_off) FROM last_off_pre) AS pre_time_v
  )
  SELECT
    _date AS cycle_date,
    CASE WHEN COALESCE(m.pumps_v, 0) = 0 THEN NULL::numeric
         ELSE ROUND(GREATEST(0::numeric, LEAST(100::numeric,
           100::numeric - ((COALESCE(m.gap_min_v,0) + COALESCE(m.post_lost_v,0) + COALESCE(m.peak_lost_v,0) + CASE WHEN is_free THEN 0 ELSE COALESCE(m.pre_lost_v,0) END)::numeric
                            * 100::numeric
                            / GREATEST(1::numeric, COALESCE(m.pumps_v,0)::numeric * (CASE WHEN is_free THEN 1440 ELSE 1260 END)::numeric))
         )), 1)
    END AS efficiency_percent,
    COALESCE(m.pumps_v, 0)::int AS pumps_operated,
    CASE WHEN is_free THEN NULL ELSE m.post_time_v END AS post_peak_startup_time,
    CASE WHEN is_free THEN NULL ELSE m.pre_time_v  END AS pre_peak_shutdown_time,
    (COALESCE(m.gap_min_v,0)
      + CASE WHEN is_free THEN 0 ELSE COALESCE(m.post_lost_v,0) + COALESCE(m.pre_lost_v,0) + COALESCE(m.peak_lost_v,0) END)::int AS lost_minutes,
    CASE WHEN is_free THEN 0 ELSE COALESCE(m.pumps_on_peak_v,0) END AS pumps_on_during_peak,
    CASE WHEN is_free THEN 0 ELSE COALESCE(m.peak_lost_v,0)    END AS minutes_on_during_peak,
    CASE WHEN is_free THEN COALESCE(m.pumps_v,0) ELSE COALESCE(m.pre_ok_v,0)  END AS pre_peak_ok_count,
    CASE WHEN is_free THEN COALESCE(m.pumps_v,0) ELSE COALESCE(m.post_ok_v,0) END AS post_peak_ok_count
  FROM metrics m;
END;
$function$;
