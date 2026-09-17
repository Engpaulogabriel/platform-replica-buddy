CREATE TABLE IF NOT EXISTS public.inema_permits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id             uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  equipment_id        uuid NOT NULL REFERENCES public.equipments(id) ON DELETE CASCADE,
  portaria_number     text,
  processo_number     text,
  titular_name        text,
  max_daily_hours     numeric NOT NULL DEFAULT 18,
  max_daily_volume_m3 numeric,
  expiration_date     date,
  latitude            double precision,
  longitude           double precision,
  observacoes         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inema_permits_equipment_unique UNIQUE (equipment_id)
);

CREATE INDEX IF NOT EXISTS idx_inema_permits_farm ON public.inema_permits(farm_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inema_permits TO authenticated;
GRANT ALL ON public.inema_permits TO service_role;

CREATE OR REPLACE FUNCTION public.touch_inema_permits_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_touch_inema_permits ON public.inema_permits;
CREATE TRIGGER trg_touch_inema_permits BEFORE UPDATE ON public.inema_permits
  FOR EACH ROW EXECUTE FUNCTION public.touch_inema_permits_updated_at();

ALTER TABLE public.inema_permits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inema_permits_select ON public.inema_permits;
CREATE POLICY inema_permits_select ON public.inema_permits FOR SELECT
  TO authenticated
  USING (has_farm_access(auth.uid(), farm_id));

DROP POLICY IF EXISTS inema_permits_write ON public.inema_permits;
CREATE POLICY inema_permits_write ON public.inema_permits FOR ALL
  TO authenticated
  USING (is_farm_admin(auth.uid(), farm_id))
  WITH CHECK (is_farm_admin(auth.uid(), farm_id));

INSERT INTO public.inema_permits
  (farm_id, equipment_id, portaria_number, processo_number, titular_name,
   max_daily_hours, max_daily_volume_m3, expiration_date)
SELECT e.farm_id, e.id, v.portaria, v.processo, v.titular, 18, v.vol, DATE '2027-02-17'
FROM public.equipments e
JOIN (VALUES
  ('POÇO 01','27.975','2022.001.004223/INEMA/LIC-04223','Jorge Luiz Pinto Saldanha', 3582),
  ('POÇO 02','27.975','2022.001.004223/INEMA/LIC-04223','Jorge Luiz Pinto Saldanha', 3582),
  ('POÇO 03','27.975','2022.001.004223/INEMA/LIC-04223','Jorge Luiz Pinto Saldanha', 3582),
  ('POÇO 04','27.975','2022.001.004223/INEMA/LIC-04223','Jorge Luiz Pinto Saldanha', 3582),
  ('POÇO 05','27.975','2022.001.004223/INEMA/LIC-04223','Jorge Luiz Pinto Saldanha', 3582),
  ('POÇO 06','27.975','2022.001.004223/INEMA/LIC-04223','Jorge Luiz Pinto Saldanha', 3582),
  ('POÇO 07','27.971','2022.001.004976/INEMA/LIC-04976','Armindo Brugnera',          3600),
  ('POÇO 08','27.971','2022.001.004976/INEMA/LIC-04976','Armindo Brugnera',          5400)
) AS v(nome, portaria, processo, titular, vol)
  ON upper(trim(e.name)) = upper(v.nome)
WHERE e.farm_id = 'f2d585b0-c0d6-4038-985f-5bc134e737ae'
ON CONFLICT (equipment_id) DO UPDATE SET
  portaria_number     = EXCLUDED.portaria_number,
  processo_number     = EXCLUDED.processo_number,
  titular_name        = EXCLUDED.titular_name,
  max_daily_hours     = EXCLUDED.max_daily_hours,
  max_daily_volume_m3 = EXCLUDED.max_daily_volume_m3,
  expiration_date     = EXCLUDED.expiration_date,
  updated_at          = now();