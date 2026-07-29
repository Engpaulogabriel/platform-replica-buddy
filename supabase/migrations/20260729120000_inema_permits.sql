-- ============================================================================
-- INEMA — Compliance Hídrico: outorgas POR POÇO (uma linha por equipamento).
-- Cruza uso real (horas + volume) com os limites legais da outorga.
-- Aplicar no SQL Editor do projeto (Lovable-gerenciado).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.inema_permits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id             uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  equipment_id        uuid NOT NULL REFERENCES public.equipments(id) ON DELETE CASCADE,
  portaria_number     text,
  processo_number     text,
  titular_name        text,
  max_daily_hours     numeric NOT NULL DEFAULT 18,     -- limite de horas/dia
  max_daily_volume_m3 numeric,                          -- limite de volume/dia (m³)
  expiration_date     date,                             -- validade da outorga
  latitude            double precision,
  longitude           double precision,
  observacoes         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inema_permits_equipment_unique UNIQUE (equipment_id)
);

CREATE INDEX IF NOT EXISTS idx_inema_permits_farm ON public.inema_permits(farm_id);

-- updated_at automático
CREATE OR REPLACE FUNCTION public.touch_inema_permits_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_touch_inema_permits ON public.inema_permits;
CREATE TRIGGER trg_touch_inema_permits BEFORE UPDATE ON public.inema_permits
  FOR EACH ROW EXECUTE FUNCTION public.touch_inema_permits_updated_at();

-- ── RLS: só membros da fazenda (via user_roles) leem/editam ──
ALTER TABLE public.inema_permits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inema_permits_select ON public.inema_permits;
CREATE POLICY inema_permits_select ON public.inema_permits FOR SELECT
  USING (farm_id IN (SELECT ur.farm_id FROM public.user_roles ur WHERE ur.user_id = auth.uid()));

DROP POLICY IF EXISTS inema_permits_write ON public.inema_permits;
CREATE POLICY inema_permits_write ON public.inema_permits FOR ALL
  USING (farm_id IN (SELECT ur.farm_id FROM public.user_roles ur
                     WHERE ur.user_id = auth.uid() AND ur.role IN ('owner','admin')))
  WITH CHECK (farm_id IN (SELECT ur.farm_id FROM public.user_roles ur
                          WHERE ur.user_id = auth.uid() AND ur.role IN ('owner','admin')));

-- ============================================================================
-- SEED — Dom Perignon (farm f2d585b0), 8 poços. Mapeia por NOME do equipamento.
--  Poços 01–06: Portaria 27.975 · Jorge Luiz Pinto Saldanha · 3.582 m³/dia
--  Poço 07: Portaria 27.971 · Armindo Brugnera · 3.600 m³/dia
--  Poço 08: Portaria 27.971 · Armindo Brugnera · 5.400 m³/dia
--  Todos: 18 h/dia, validade 17/02/2027.
-- ============================================================================
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
