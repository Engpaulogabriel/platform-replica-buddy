CREATE TABLE IF NOT EXISTS public.inema_compliance_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id             uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  equipment_id        uuid NOT NULL REFERENCES public.equipments(id) ON DELETE CASCADE,
  record_date         date NOT NULL,
  hours_used          numeric NOT NULL DEFAULT 0,
  volume_used_m3      numeric NOT NULL DEFAULT 0,
  max_daily_hours     numeric NOT NULL,
  max_daily_volume_m3 numeric,
  percent_used        numeric NOT NULL DEFAULT 0,
  alert_95_sent       boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inema_compliance_history_unique_daily UNIQUE (equipment_id, record_date)
);

CREATE INDEX IF NOT EXISTS idx_inema_compliance_history_farm ON public.inema_compliance_history(farm_id);
CREATE INDEX IF NOT EXISTS idx_inema_compliance_history_date ON public.inema_compliance_history(record_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inema_compliance_history TO authenticated;
GRANT ALL ON public.inema_compliance_history TO service_role;

CREATE OR REPLACE FUNCTION public.touch_inema_compliance_history_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_touch_inema_compliance_history ON public.inema_compliance_history;
CREATE TRIGGER trg_touch_inema_compliance_history BEFORE UPDATE ON public.inema_compliance_history
  FOR EACH ROW EXECUTE FUNCTION public.touch_inema_compliance_history_updated_at();

ALTER TABLE public.inema_compliance_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inema_compliance_history_select ON public.inema_compliance_history;
CREATE POLICY inema_compliance_history_select ON public.inema_compliance_history FOR SELECT
  TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id));

DROP POLICY IF EXISTS inema_compliance_history_write ON public.inema_compliance_history;
CREATE POLICY inema_compliance_history_write ON public.inema_compliance_history FOR ALL
  TO authenticated
  USING (public.is_farm_admin(auth.uid(), farm_id))
  WITH CHECK (public.is_farm_admin(auth.uid(), farm_id));