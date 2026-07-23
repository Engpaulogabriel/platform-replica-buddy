
CREATE TABLE IF NOT EXISTS public.farm_timing_config (
  farm_id uuid PRIMARY KEY,
  comm_system_seconds integer NOT NULL DEFAULT 3,
  comm_levels_seconds integer NOT NULL DEFAULT 10,
  offline_auto_seconds integer NOT NULL DEFAULT 1200,
  offline_levels_seconds integer NOT NULL DEFAULT 60,
  auto_reset_minutes integer NOT NULL DEFAULT 2,
  default_polling_seconds integer NOT NULL DEFAULT 8,
  default_command_timeout_ms integer NOT NULL DEFAULT 10000,
  agent_backoff_seconds integer NOT NULL DEFAULT 60,
  agent_backoff_after_timeouts integer NOT NULL DEFAULT 3,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

ALTER TABLE public.farm_timing_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY ftc_select_members ON public.farm_timing_config
  FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));

CREATE POLICY ftc_insert_admin ON public.farm_timing_config
  FOR INSERT TO authenticated
  WITH CHECK (is_platform_admin(auth.uid()));

CREATE POLICY ftc_update_admin ON public.farm_timing_config
  FOR UPDATE TO authenticated
  USING (is_platform_admin(auth.uid()))
  WITH CHECK (is_platform_admin(auth.uid()));

CREATE POLICY ftc_delete_admin ON public.farm_timing_config
  FOR DELETE TO authenticated
  USING (is_platform_admin(auth.uid()));

CREATE OR REPLACE FUNCTION public.farm_timing_config_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER farm_timing_config_set_updated_at
  BEFORE UPDATE ON public.farm_timing_config
  FOR EACH ROW EXECUTE FUNCTION public.farm_timing_config_touch();
