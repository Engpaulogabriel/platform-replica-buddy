
-- 1) Broadcasts table
CREATE TABLE IF NOT EXISTS public.whatsapp_broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message text NOT NULL,
  target text NOT NULL DEFAULT 'all',
  farm_id uuid REFERENCES public.farms(id) ON DELETE SET NULL,
  sent_by text,
  sent_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_broadcasts TO authenticated;
GRANT ALL ON public.whatsapp_broadcasts TO service_role;
ALTER TABLE public.whatsapp_broadcasts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "platform admins can manage broadcasts"
  ON public.whatsapp_broadcasts FOR ALL
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE INDEX IF NOT EXISTS idx_whatsapp_broadcasts_status ON public.whatsapp_broadcasts(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_broadcasts_created ON public.whatsapp_broadcasts(created_at DESC);

-- 2) Trial notifications log
CREATE TABLE IF NOT EXISTS public.whatsapp_trial_notifications_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  milestone text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, milestone)
);

GRANT SELECT ON public.whatsapp_trial_notifications_log TO authenticated;
GRANT ALL ON public.whatsapp_trial_notifications_log TO service_role;
ALTER TABLE public.whatsapp_trial_notifications_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "platform admins read trial log"
  ON public.whatsapp_trial_notifications_log FOR SELECT
  USING (public.is_platform_admin(auth.uid()));

-- 3) farms columns
ALTER TABLE public.farms ADD COLUMN IF NOT EXISTS trial_start_date timestamptz;
ALTER TABLE public.farms ADD COLUMN IF NOT EXISTS trial_end_date timestamptz;
ALTER TABLE public.farms ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'trial';

-- 4) RPCs (admin-only)
CREATE OR REPLACE FUNCTION public.platform_set_farm_trial(
  _farm_id uuid,
  _trial_start timestamptz DEFAULT NULL,
  _trial_end timestamptz DEFAULT NULL,
  _subscription_status text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden: apenas platform admin';
  END IF;
  UPDATE public.farms SET
    trial_start_date = COALESCE(_trial_start, trial_start_date),
    trial_end_date = COALESCE(_trial_end, trial_end_date),
    subscription_status = COALESCE(_subscription_status, subscription_status),
    updated_at = now()
  WHERE id = _farm_id;
END $$;

CREATE OR REPLACE FUNCTION public.platform_get_farm_trial(_farm_id uuid)
RETURNS TABLE (trial_start_date timestamptz, trial_end_date timestamptz, subscription_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden: apenas platform admin';
  END IF;
  RETURN QUERY
    SELECT f.trial_start_date, f.trial_end_date, f.subscription_status
    FROM public.farms f WHERE f.id = _farm_id;
END $$;
