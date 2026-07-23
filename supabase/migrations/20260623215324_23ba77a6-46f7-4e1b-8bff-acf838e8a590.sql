CREATE TABLE public.peak_hour_config (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  farm_id UUID NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  start_time TIME NOT NULL DEFAULT '17:30',
  end_time TIME NOT NULL DEFAULT '21:00',
  auto_restart BOOLEAN NOT NULL DEFAULT true,
  excluded_equipment_ids UUID[] NOT NULL DEFAULT '{}',
  last_peak_off_at TIMESTAMPTZ,
  last_peak_on_at TIMESTAMPTZ,
  affected_equipment_ids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.peak_hour_config TO authenticated;
GRANT ALL ON public.peak_hour_config TO service_role;

ALTER TABLE public.peak_hour_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "peak_select_members" ON public.peak_hour_config FOR SELECT
TO authenticated
USING (public.has_farm_access(auth.uid(), farm_id) OR public.is_platform_staff(auth.uid()));

CREATE POLICY "peak_insert_members" ON public.peak_hour_config FOR INSERT
TO authenticated
WITH CHECK (public.has_farm_access(auth.uid(), farm_id) OR public.is_platform_staff(auth.uid()));

CREATE POLICY "peak_update_members" ON public.peak_hour_config FOR UPDATE
TO authenticated
USING (public.has_farm_access(auth.uid(), farm_id) OR public.is_platform_staff(auth.uid()));

CREATE POLICY "peak_delete_admin" ON public.peak_hour_config FOR DELETE
TO authenticated
USING (public.is_platform_admin(auth.uid()));

CREATE TRIGGER update_peak_hour_config_updated_at
BEFORE UPDATE ON public.peak_hour_config
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();