
-- =========================
-- AUTOMATIONS
-- =========================
CREATE TABLE public.automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('scheduled','rule_based','one_time')),
  is_active boolean NOT NULL DEFAULT true,
  created_by text,
  created_via text NOT NULL DEFAULT 'frontend' CHECK (created_via IN ('whatsapp','frontend')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_automations_farm ON public.automations(farm_id);
CREATE INDEX idx_automations_active ON public.automations(farm_id, is_active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.automations TO authenticated;
GRANT ALL ON public.automations TO service_role;

ALTER TABLE public.automations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view automations of their farm"
  ON public.automations FOR SELECT TO authenticated
  USING (farm_id IN (SELECT farm_id FROM public.profiles WHERE id = auth.uid()));

CREATE POLICY "Users insert automations on their farm"
  ON public.automations FOR INSERT TO authenticated
  WITH CHECK (farm_id IN (SELECT farm_id FROM public.profiles WHERE id = auth.uid()));

CREATE POLICY "Users update automations of their farm"
  ON public.automations FOR UPDATE TO authenticated
  USING (farm_id IN (SELECT farm_id FROM public.profiles WHERE id = auth.uid()));

CREATE POLICY "Users delete automations of their farm"
  ON public.automations FOR DELETE TO authenticated
  USING (farm_id IN (SELECT farm_id FROM public.profiles WHERE id = auth.uid()));

CREATE TRIGGER update_automations_updated_at
  BEFORE UPDATE ON public.automations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =========================
-- AUTOMATION ACTIONS
-- =========================
CREATE TABLE public.automation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  equipment_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  action text NOT NULL CHECK (action IN ('liga','desliga')),
  "order" integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_automation_actions_automation ON public.automation_actions(automation_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.automation_actions TO authenticated;
GRANT ALL ON public.automation_actions TO service_role;

ALTER TABLE public.automation_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage actions of their automations"
  ON public.automation_actions FOR ALL TO authenticated
  USING (automation_id IN (
    SELECT id FROM public.automations
    WHERE farm_id IN (SELECT farm_id FROM public.profiles WHERE id = auth.uid())
  ))
  WITH CHECK (automation_id IN (
    SELECT id FROM public.automations
    WHERE farm_id IN (SELECT farm_id FROM public.profiles WHERE id = auth.uid())
  ));

-- =========================
-- AUTOMATION TRIGGERS
-- =========================
CREATE TABLE public.automation_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  trigger_type text NOT NULL CHECK (trigger_type IN ('time','condition','delay')),
  time_value time NULL,
  days jsonb NULL,
  condition_type text NULL CHECK (condition_type IS NULL OR condition_type IN ('peak_hours_start','peak_hours_end','level_below','level_above')),
  condition_value text NULL,
  delay_minutes integer NULL,
  execute_once boolean NOT NULL DEFAULT false,
  last_executed_at timestamptz NULL,
  scheduled_for timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_automation_triggers_automation ON public.automation_triggers(automation_id);
CREATE INDEX idx_automation_triggers_scheduled ON public.automation_triggers(scheduled_for) WHERE scheduled_for IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.automation_triggers TO authenticated;
GRANT ALL ON public.automation_triggers TO service_role;

ALTER TABLE public.automation_triggers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage triggers of their automations"
  ON public.automation_triggers FOR ALL TO authenticated
  USING (automation_id IN (
    SELECT id FROM public.automations
    WHERE farm_id IN (SELECT farm_id FROM public.profiles WHERE id = auth.uid())
  ))
  WITH CHECK (automation_id IN (
    SELECT id FROM public.automations
    WHERE farm_id IN (SELECT farm_id FROM public.profiles WHERE id = auth.uid())
  ));

-- =========================
-- AUTOMATION EXECUTION HISTORY
-- =========================
CREATE TABLE public.automation_execution_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  triggered_at timestamptz NOT NULL DEFAULT now(),
  actions_executed jsonb NOT NULL DEFAULT '[]'::jsonb,
  all_success boolean NOT NULL DEFAULT false,
  notification_sent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_automation_history_automation ON public.automation_execution_history(automation_id, triggered_at DESC);

GRANT SELECT, INSERT ON public.automation_execution_history TO authenticated;
GRANT ALL ON public.automation_execution_history TO service_role;

ALTER TABLE public.automation_execution_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view history of their automations"
  ON public.automation_execution_history FOR SELECT TO authenticated
  USING (automation_id IN (
    SELECT id FROM public.automations
    WHERE farm_id IN (SELECT farm_id FROM public.profiles WHERE id = auth.uid())
  ));

CREATE POLICY "Service inserts history"
  ON public.automation_execution_history FOR INSERT TO authenticated
  WITH CHECK (automation_id IN (
    SELECT id FROM public.automations
    WHERE farm_id IN (SELECT farm_id FROM public.profiles WHERE id = auth.uid())
  ));
