DO $$
DECLARE
  ddl text;
BEGIN
  SELECT pg_get_functiondef('public.get_energy_efficiency_summary(uuid)'::regprocedure)
    INTO ddl;

  ddl := replace(
    ddl,
$old$
  SELECT ROUND(AVG(h.efficiency_percent), 1), COALESCE(SUM(h.lost_minutes), 0)::int
    INTO avg_7, lost_pump_min_7d_v
    FROM public.get_energy_efficiency_history(_farm_id, 7) h
   WHERE h.pumps_operated > 0 AND h.efficiency_percent IS NOT NULL;

  SELECT ROUND(AVG(h.efficiency_percent), 1), COALESCE(SUM(h.lost_minutes), 0)::int
    INTO avg_30, lost_pump_min_30d_v
    FROM public.get_energy_efficiency_history(_farm_id, 30) h
   WHERE h.pumps_operated > 0 AND h.efficiency_percent IS NOT NULL;
$old$,
$new$
  SELECT
    ROUND(AVG(eed.efficiency_percent) FILTER (WHERE eed.pumps_operated > 0 AND eed.efficiency_percent IS NOT NULL), 1),
    COALESCE(SUM(eed.lost_minutes), 0)::int
    INTO avg_7, lost_pump_min_7d_v
    FROM public.energy_efficiency_daily eed
   WHERE eed.farm_id = _farm_id
     AND eed.date >= today_local - 7
     AND eed.date <= today_local - 1;

  SELECT
    ROUND(AVG(eed.efficiency_percent) FILTER (WHERE eed.pumps_operated > 0 AND eed.efficiency_percent IS NOT NULL), 1),
    COALESCE(SUM(eed.lost_minutes), 0)::int
    INTO avg_30, lost_pump_min_30d_v
    FROM public.energy_efficiency_daily eed
   WHERE eed.farm_id = _farm_id
     AND eed.date >= today_local - 30
     AND eed.date <= today_local - 1;
$new$
  );

  IF ddl NOT LIKE '%FROM public.energy_efficiency_daily eed%' THEN
    RAISE EXCEPTION 'Não foi possível atualizar os acumulados do resumo de eficiência';
  END IF;

  EXECUTE ddl;
END $$;