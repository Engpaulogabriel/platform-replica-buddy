ALTER TABLE public.farms ADD COLUMN IF NOT EXISTS security_phase smallint NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS public.agent_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  device_id uuid,
  machine_id_hash text,
  event_type text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address text,
  agent_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.agent_security_events TO authenticated;
GRANT ALL ON public.agent_security_events TO service_role;

ALTER TABLE public.agent_security_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform admins can view agent security events" ON public.agent_security_events;
CREATE POLICY "platform admins can view agent security events"
ON public.agent_security_events FOR SELECT TO authenticated
USING (public.is_platform_admin(auth.uid()) OR public.is_farm_admin(auth.uid(), farm_id));

CREATE INDEX IF NOT EXISTS idx_agent_security_events_farm_created
  ON public.agent_security_events (farm_id, created_at DESC);

UPDATE public.farms SET security_phase = 2 WHERE name ILIKE '%sykue%';