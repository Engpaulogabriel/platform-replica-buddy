
-- F2: behavioral rate limiting + fingerprint mismatch tracking

-- 1) API hits table for behavioral rate limiting
CREATE TABLE IF NOT EXISTS public.api_hits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  ip_address text,
  endpoint text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_hits_user_time ON public.api_hits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_hits_ip_time ON public.api_hits(ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_hits_endpoint_time ON public.api_hits(endpoint, created_at DESC);

GRANT SELECT, INSERT ON public.api_hits TO authenticated;
GRANT ALL ON public.api_hits TO service_role;
ALTER TABLE public.api_hits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api_hits_insert_own" ON public.api_hits
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "api_hits_select_own" ON public.api_hits
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- 2) Function to detect scraping/abusive patterns
CREATE OR REPLACE FUNCTION public.check_scraping_pattern(_user_id uuid)
RETURNS TABLE(is_abusive boolean, reason text, hits_last_minute int, distinct_endpoints int)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hits int;
  v_endpoints int;
BEGIN
  SELECT count(*), count(DISTINCT endpoint)
    INTO v_hits, v_endpoints
    FROM public.api_hits
    WHERE user_id = _user_id
      AND created_at > now() - interval '1 minute';

  IF v_hits > 300 THEN
    RETURN QUERY SELECT true, 'excessive_request_rate'::text, v_hits, v_endpoints;
    RETURN;
  END IF;

  IF v_endpoints > 40 THEN
    RETURN QUERY SELECT true, 'endpoint_scraping'::text, v_hits, v_endpoints;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, 'ok'::text, v_hits, v_endpoints;
END;
$$;

-- 3) Extend active_sessions with fingerprint_mismatch_count for detection
ALTER TABLE public.active_sessions
  ADD COLUMN IF NOT EXISTS fingerprint_mismatch_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_fingerprint_check timestamptz;

-- 4) Cleanup old api_hits (keep 24h)
CREATE OR REPLACE FUNCTION public.cleanup_api_hits()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.api_hits WHERE created_at < now() - interval '24 hours';
$$;
