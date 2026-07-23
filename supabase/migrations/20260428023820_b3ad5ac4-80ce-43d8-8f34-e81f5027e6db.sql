-- =====================================================
-- FASE 4: ALERTAS E AUDITORIA EM TEMPO REAL
-- =====================================================

-- Tabela para rastrear alertas lidos por admin
CREATE TABLE IF NOT EXISTS public.platform_alert_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  alert_source text NOT NULL, -- 'agent_logs' | 'automation_log'
  alert_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, alert_source, alert_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_alert_reads_user
  ON public.platform_alert_reads(user_id, alert_source, alert_id);

ALTER TABLE public.platform_alert_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "platform_alert_reads_own_select"
  ON public.platform_alert_reads FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() AND public.is_platform_staff(auth.uid()));

CREATE POLICY "platform_alert_reads_own_insert"
  ON public.platform_alert_reads FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.is_platform_staff(auth.uid()));

CREATE POLICY "platform_alert_reads_own_delete"
  ON public.platform_alert_reads FOR DELETE
  TO authenticated
  USING (user_id = auth.uid() AND public.is_platform_staff(auth.uid()));

-- =====================================================
-- FEED UNIFICADO DE ALERTAS
-- =====================================================
CREATE OR REPLACE FUNCTION public.platform_alerts_feed(
  p_farm_id uuid DEFAULT NULL,
  p_severity text DEFAULT NULL,    -- 'critical' | 'warning' | 'info' | NULL=all
  p_category text DEFAULT NULL,    -- filtra por category de agent_logs
  p_unread_only boolean DEFAULT false,
  p_since timestamptz DEFAULT (now() - interval '7 days'),
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  source text,
  alert_id uuid,
  farm_id uuid,
  farm_name text,
  occurred_at timestamptz,
  severity text,
  category text,
  title text,
  message text,
  details jsonb,
  is_read boolean
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
  WITH agent AS (
    SELECT
      'agent_logs'::text AS source,
      al.id AS alert_id,
      al.farm_id,
      al.created_at AS occurred_at,
      CASE
        WHEN lower(al.level) IN ('error','critical','fatal') THEN 'critical'
        WHEN lower(al.level) IN ('warn','warning') THEN 'warning'
        ELSE 'info'
      END AS severity,
      al.category,
      COALESCE(NULLIF(left(al.message, 80), ''), al.category) AS title,
      al.message,
      jsonb_build_object('raw_frame', al.raw_frame, 'level', al.level) AS details
    FROM public.agent_logs al
    WHERE al.created_at >= p_since
      AND lower(al.level) IN ('error','critical','fatal','warn','warning')
  ),
  autom AS (
    SELECT
      'automation_log'::text AS source,
      l.id AS alert_id,
      l.farm_id,
      l.occurred_at,
      CASE
        WHEN l.result::text = 'fail' THEN 'critical'
        WHEN l.result::text = 'blocked' THEN 'warning'
        ELSE 'info'
      END AS severity,
      'automation'::text AS category,
      (l.equipment_name || ' — ' || l.action::text || ' (' || l.result::text || ')') AS title,
      COALESCE(l.details->>'reason', l.action::text || ' ' || l.result::text) AS message,
      l.details
    FROM public.automation_log l
    WHERE l.occurred_at >= p_since
      AND l.result::text IN ('fail','blocked')
  ),
  unioned AS (
    SELECT * FROM agent
    UNION ALL
    SELECT * FROM autom
  )
  SELECT
    u.source,
    u.alert_id,
    u.farm_id,
    f.name AS farm_name,
    u.occurred_at,
    u.severity,
    u.category,
    u.title,
    u.message,
    u.details,
    EXISTS (
      SELECT 1 FROM public.platform_alert_reads r
      WHERE r.user_id = auth.uid()
        AND r.alert_source = u.source
        AND r.alert_id = u.alert_id
    ) AS is_read
  FROM unioned u
  LEFT JOIN public.farms f ON f.id = u.farm_id
  WHERE (p_farm_id IS NULL OR u.farm_id = p_farm_id)
    AND (p_severity IS NULL OR u.severity = p_severity)
    AND (p_category IS NULL OR u.category = p_category)
    AND (
      NOT p_unread_only
      OR NOT EXISTS (
        SELECT 1 FROM public.platform_alert_reads r
        WHERE r.user_id = auth.uid()
          AND r.alert_source = u.source
          AND r.alert_id = u.alert_id
      )
    )
  ORDER BY u.occurred_at DESC
  LIMIT p_limit;
END;
$$;

-- =====================================================
-- ESTATÍSTICAS RÁPIDAS
-- =====================================================
CREATE OR REPLACE FUNCTION public.platform_alerts_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total int;
  v_unread int;
  v_critical_today int;
  v_warning_24h int;
BEGIN
  IF NOT public.is_platform_staff(auth.uid()) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  WITH base AS (
    SELECT id, created_at AS occurred_at,
      CASE WHEN lower(level) IN ('error','critical','fatal') THEN 'critical'
           WHEN lower(level) IN ('warn','warning') THEN 'warning' ELSE 'info' END AS sev,
      'agent_logs'::text AS src
    FROM public.agent_logs
    WHERE created_at >= now() - interval '7 days'
      AND lower(level) IN ('error','critical','fatal','warn','warning')
    UNION ALL
    SELECT id, occurred_at,
      CASE WHEN result::text = 'fail' THEN 'critical'
           WHEN result::text = 'blocked' THEN 'warning' ELSE 'info' END,
      'automation_log'
    FROM public.automation_log
    WHERE occurred_at >= now() - interval '7 days'
      AND result::text IN ('fail','blocked')
  )
  SELECT
    count(*),
    count(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1 FROM public.platform_alert_reads r
        WHERE r.user_id = auth.uid() AND r.alert_source = base.src AND r.alert_id = base.id
      )
    ),
    count(*) FILTER (WHERE sev = 'critical' AND occurred_at >= date_trunc('day', now())),
    count(*) FILTER (WHERE sev = 'warning' AND occurred_at >= now() - interval '24 hours')
  INTO v_total, v_unread, v_critical_today, v_warning_24h
  FROM base;

  RETURN jsonb_build_object(
    'total_7d', COALESCE(v_total, 0),
    'unread', COALESCE(v_unread, 0),
    'critical_today', COALESCE(v_critical_today, 0),
    'warning_24h', COALESCE(v_warning_24h, 0)
  );
