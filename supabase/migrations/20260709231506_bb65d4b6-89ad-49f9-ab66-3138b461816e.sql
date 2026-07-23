DO $migration$
DECLARE
  ddl text;
  new_ddl text;
BEGIN
  ddl := pg_get_functiondef('public.get_energy_efficiency_summary(uuid)'::regprocedure);

  new_ddl := replace(
    ddl,
$old$
  lost_pump_min_v := COALESCE(post_lost_pump_min_v,0) + COALESCE(gap_min_v,0)
                   + COALESCE(pre_lost_pump_min_v,0) + COALESCE(minutes_peak_v,0);

  cycle_capacity_min := GREATEST(pumps_operated_v, post_pumps_seen_v) * CASE WHEN is_free_today THEN 1440 ELSE 1260 END;
  IF pumps_operated_v = 0 THEN eff := NULL;
  ELSIF cycle_capacity_min > 0 THEN
    eff := ROUND(GREATEST(0::numeric, LEAST(100::numeric,
      100::numeric - (lost_pump_min_v::numeric * 100::numeric / cycle_capacity_min::numeric)
    )), 1);
  END IF;
$old$,
$new$
  SELECT
    c.efficiency_percent,
    COALESCE(c.lost_minutes, 0),
    COALESCE(c.pumps_operated, pumps_operated_v),
    COALESCE(c.pumps_on_during_peak, pumps_peak_v),
    COALESCE(c.minutes_on_during_peak, minutes_peak_v),
    COALESCE(c.pre_peak_ok_count, pre_ok_v),
    COALESCE(c.post_peak_ok_count, post_ok_v),
    c.post_peak_startup_time,
    c.pre_peak_shutdown_time
    INTO eff,
         lost_pump_min_v,
         pumps_operated_v,
         pumps_peak_v,
         minutes_peak_v,
         pre_ok_v,
         post_ok_v,
         post_on_v,
         pre_off_v
    FROM public.calculate_energy_efficiency_for_date(_farm_id, today_local) c
    LIMIT 1;

  gap_min_v := GREATEST(0, COALESCE(lost_pump_min_v, 0) - COALESCE(post_lost_pump_min_v, 0) - COALESCE(minutes_peak_v, 0));
  gap_pumps_v := CASE WHEN gap_min_v > 0 THEN gap_pumps_v ELSE 0 END;
  pre_late_pumps_v := pumps_peak_v;
  pre_avg_late_v := CASE WHEN pumps_peak_v > 0 THEN (minutes_peak_v / pumps_peak_v)::int ELSE 0 END;
  cycle_capacity_min := GREATEST(pumps_operated_v, post_pumps_seen_v) * CASE WHEN is_free_today THEN 1440 ELSE 1260 END;
$new$
  );

  IF new_ddl = ddl THEN
    RAISE EXCEPTION 'get_energy_efficiency_summary total block not replaced';
  END IF;

  EXECUTE new_ddl;
END;
$migration$;