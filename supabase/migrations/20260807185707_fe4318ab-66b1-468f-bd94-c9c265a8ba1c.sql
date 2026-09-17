CREATE TABLE IF NOT EXISTS public.scheduled_shutdowns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL,
  run_date date NOT NULL,
  attempt int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running',
  last_attempt_at timestamptz,
  targeted jsonb,
  remaining jsonb,
  alert_sent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, run_date)
);

GRANT SELECT ON public.scheduled_shutdowns TO authenticated;
GRANT ALL ON public.scheduled_shutdowns TO service_role;

ALTER TABLE public.scheduled_shutdowns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scheduled_shutdowns_select ON public.scheduled_shutdowns;
CREATE POLICY scheduled_shutdowns_select ON public.scheduled_shutdowns
  FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_scheduled_shutdowns_farm_date
  ON public.scheduled_shutdowns (farm_id, run_date DESC);

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;