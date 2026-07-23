CREATE TABLE IF NOT EXISTS public.whatsapp_alert_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE UNIQUE,
  alerts_enabled boolean NOT NULL DEFAULT false,
  alert_offline_enabled boolean NOT NULL DEFAULT true,
  alert_local_change_enabled boolean NOT NULL DEFAULT true,
  alert_peak_hours_enabled boolean NOT NULL DEFAULT true,
  peak_hour_start time NOT NULL DEFAULT '18:00',
  peak_hour_end time NOT NULL DEFAULT '21:00',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_alert_settings TO authenticated;
GRANT ALL ON public.whatsapp_alert_settings TO service_role;

ALTER TABLE public.whatsapp_alert_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Farm admins manage whatsapp alert settings"
  ON public.whatsapp_alert_settings
  FOR ALL
  TO authenticated
  USING (
    public.is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.farm_id = whatsapp_alert_settings.farm_id
        AND ur.role = ANY (ARRAY['admin'::public.app_role, 'owner'::public.app_role])
    )
  )
  WITH CHECK (
    public.is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.farm_id = whatsapp_alert_settings.farm_id
        AND ur.role = ANY (ARRAY['admin'::public.app_role, 'owner'::public.app_role])
    )
  );

CREATE TRIGGER touch_whatsapp_alert_settings_updated_at
  BEFORE UPDATE ON public.whatsapp_alert_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();