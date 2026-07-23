ALTER TABLE public.energy_efficiency_daily
  ADD COLUMN IF NOT EXISTS cycle_date date GENERATED ALWAYS AS ("date") STORED,
  ADD COLUMN IF NOT EXISTS lost_pump_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS post_lost_pump_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pre_lost_pump_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gap_pump_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS peak_pump_minutes integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.compute_energy_efficiency(_farm_id uuid, _date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  is_free boolean;
  post_lost_v int := 0;
  pre_lost_v int := 0;
  peak_lost_v int := 0;
  gap_lost_v int := 0;
  lost_pump_v int := 0;
BEGIN
  is_free := public.is_free_demand_day(_date, _farm_id);

  SELECT * INTO r
  FROM public.calculate_energy_efficiency_for_date(_farm_id, _date)
  LIMIT 1;

  IF r.cycle_date IS NULL THEN
    RETURN;
  END IF;

  IF is_free THEN
    post_lost_v := 0;
    pre_lost_v := 0;
    peak_lost_v := 0;
    gap_lost_v := COALESCE(r.lost_minutes, 0);
    lost_pump_v := gap_lost_v;
  ELSE
    SELECT
      COALESCE(SUM(p.late_min), 0)::int,
      COALESCE(SUM(p.early_off_min), 0)::int,
      COALESCE(SUM(p.peak_minutes), 0)::int
      INTO post_lost_v, pre_lost_v, peak_lost_v
      FROM public.calculate_energy_efficiency_pumps_for_date(_farm_id, _date) p;

    gap_lost_v := GREATEST(0, COALESCE(r.lost_minutes, 0) - COALESCE(post_lost_v, 0) - COALESCE(peak_lost_v, 0));
    lost_pump_v := COALESCE(r.lost_minutes, 0);
  END IF;

  INSERT INTO public.energy_efficiency_daily
    (farm_id, date, pre_peak_shutdown_time, post_peak_startup_time,
     lost_minutes, lost_pump_minutes, post_lost_pump_minutes, pre_lost_pump_minutes,
     gap_pump_minutes, peak_pump_minutes,
     pumps_on_during_peak, efficiency_percent,
     pumps_operated, minutes_on_during_peak, pre_peak_ok_count, post_peak_ok_count,
     is_free_demand, updated_at)
  VALUES (
    _farm_id,
    r.cycle_date,
    CASE WHEN is_free THEN NULL ELSE r.pre_peak_shutdown_time END,
    CASE WHEN is_free THEN NULL ELSE r.post_peak_startup_time END,
    lost_pump_v,
    lost_pump_v,
    CASE WHEN is_free THEN 0 ELSE post_lost_v END,
    CASE WHEN is_free THEN 0 ELSE pre_lost_v END,
    gap_lost_v,
    CASE WHEN is_free THEN 0 ELSE peak_lost_v END,
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
    pre_peak_shutdown_time    = EXCLUDED.pre_peak_shutdown_time,
    post_peak_startup_time    = EXCLUDED.post_peak_startup_time,
    lost_minutes              = EXCLUDED.lost_minutes,
    lost_pump_minutes         = EXCLUDED.lost_pump_minutes,
    post_lost_pump_minutes    = EXCLUDED.post_lost_pump_minutes,
    pre_lost_pump_minutes     = EXCLUDED.pre_lost_pump_minutes,
    gap_pump_minutes          = EXCLUDED.gap_pump_minutes,
    peak_pump_minutes         = EXCLUDED.peak_pump_minutes,
    pumps_on_during_peak      = EXCLUDED.pumps_on_during_peak,
    efficiency_percent        = EXCLUDED.efficiency_percent,
    pumps_operated            = EXCLUDED.pumps_operated,
    minutes_on_during_peak    = EXCLUDED.minutes_on_during_peak,
    pre_peak_ok_count         = EXCLUDED.pre_peak_ok_count,
    post_peak_ok_count        = EXCLUDED.post_peak_ok_count,
    is_free_demand            = EXCLUDED.is_free_demand,
    updated_at                = now();

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