-- ============================================================================
-- MEDIÇÕES DE NÍVEL DE POÇO (NE / ND) — registro manual pelo operador.
-- NE (nível estático): bomba parada há ≥24h. ND (nível dinâmico): bomba
-- operando estabilizada. Exigência de monitoramento das outorgas INEMA
-- (aparece na seção "MONITORAMENTO DE NÍVEIS (NE/ND) — SEMESTRAL" do Anual).
-- Aplicar via push (Lovable) ou SQL Editor. Idempotente.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.well_level_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES public.equipments(id) ON DELETE SET NULL,
  measured_at date NOT NULL,
  static_level_m numeric,       -- NE (m) — bomba parada ≥24h
  dynamic_level_m numeric,      -- ND (m) — bomba operando estabilizada
  notes text,
  measured_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wlm_farm ON public.well_level_measurements(farm_id);
CREATE INDEX IF NOT EXISTS idx_wlm_equipment ON public.well_level_measurements(equipment_id, measured_at DESC);

ALTER TABLE public.well_level_measurements ENABLE ROW LEVEL SECURITY;

-- RLS farm-scoped (mesmo padrão de maintenance_orders). can_write_farm cobre
-- platform_admin. Edge/bot com service_role ignora RLS.
DROP POLICY IF EXISTS wlm_select ON public.well_level_measurements;
CREATE POLICY wlm_select ON public.well_level_measurements
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));

DROP POLICY IF EXISTS wlm_insert ON public.well_level_measurements;
CREATE POLICY wlm_insert ON public.well_level_measurements
  FOR INSERT TO authenticated WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

DROP POLICY IF EXISTS wlm_update ON public.well_level_measurements;
CREATE POLICY wlm_update ON public.well_level_measurements
  FOR UPDATE TO authenticated USING (public.can_write_farm(auth.uid(), farm_id))
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

DROP POLICY IF EXISTS wlm_delete ON public.well_level_measurements;
CREATE POLICY wlm_delete ON public.well_level_measurements
  FOR DELETE TO authenticated USING (public.can_write_farm(auth.uid(), farm_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.well_level_measurements TO authenticated;
