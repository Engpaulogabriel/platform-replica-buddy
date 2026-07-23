
-- Hardware fingerprint tracking for Electron Agent (Phase B)
CREATE TABLE IF NOT EXISTS public.agent_hardware (
  farm_id uuid PRIMARY KEY,
  fingerprint jsonb NOT NULL DEFAULT '{}'::jsonb,
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_check_at timestamptz NOT NULL DEFAULT now(),
  alert_level text NOT NULL DEFAULT 'ok',  -- 'ok' | 'warning' | 'blocked'
  changed_components text[] NOT NULL DEFAULT '{}',
  last_change_at timestamptz,
  agent_version text,
  reset_requested boolean NOT NULL DEFAULT false,
  reset_requested_by uuid,
  reset_requested_at timestamptz,
  CONSTRAINT agent_hardware_alert_chk CHECK (alert_level IN ('ok','warning','blocked'))
);

ALTER TABLE public.agent_hardware ENABLE ROW LEVEL SECURITY;

CREATE POLICY ah_select_members ON public.agent_hardware
  FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));

CREATE POLICY ah_insert_writers ON public.agent_hardware
  FOR INSERT TO authenticated
  WITH CHECK (can_write_farm(auth.uid(), farm_id));

CREATE POLICY ah_update_writers ON public.agent_hardware
  FOR UPDATE TO authenticated
  USING (can_write_farm(auth.uid(), farm_id) OR is_platform_admin(auth.uid()))
  WITH CHECK (can_write_farm(auth.uid(), farm_id) OR is_platform_admin(auth.uid()));

CREATE POLICY ah_delete_admin ON public.agent_hardware
  FOR DELETE TO authenticated
  USING (is_platform_admin(auth.uid()));

CREATE TABLE IF NOT EXISTS public.agent_hardware_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL,
  changed_components text[] NOT NULL DEFAULT '{}',
  previous_fingerprint jsonb,
  current_fingerprint jsonb,
  alert_level text NOT NULL,
  agent_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_hardware_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY ahh_select_members ON public.agent_hardware_history
  FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));

CREATE POLICY ahh_insert_writers ON public.agent_hardware_history
  FOR INSERT TO authenticated
  WITH CHECK (can_write_farm(auth.uid(), farm_id));

CREATE INDEX IF NOT EXISTS ahh_farm_idx ON public.agent_hardware_history(farm_id, created_at DESC);

-- RPC para platform_admin reautorizar hardware (limpa o fingerprint registrado)
CREATE OR REPLACE FUNCTION public.reset_agent_hardware(_farm_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.agent_hardware
     SET reset_requested = true,
         reset_requested_by = auth.uid(),
         reset_requested_at = now(),
         alert_level = 'ok',
         changed_components = '{}'
   WHERE farm_id = _farm_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_agent_hardware(uuid) TO authenticated;
