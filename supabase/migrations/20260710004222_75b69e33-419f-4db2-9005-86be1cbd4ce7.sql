
-- 1) Atualiza compute_energy_efficiency: dia livre = 100% e 0 min perdido, sem cálculo de gap
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
    -- Dia livre: sem obrigação operacional. Nenhum tempo perdido, eficiência 100%.
    post_lost_v := 0;
    pre_lost_v := 0;
    peak_lost_v := 0;
    gap_lost_v := 0;
    lost_pump_v := 0;
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
    CASE WHEN is_free THEN 100 ELSE COALESCE(r.efficiency_percent, 100) END,
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

-- 2) Backfill: força eficiência 100% e minutos zerados para dias livres já armazenados
UPDATE public.energy_efficiency_daily
   SET efficiency_percent     = 100,
       lost_minutes           = 0,
       lost_pump_minutes      = 0,
       post_lost_pump_minutes = 0,
       pre_lost_pump_minutes  = 0,
       gap_pump_minutes       = 0,
       peak_pump_minutes      = 0,
       pumps_on_during_peak   = 0,
       minutes_on_during_peak = 0,
       pre_peak_shutdown_time = NULL,
       post_peak_startup_time = NULL,
       updated_at             = now()
 WHERE is_free_demand = TRUE;

-- 3) Backfill: zera as métricas por bomba nos dias livres já armazenados
UPDATE public.energy_efficiency_daily_pumps p
   SET late_min       = 0,
       early_off_min  = 0,
       last_off       = NULL,
       peak_minutes   = 0,
       post_status    = 'ok',
       pre_status     = 'ok',
       peak_violation = false,
       updated_at     = now()
  FROM public.energy_efficiency_daily d
 WHERE d.farm_id = p.farm_id
   AND d.date = p.date
   AND d.is_free_demand = TRUE;

-- 4) Recalcula os últimos 31 dias para todas as fazendas (garante consistência total)
DO $$
DECLARE
  f record;
  dt date;
BEGIN
  FOR f IN SELECT id FROM public.farms LOOP
    FOR i IN 0..30 LOOP
      dt := (CURRENT_DATE - i);
      PERFORM public.compute_energy_efficiency(f.id, dt);
    END LOOP;
  END LOOP;
END$$;
