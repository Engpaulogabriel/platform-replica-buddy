CREATE TABLE IF NOT EXISTS public.scheduled_automations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id               uuid NOT NULL,
  name                  text NOT NULL,
  action                text NOT NULL DEFAULT 'shutdown_all'
                          CHECK (action IN ('shutdown_all', 'shutdown_specific')),
  time_brt              text NOT NULL CHECK (time_brt ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  days_of_week          text[] NOT NULL DEFAULT ARRAY['mon','tue','wed','thu','fri'],
  excluded_equipment_ids uuid[] NOT NULL DEFAULT '{}',
  target_equipment_ids  uuid[] NOT NULL DEFAULT '{}',
  retry_interval_min    int  NOT NULL DEFAULT 5  CHECK (retry_interval_min BETWEEN 1 AND 60),
  max_retries           int  NOT NULL DEFAULT 3  CHECK (max_retries BETWEEN 1 AND 10),
  alert_after_retries   boolean NOT NULL DEFAULT true,
  is_active             boolean NOT NULL DEFAULT true,
  last_run_at           timestamptz,
  last_run_result       jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduled_automations TO authenticated;
GRANT ALL ON public.scheduled_automations TO service_role;

ALTER TABLE public.scheduled_automations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scheduled_automations_select ON public.scheduled_automations;
CREATE POLICY scheduled_automations_select ON public.scheduled_automations
  FOR SELECT TO authenticated USING (public.can_write_farm(auth.uid(), farm_id));
DROP POLICY IF EXISTS scheduled_automations_insert ON public.scheduled_automations;
CREATE POLICY scheduled_automations_insert ON public.scheduled_automations
  FOR INSERT TO authenticated WITH CHECK (public.can_write_farm(auth.uid(), farm_id));
DROP POLICY IF EXISTS scheduled_automations_update ON public.scheduled_automations;
CREATE POLICY scheduled_automations_update ON public.scheduled_automations
  FOR UPDATE TO authenticated USING (public.can_write_farm(auth.uid(), farm_id))
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));
DROP POLICY IF EXISTS scheduled_automations_delete ON public.scheduled_automations;
CREATE POLICY scheduled_automations_delete ON public.scheduled_automations
  FOR DELETE TO authenticated USING (public.can_write_farm(auth.uid(), farm_id));

CREATE INDEX IF NOT EXISTS idx_scheduled_automations_active
  ON public.scheduled_automations (is_active) WHERE is_active;

ALTER TABLE public.scheduled_shutdowns ADD COLUMN IF NOT EXISTS automation_id uuid;
ALTER TABLE public.scheduled_shutdowns ADD COLUMN IF NOT EXISTS steps_done  jsonb   NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.scheduled_shutdowns ADD COLUMN IF NOT EXISTS alert1_sent boolean NOT NULL DEFAULT false;
ALTER TABLE public.scheduled_shutdowns ADD COLUMN IF NOT EXISTS alert2_sent boolean NOT NULL DEFAULT false;

ALTER TABLE public.scheduled_shutdowns DROP CONSTRAINT IF EXISTS scheduled_shutdowns_farm_id_run_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_shutdowns_automation_date
  ON public.scheduled_shutdowns (automation_id, run_date);

DROP POLICY IF EXISTS scheduled_shutdowns_select ON public.scheduled_shutdowns;
CREATE POLICY scheduled_shutdowns_select ON public.scheduled_shutdowns
  FOR SELECT TO authenticated USING (public.can_write_farm(auth.uid(), farm_id));

GRANT SELECT ON public.scheduled_shutdowns TO authenticated;
GRANT ALL ON public.scheduled_shutdowns TO service_role;

INSERT INTO public.scheduled_automations
  (farm_id, name, action, time_brt, days_of_week, excluded_equipment_ids,
   retry_interval_min, max_retries, alert_after_retries, is_active)
VALUES
  ('0b1d53df-6d5c-4674-8517-9299aac3ec18', 'Desligamento 17h Semear', 'shutdown_all',
   '17:00', ARRAY['mon','tue','wed','thu','fri'], '{}', 5, 3, true, true)
ON CONFLICT (farm_id, name) DO NOTHING;