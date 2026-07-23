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
    SELECT e.id
      FROM public.equipments e
     WHERE e.farm_id = _farm_id
       AND e.active = true
       AND e.type::text IN ('poco','bombeamento','conjunto','rio')
       AND COALESCE(e.participates_night_cycle, true) = true
  ),
  runtime_overlaps AS (
    SELECT pr.equipment_id,
           GREATEST(
             0,
             EXTRACT(epoch FROM (
               LEAST(COALESCE(pr.ended_at, now()), _window_end)
               - GREATEST(pr.started_at, _window_start)
             )) / 60.0
           ) AS minutes
      FROM public.pump_runtime pr
      JOIN pump_equipment pe ON pe.id = pr.equipment_id
     WHERE pr.farm_id = _farm_id
       AND _window_end > _window_start
       AND pr.started_at < _window_end
       AND COALESCE(pr.ended_at, now()) > _window_start
  )
  SELECT ro.equipment_id,
         FLOOR(SUM(ro.minutes))::integer AS peak_minutes
    FROM runtime_overlaps ro
   GROUP BY ro.equipment_id
  HAVING FLOOR(SUM(ro.minutes))::integer > 0;
$function$;

GRANT EXECUTE ON FUNCTION public.calculate_pump_peak_minutes_for_window(uuid, timestamp with time zone, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_pump_peak_minutes_for_window(uuid, timestamp with time zone, timestamp with time zone) TO service_role;