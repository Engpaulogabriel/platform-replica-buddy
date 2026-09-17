-- ============ user_activity_log ============
CREATE TABLE IF NOT EXISTS public.user_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  farm_id uuid,
  action text NOT NULL,
  path text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.user_activity_log TO authenticated;
GRANT ALL ON public.user_activity_log TO service_role;

ALTER TABLE public.user_activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_insert_own_activity" ON public.user_activity_log
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "users_read_own_activity" ON public.user_activity_log
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_platform_admin(auth.uid()));

CREATE INDEX IF NOT EXISTS idx_user_activity_user ON public.user_activity_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_activity_created ON public.user_activity_log(created_at DESC);

-- ============ rate_limit_violations ============
CREATE TABLE IF NOT EXISTS public.rate_limit_violations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  endpoint text NOT NULL,
  violation_type text NOT NULL DEFAULT 'rate_limit',
  hits integer NOT NULL DEFAULT 0,
  window_seconds integer NOT NULL DEFAULT 60,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.rate_limit_violations TO authenticated;
GRANT ALL ON public.rate_limit_violations TO service_role;

ALTER TABLE public.rate_limit_violations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins_read_violations" ON public.rate_limit_violations
  FOR SELECT TO authenticated USING (public.is_platform_admin(auth.uid()));

CREATE INDEX IF NOT EXISTS idx_rate_violations_user ON public.rate_limit_violations(user_id, created_at DESC);

-- ============ export_log ============
CREATE TABLE IF NOT EXISTS public.export_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  farm_id uuid,
  report_type text NOT NULL,
  format text NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.export_log TO authenticated;
GRANT ALL ON public.export_log TO service_role;

ALTER TABLE public.export_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_insert_own_export" ON public.export_log
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "users_read_own_export" ON public.export_log
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_platform_admin(auth.uid()));

CREATE INDEX IF NOT EXISTS idx_export_log_user ON public.export_log(user_id, created_at DESC);

-- ============ RPC: log_user_activity ============
CREATE OR REPLACE FUNCTION public.log_user_activity(
  _action text,
  _path text DEFAULT NULL,
  _farm_id uuid DEFAULT NULL,
  _metadata jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.user_activity_log (user_id, farm_id, action, path, metadata)
  VALUES (auth.uid(), _farm_id, _action, _path, COALESCE(_metadata, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ============ RPC: check_export_rate_limit ============
CREATE OR REPLACE FUNCTION public.check_export_rate_limit(
  _report_type text,
  _format text DEFAULT 'pdf',
  _row_count integer DEFAULT 0,
  _farm_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_count integer;
  v_limit integer := 20;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_authenticated');
  END IF;

  SELECT count(*) INTO v_count
  FROM public.export_log
  WHERE user_id = v_uid AND created_at > now() - interval '1 hour';

  IF v_count >= v_limit THEN
    INSERT INTO public.rate_limit_violations (user_id, endpoint, violation_type, hits, window_seconds, details)
    VALUES (v_uid, 'export:' || _report_type, 'export_limit', v_count, 3600,
            jsonb_build_object('format', _format, 'limit', v_limit));
    RETURN jsonb_build_object('allowed', false, 'reason', 'export_limit', 'hits', v_count, 'limit', v_limit);
  END IF;

  INSERT INTO public.export_log (user_id, farm_id, report_type, format, row_count)
  VALUES (v_uid, _farm_id, _report_type, _format, COALESCE(_row_count, 0));

  RETURN jsonb_build_object('allowed', true, 'hits', v_count + 1, 'limit', v_limit);
END;
$$;

-- ============ RPC: detect_security_anomalies ============
CREATE OR REPLACE FUNCTION public.detect_security_anomalies()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_found integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT user_id, count(*) AS hits, count(DISTINCT path) AS paths
    FROM public.user_activity_log
    WHERE created_at > now() - interval '5 minutes' AND user_id IS NOT NULL
    GROUP BY user_id
    HAVING count(*) > 300
  LOOP
    INSERT INTO public.rate_limit_violations (user_id, endpoint, violation_type, hits, window_seconds, details)
    VALUES (r.user_id, 'activity', 'anomaly_navigation', r.hits, 300,
            jsonb_build_object('distinct_paths', r.paths));
    v_found := v_found + 1;
  END LOOP;

  FOR r IN
    SELECT user_id, count(*) AS hits
    FROM public.export_log
    WHERE created_at > now() - interval '1 hour' AND user_id IS NOT NULL
    GROUP BY user_id
    HAVING count(*) > 30
  LOOP
    INSERT INTO public.rate_limit_violations (user_id, endpoint, violation_type, hits, window_seconds, details)
    VALUES (r.user_id, 'export', 'anomaly_export', r.hits, 3600, '{}'::jsonb);
    v_found := v_found + 1;
  END LOOP;

  DELETE FROM public.user_activity_log WHERE created_at < now() - interval '30 days';

  RETURN jsonb_build_object('anomalies', v_found, 'checked_at', now());
END;
$$;