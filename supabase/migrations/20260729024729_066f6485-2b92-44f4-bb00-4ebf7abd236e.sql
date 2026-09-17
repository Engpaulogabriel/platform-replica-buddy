CREATE OR REPLACE FUNCTION public.inema_farm_score(p_farm_id uuid, p_date date DEFAULT CURRENT_DATE)
RETURNS TABLE (
  total_permits   int,
  avg_pct_hours   numeric,
  avg_pct_volume  numeric,
  alerts_pending  int
) LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT
    COUNT(*)::int,
    COALESCE(ROUND(AVG(d.pct_hours), 1), 0),
    COALESCE(ROUND(AVG(d.pct_volume), 1), 0),
    COUNT(*) FILTER (WHERE d.pct_hours >= 80 OR d.pct_volume >= 80)::int
  FROM public.inema_daily_compliance d
  WHERE d.farm_id = p_farm_id AND d.record_date = p_date;
$$;