-- =====================================================
-- FASE 5: RELATÓRIOS CONSOLIDADOS DA PLATAFORMA
-- =====================================================

-- Resumo consolidado por fazenda no período
CREATE OR REPLACE FUNCTION public.platform_reports_consolidated(
  p_since timestamptz DEFAULT (now() - interval '30 days'),
  p_until timestamptz DEFAULT now()
)
RETURNS TABLE (
  farm_id uuid,
  farm_name text,
  city text,
  state text,
  plan text,
  equipments_count int,
  users_count int,
  agent_online boolean,
  runtime_hours numeric,
  commands_total int,
  commands_success int,
  commands_failed int,
  automations_fired int,
  alerts_critical int,
  alerts_warning int,
  last_heartbeat timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_staff(auth.uid()) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    f.id AS farm_id,
    f.name AS farm_name,
    f.city,
    f.state,
    f.plan,
    COALESCE((SELECT count(*)::int FROM public.equipments e WHERE e.farm_id = f.id), 0) AS equipments_count,
    COALESCE((SELECT count(DISTINCT ur.user_id)::int FROM public.user_roles ur WHERE ur.farm_id = f.id), 0) AS users_count,
    COALESCE((SELECT (sh.last_heartbeat > now() - interval '5 minutes')
              FROM public.site_health sh WHERE sh.farm_id = f.id
              ORDER BY sh.last_heartbeat DESC LIMIT 1), false) AS agent_online,
    COALESCE((
      SELECT round((sum(COALESCE(pr.duration_seconds, EXTRACT(EPOCH FROM (LEAST(COALESCE(pr.ended_at, p_until), p_until) - GREATEST(pr.started_at, p_since))))) / 3600.0)::numeric, 2)
      FROM public.pump_runtime pr
      WHERE pr.farm_id = f.id
        AND pr.started_at < p_until
        AND COALESCE(pr.ended_at, now()) > p_since
    ), 0) AS runtime_hours,
    COALESCE((SELECT count(*)::int FROM public.commands c
              WHERE c.farm_id = f.id AND c.created_at BETWEEN p_since AND p_until), 0) AS commands_total,
    COALESCE((SELECT count(*)::int FROM public.commands c
              WHERE c.farm_id = f.id AND c.created_at BETWEEN p_since AND p_until
                AND c.status::text IN ('done','success','completed')), 0) AS commands_success,
    COALESCE((SELECT count(*)::int FROM public.commands c
              WHERE c.farm_id = f.id AND c.created_at BETWEEN p_since AND p_until
                AND c.status::text IN ('failed','timeout','error')), 0) AS commands_failed,
    COALESCE((SELECT count(*)::int FROM public.automation_log al
              WHERE al.farm_id = f.id AND al.occurred_at BETWEEN p_since AND p_until), 0) AS automations_fired,
    COALESCE((SELECT count(*)::int FROM public.agent_logs lg
              WHERE lg.farm_id = f.id AND lg.created_at BETWEEN p_since AND p_until
                AND lower(lg.level) IN ('error','critical','fatal')), 0)
      + COALESCE((SELECT count(*)::int FROM public.automation_log al
                  WHERE al.farm_id = f.id AND al.occurred_at BETWEEN p_since AND p_until
                    AND al.result::text = 'fail'), 0) AS alerts_critical,
    COALESCE((SELECT count(*)::int FROM public.agent_logs lg
              WHERE lg.farm_id = f.id AND lg.created_at BETWEEN p_since AND p_until
                AND lower(lg.level) IN ('warn','warning')), 0)
      + COALESCE((SELECT count(*)::int FROM public.automation_log al
                  WHERE al.farm_id = f.id AND al.occurred_at BETWEEN p_since AND p_until
                    AND al.result::text = 'blocked'), 0) AS alerts_warning,
    (SELECT max(sh.last_heartbeat) FROM public.site_health sh WHERE sh.farm_id = f.id) AS last_heartbeat
  FROM public.farms f
  ORDER BY f.name;
END;
$$;

-- Timeline diária cross-farm
CREATE OR REPLACE FUNCTION public.platform_reports_timeline(
  p_since timestamptz DEFAULT (now() - interval '30 days'),
  p_until timestamptz DEFAULT now()
)
RETURNS TABLE (
  day date,
  commands_total int,
  alerts_critical int,
  automations_fired int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_staff(auth.uid()) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  RETURN QUERY
  WITH days AS (
    SELECT generate_series(date_trunc('day', p_since), date_trunc('day', p_until), interval '1 day')::date AS day
  )
  SELECT
    d.day,
    COALESCE((SELECT count(*)::int FROM public.commands c
              WHERE date_trunc('day', c.created_at)::date = d.day), 0),
    COALESCE((SELECT count(*)::int FROM public.agent_logs lg
              WHERE date_trunc('day', lg.created_at)::date = d.day
                AND lower(lg.level) IN ('error','critical','fatal')), 0)
      + COALESCE((SELECT count(*)::int FROM public.automation_log al
                  WHERE date_trunc('day', al.occurred_at)::date = d.day
                    AND al.result::text = 'fail'), 0),
    COALESCE((SELECT count(*)::int FROM public.automation_log al
              WHERE date_trunc('day', al.occurred_at)::date = d.day), 0)
  FROM days d
  ORDER BY d.day;
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_reports_consolidated(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_reports_timeline(timestamptz, timestamptz) TO authenticated;