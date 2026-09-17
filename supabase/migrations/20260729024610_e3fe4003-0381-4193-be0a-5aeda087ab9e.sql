CREATE TABLE IF NOT EXISTS public.inema_daily_compliance (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id             uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  equipment_id        uuid NOT NULL REFERENCES public.equipments(id) ON DELETE CASCADE,
  record_date         date NOT NULL DEFAULT CURRENT_DATE,
  hours_used          numeric NOT NULL DEFAULT 0,
  volume_used_m3      numeric NOT NULL DEFAULT 0,
  max_daily_hours     numeric NOT NULL DEFAULT 18,
  max_daily_volume_m3 numeric,
  pct_hours           numeric GENERATED ALWAYS AS (
    CASE WHEN max_daily_hours > 0 THEN ROUND((hours_used / max_daily_hours) * 100, 1) ELSE 0 END
  ) STORED,
  pct_volume          numeric GENERATED ALWAYS AS (
    CASE WHEN max_daily_volume_m3 > 0 THEN ROUND((volume_used_m3 / max_daily_volume_m3) * 100, 1) ELSE 0 END
  ) STORED,
  alert_80_sent       boolean NOT NULL DEFAULT false,
  alert_95_sent       boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inema_daily_unique UNIQUE (equipment_id, record_date)
);

CREATE INDEX IF NOT EXISTS idx_inema_daily_farm ON public.inema_daily_compliance(farm_id);
CREATE INDEX IF NOT EXISTS idx_inema_daily_date ON public.inema_daily_compliance(record_date DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inema_daily_compliance TO authenticated;
GRANT ALL ON public.inema_daily_compliance TO service_role;

CREATE OR REPLACE FUNCTION public.touch_inema_daily_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_touch_inema_daily ON public.inema_daily_compliance;
CREATE TRIGGER trg_touch_inema_daily BEFORE UPDATE ON public.inema_daily_compliance
  FOR EACH ROW EXECUTE FUNCTION public.touch_inema_daily_updated_at();

ALTER TABLE public.inema_daily_compliance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inema_daily_select ON public.inema_daily_compliance;
CREATE POLICY inema_daily_select ON public.inema_daily_compliance FOR SELECT
  TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id));

DROP POLICY IF EXISTS inema_daily_write ON public.inema_daily_compliance;
CREATE POLICY inema_daily_write ON public.inema_daily_compliance FOR ALL
  TO authenticated
  USING (public.is_farm_admin(auth.uid(), farm_id))
  WITH CHECK (public.is_farm_admin(auth.uid(), farm_id));