END;
$$;

-- =====================================================
-- MARCAR COMO LIDO
-- =====================================================
CREATE OR REPLACE FUNCTION public.platform_alerts_mark_read(
  p_source text,
  p_alert_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_staff(auth.uid()) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF p_source NOT IN ('agent_logs','automation_log') THEN
    RAISE EXCEPTION 'invalid source';
  END IF;
  INSERT INTO public.platform_alert_reads (user_id, alert_source, alert_id)
  VALUES (auth.uid(), p_source, p_alert_id)
  ON CONFLICT (user_id, alert_source, alert_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_alerts_mark_all_read(
  p_until timestamptz DEFAULT now()
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int := 0;
BEGIN
  IF NOT public.is_platform_staff(auth.uid()) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  WITH ins AS (
    INSERT INTO public.platform_alert_reads (user_id, alert_source, alert_id)
    SELECT auth.uid(), 'agent_logs', al.id
    FROM public.agent_logs al
    WHERE al.created_at <= p_until
      AND al.created_at >= now() - interval '30 days'
      AND lower(al.level) IN ('error','critical','fatal','warn','warning')
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;

  WITH ins2 AS (
    INSERT INTO public.platform_alert_reads (user_id, alert_source, alert_id)
    SELECT auth.uid(), 'automation_log', l.id
    FROM public.automation_log l
    WHERE l.occurred_at <= p_until
      AND l.occurred_at >= now() - interval '30 days'
      AND l.result::text IN ('fail','blocked')
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT v_count + count(*) INTO v_count FROM ins2;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_alerts_feed(uuid, text, text, boolean, timestamptz, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_alerts_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_alerts_mark_read(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_alerts_mark_all_read(timestamptz) TO authenticated;