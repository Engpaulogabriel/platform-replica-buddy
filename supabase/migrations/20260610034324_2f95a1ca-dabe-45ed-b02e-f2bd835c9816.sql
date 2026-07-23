
CREATE TABLE public.agent_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL UNIQUE REFERENCES public.farms(id) ON DELETE CASCADE,
  serial_port TEXT NOT NULL DEFAULT 'COM1',
  polling_interval_ms INTEGER NOT NULL DEFAULT 11000,
  sweep_timeout_ms INTEGER NOT NULL DEFAULT 5000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_config TO authenticated;
GRANT ALL ON public.agent_config TO service_role;

ALTER TABLE public.agent_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_config_select_members"
  ON public.agent_config FOR SELECT
  TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id) OR public.is_platform_staff(auth.uid()));

CREATE POLICY "agent_config_insert_members"
  ON public.agent_config FOR INSERT
  TO authenticated
  WITH CHECK (public.has_farm_access(auth.uid(), farm_id) OR public.is_platform_admin(auth.uid()));

CREATE POLICY "agent_config_update_admin"
  ON public.agent_config FOR UPDATE
  TO authenticated
  USING (
    public.is_platform_admin(auth.uid())
    OR public.has_farm_role(auth.uid(), farm_id, 'supervisor')
    OR public.has_farm_role(auth.uid(), farm_id, 'admin')
  )
  WITH CHECK (
    public.is_platform_admin(auth.uid())
    OR public.has_farm_role(auth.uid(), farm_id, 'supervisor')
    OR public.has_farm_role(auth.uid(), farm_id, 'admin')
  );

CREATE POLICY "agent_config_delete_admin"
  ON public.agent_config FOR DELETE
  TO authenticated
  USING (public.is_platform_admin(auth.uid()));

CREATE TRIGGER trg_agent_config_updated_at
  BEFORE UPDATE ON public.agent_config
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
