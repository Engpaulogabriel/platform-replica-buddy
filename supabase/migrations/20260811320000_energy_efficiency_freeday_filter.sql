-- ─────────────────────────────────────────────────────────────────────────────
-- get_energy_efficiency_summary — exclui DIAS LIVRES das médias 7d/30d
-- ─────────────────────────────────────────────────────────────────────────────
-- MOTIVO: as médias avg_efficiency_7d / avg_efficiency_30d faziam
-- AVG(efficiency_percent) sobre energy_efficiency_daily SEM filtrar dias livres.
-- Sábados, domingos e feriados são gravados como 100% (sem obrigação de ponta),
-- o que INFLAVA artificialmente a média histórica exibida no card.
-- Correção: adicionar `AND is_free_demand IS NOT TRUE` nas DUAS agregações de
-- média (mesma regra já aplicada no HERO do EnergyEfficiencyCard e no histórico).
--
-- Esta função é idêntica à definição vigente
-- (20260710195223_64ca3eee-150c-4e8f-b843-74dc1c9ae6d1.sql); a ÚNICA diferença
-- são os dois filtros de dia livre nas médias. Idempotente (CREATE OR REPLACE).
-- NÃO altera o cálculo de lost_minutes_7d/30d (soma), que segue como estava.
-- ─────────────────────────────────────────────────────────────────────────────

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
  cycle_date_local date;
  cycle_start timestamptz;
  cycle_end timestamptz;
  post_window_end timestamptz;
  pre_window_start timestamptz;
  today_peak_start timestamptz;
  today_peak_end timestamptz;
  effective_peak_end timestamptz;
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
    cycle_date_local := today_local;
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
    cycle_date_local := (cycle_start_local::date + 1);
    cycle_start := cycle_start_local AT TIME ZONE tz;
    cycle_end := now();
    today_peak_start := ((cycle_date_local::text || ' ' || peak_start_local::text)::timestamp AT TIME ZONE tz);
    today_peak_end   := ((cycle_date_local::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz);
  END IF;

  effective_peak_end := LEAST(today_peak_end, now());
  pre_peak_target   := today_peak_start - interval '15 minutes';
  post_window_end   := cycle_start + interval '2 hours';    -- 21:00 → 23:00
  pre_window_start  := today_peak_start - interval '2 hours';
  in_or_after_today_peak := now() >= today_peak_start;
  after_today_peak := now() >= cycle_start;

  WITH pump_equipment AS (
    SELECT e.id, e.name, e.saida, e.local_ack_at, e.desired_running, e.last_outputs_state
      FROM equipments e
     WHERE e.farm_id = _farm_id AND e.active = true
       AND e.type::text IN ('poco','bombeamento','conjunto','rio')
       AND COALESCE(e.participates_night_cycle, true) = true
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
  first_post_on AS (
    SELECT vs.equipment_id, MIN(vs.on_at) AS first_on
      FROM valid_sessions vs
     WHERE NOT is_free_today AND vs.on_at >= cycle_start AND vs.on_at < post_window_end
     GROUP BY vs.equipment_id
  ),
  last_off_pre AS (
    SELECT vs.equipment_id, MAX(vs.off_at) AS last_off
      FROM valid_sessions vs
     WHERE NOT is_free_today AND vs.off_at >= pre_window_start AND vs.off_at <= today_peak_start
     GROUP BY vs.equipment_id
  ),
  post_per_pump AS (
    SELECT fpo.equipment_id, fpo.first_on,
           GREATEST(0, FLOOR(EXTRACT(epoch FROM (fpo.first_on - cycle_start))/60))::int AS late_min
      FROM first_post_on fpo
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
             - COALESCE(pump_lock_overlap_minutes(_farm_id, s.equipment_id, s.first_on, s.last_off), 0)
           ) AS gap_minutes
      FROM pump_span s LEFT JOIN pump_on_total t ON t.equipment_id = s.equipment_id
  ),
  peak_per_pump AS (
    SELECT h.equipment_id, h.peak_minutes::numeric AS peak_minutes
      FROM public.calculate_pump_peak_minutes_for_window(_farm_id, today_peak_start, effective_peak_end) h
     WHERE NOT is_free_today AND effective_peak_end > today_peak_start
  ),
  pre_calc AS (
    SELECT lop.equipment_id, lop.last_off,
           GREATEST(0, FLOOR(EXTRACT(epoch FROM (pre_peak_target - lop.last_off))/60))::int AS early_min
      FROM last_off_pre lop
     WHERE lop.last_off < pre_peak_target
  )
  SELECT
    COALESCE(SUM(pp.late_min), 0)::int,
    COUNT(*) FILTER (WHERE pp.late_min > 8)::int,
    COALESCE(MAX(pp.late_min), 0)::int,
    MIN(pp.first_on), MAX(pp.first_on),
    COUNT(*) FILTER (WHERE pp.late_min <= 8)::int,
    COUNT(*)::int,
    COALESCE(FLOOR((SELECT SUM(gap_minutes) FROM pump_gaps))::int, 0),
    COALESCE((SELECT COUNT(*)::int FROM pump_gaps WHERE gap_minutes >= 1), 0),
    COALESCE((SELECT COUNT(*)::int FROM peak_per_pump), 0),
    COALESCE((SELECT FLOOR(SUM(peak_minutes))::int FROM peak_per_pump), 0),
    COALESCE((SELECT SUM(early_min) FROM pre_calc)::int, 0),
    COALESCE((SELECT COUNT(*) FROM pre_calc)::int, 0),
    (SELECT MAX(last_off) FROM last_off_pre),
    (SELECT MAX(last_off) FROM pre_calc)
    INTO post_lost_pump_min_v, post_late_pumps_v, post_lost_min_v,
         post_on_v, post_last_on_v,
         post_ok_v, post_pumps_seen_v,
         gap_min_v, gap_pumps_v,
         pumps_peak_v, minutes_peak_v,
         pre_lost_pump_min_v, pre_early_off_pumps_v,
         pre_off_v, pre_last_off_v
    FROM post_per_pump pp;

  SELECT COUNT(DISTINCT equipment_id) INTO pumps_operated_v
    FROM (
      SELECT equipment_id FROM automation_log
       WHERE farm_id = _farm_id AND action = 'turn_on' AND result = 'success'
         AND equipment_id IS NOT NULL AND occurred_at >= cycle_start AND occurred_at < cycle_end
    ) x;
  IF pumps_running_now_v > pumps_operated_v THEN pumps_operated_v := pumps_running_now_v; END IF;

  IF is_free_today THEN
    pumps_peak_v := 0;
    minutes_peak_v := 0;
    post_lost_pump_min_v := 0;
    post_lost_min_v := 0;
    post_late_pumps_v := 0;
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

  SELECT d.lost_minutes, d.efficiency_percent
    INTO lost_pump_min_v, eff
    FROM public.calculate_energy_efficiency_for_date(_farm_id, cycle_date_local) d
   LIMIT 1;

  IF lost_pump_min_v IS NULL THEN
    lost_pump_min_v := COALESCE(post_lost_pump_min_v, 0) + COALESCE(gap_min_v, 0) + COALESCE(minutes_peak_v, 0);
  END IF;

  IF eff IS NULL THEN
    cycle_capacity_min := GREATEST(1, COALESCE(pumps_operated_v,0) * CASE WHEN is_free_today THEN 1440 ELSE 1260 END);
    eff := CASE WHEN COALESCE(pumps_operated_v,0) = 0 THEN 100
                ELSE ROUND(GREATEST(0::numeric, LEAST(100::numeric,
                  100::numeric - (lost_pump_min_v::numeric * 100::numeric / cycle_capacity_min::numeric)
                )), 1)
           END;
  END IF;

  -- Médias 7d/30d: EXCLUEM dias livres (is_free_demand IS NOT TRUE) para não inflar
  -- com os 100% gravados em sáb/dom/feriado. A soma de lost_minutes segue inalterada.
  SELECT COALESCE(SUM(lost_minutes),0)::int,
         ROUND(AVG(efficiency_percent) FILTER (WHERE is_free_demand IS NOT TRUE), 1)
    INTO lost_pump_min_7d_v, avg_7
    FROM energy_efficiency_daily
   WHERE farm_id = _farm_id AND date >= today_local - 7 AND date < today_local;

  SELECT COALESCE(SUM(lost_minutes),0)::int,
         ROUND(AVG(efficiency_percent) FILTER (WHERE is_free_demand IS NOT TRUE), 1)
    INTO lost_pump_min_30d_v, avg_30
    FROM energy_efficiency_daily
   WHERE farm_id = _farm_id AND date >= today_local - 30 AND date < today_local;

  RETURN jsonb_build_object(
    'timezone', tz,
    'cycle_date', cycle_date_local,
    'cycle_start', cycle_start,
    'cycle_start_local', cycle_start_local,
    'now_local', now_local,
    'is_free_demand', is_free_today,
    'pumps_operated', pumps_operated_v,
    'pumps_running_now', pumps_running_now_v,
    'post_peak_startup_time', post_on_v,
    'post_peak_last_startup_time', post_last_on_v,
    'post_lost_pump_minutes', post_lost_pump_min_v,
    'post_lost_minutes', post_lost_min_v,
    'post_late_pumps', post_late_pumps_v,
    'post_not_started_pumps', 0,
    'post_ok_count', post_ok_v,
    'post_pumps_seen', post_pumps_seen_v,
    'pre_peak_shutdown_time', pre_off_v,
    'pre_peak_last_shutdown_time', pre_last_off_v,
    'pre_lost_pump_minutes', pre_lost_pump_min_v,
    'pre_early_off_pumps', pre_early_off_pumps_v,
    'pre_local_pumps', pre_local_pumps_v,
    'pre_late_pumps', pre_late_pumps_v,
    'pre_avg_late_minutes', pre_avg_late_v,
    'pre_ok_count', pre_ok_v,
    'pumps_on_during_peak', pumps_peak_v,
    'peak_pump_minutes', minutes_peak_v,
    'minutes_on_during_peak', minutes_peak_v,
    'gap_minutes_today', gap_min_v,
    'gap_pump_minutes', gap_min_v,
    'lost_pump_minutes', lost_pump_min_v,
    'lost_minutes', lost_pump_min_v,
    'efficiency_percent', eff,
    'lost_pump_minutes_7d', lost_pump_min_7d_v,
    'lost_pump_minutes_30d', lost_pump_min_30d_v,
    'avg_efficiency_7d', avg_7,
    'avg_efficiency_30d', avg_30,
    'in_or_after_peak', in_or_after_today_peak,
    'after_cycle_start', after_today_peak
  );
END;
$function$;
