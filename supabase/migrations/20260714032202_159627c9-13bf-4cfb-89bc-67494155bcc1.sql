
CREATE TABLE IF NOT EXISTS public.watchdog_alerts_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL,
  alert_type TEXT NOT NULL,   -- bridge_down | pumps_offline | com_missing | agent_offline
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (farm_id, alert_type)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.watchdog_alerts_state TO authenticated;
GRANT ALL ON public.watchdog_alerts_state TO service_role;

ALTER TABLE public.watchdog_alerts_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "watchdog state — service role only"
  ON public.watchdog_alerts_state FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS watchdog_alerts_state_farm_active_idx
  ON public.watchdog_alerts_state (farm_id, is_active);
