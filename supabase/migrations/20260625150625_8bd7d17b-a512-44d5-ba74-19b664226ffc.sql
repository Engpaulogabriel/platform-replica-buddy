
CREATE TABLE public.automation_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NULL REFERENCES public.automations(id) ON DELETE SET NULL,
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('created','updated','deleted','activated','deactivated','executed','failed','expired')),
  equipment_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  action text NULL CHECK (action IS NULL OR action IN ('liga','desliga')),
  performed_by_name text NULL,
  performed_by_phone text NULL,
  performed_by_email text NULL,
  performed_via text NOT NULL CHECK (performed_via IN ('whatsapp','frontend','api','automation_engine')),
  trigger_type text NULL CHECK (trigger_type IS NULL OR trigger_type IN ('manual_schedule','time_trigger','condition_trigger','one_time','delay')),
  scheduled_time text NULL,
  actual_execution_time timestamptz NULL,
  result_details jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_automation_audit_farm_date ON public.automation_audit_log(farm_id, created_at DESC);
CREATE INDEX idx_automation_audit_automation ON public.automation_audit_log(automation_id);
CREATE INDEX idx_automation_audit_event ON public.automation_audit_log(farm_id, event_type, created_at DESC);

GRANT SELECT, INSERT ON public.automation_audit_log TO authenticated;
GRANT ALL ON public.automation_audit_log TO service_role;

ALTER TABLE public.automation_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view audit of their farm"
  ON public.automation_audit_log FOR SELECT TO authenticated
  USING (farm_id IN (SELECT farm_id FROM public.profiles WHERE id = auth.uid()));

CREATE POLICY "Users insert audit for their farm"
  ON public.automation_audit_log FOR INSERT TO authenticated
  WITH CHECK (farm_id IN (SELECT farm_id FROM public.profiles WHERE id = auth.uid()));
