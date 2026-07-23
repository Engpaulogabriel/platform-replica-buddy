
CREATE TABLE public.whatsapp_operators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID REFERENCES public.farms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  can_turn_on BOOLEAN NOT NULL DEFAULT true,
  can_turn_off BOOLEAN NOT NULL DEFAULT true,
  can_check_status BOOLEAN NOT NULL DEFAULT true,
  receive_alerts BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_operators TO authenticated;
GRANT ALL ON public.whatsapp_operators TO service_role;

ALTER TABLE public.whatsapp_operators ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Farm members can view whatsapp operators"
  ON public.whatsapp_operators FOR SELECT
  TO authenticated
  USING (
    public.is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.farm_id = whatsapp_operators.farm_id
    )
  );

CREATE POLICY "Farm admins can manage whatsapp operators"
  ON public.whatsapp_operators FOR ALL
  TO authenticated
  USING (
    public.is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.farm_id = whatsapp_operators.farm_id
        AND ur.role IN ('admin','owner')
    )
  )
  WITH CHECK (
    public.is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.farm_id = whatsapp_operators.farm_id
        AND ur.role IN ('admin','owner')
    )
  );

CREATE TABLE public.whatsapp_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL UNIQUE REFERENCES public.farms(id) ON DELETE CASCADE,
  bot_number TEXT,
  is_connected BOOLEAN NOT NULL DEFAULT false,
  alert_on_failure BOOLEAN NOT NULL DEFAULT true,
  alert_on_local_action BOOLEAN NOT NULL DEFAULT true,
  alert_on_offline BOOLEAN NOT NULL DEFAULT true,
  alert_on_bridge_down BOOLEAN NOT NULL DEFAULT true,
  offline_threshold_minutes INTEGER NOT NULL DEFAULT 5,
  daily_summary BOOLEAN NOT NULL DEFAULT false,
  ai_enabled BOOLEAN NOT NULL DEFAULT true,
  audio_transcription BOOLEAN NOT NULL DEFAULT true,
  tech_group_id TEXT,
  ai_instructions TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_config TO authenticated;
GRANT ALL ON public.whatsapp_config TO service_role;

ALTER TABLE public.whatsapp_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Farm members can view whatsapp config"
  ON public.whatsapp_config FOR SELECT
  TO authenticated
  USING (
    public.is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.farm_id = whatsapp_config.farm_id
    )
  );

CREATE POLICY "Farm admins can manage whatsapp config"
  ON public.whatsapp_config FOR ALL
  TO authenticated
  USING (
    public.is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.farm_id = whatsapp_config.farm_id
        AND ur.role IN ('admin','owner')
    )
  )
  WITH CHECK (
    public.is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.farm_id = whatsapp_config.farm_id
        AND ur.role IN ('admin','owner')
    )
  );

CREATE TRIGGER update_whatsapp_operators_updated_at
  BEFORE UPDATE ON public.whatsapp_operators
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER update_whatsapp_config_updated_at
  BEFORE UPDATE ON public.whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX idx_whatsapp_operators_farm ON public.whatsapp_operators(farm_id);
