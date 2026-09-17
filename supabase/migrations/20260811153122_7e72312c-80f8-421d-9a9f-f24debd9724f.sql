CREATE TABLE IF NOT EXISTS public.maintenance_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id        uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  equipment_id   uuid REFERENCES public.equipments(id) ON DELETE SET NULL,
  equipment_name text,
  problem_type   text NOT NULL DEFAULT 'outro',
  description    text,
  priority       text NOT NULL DEFAULT 'media',
  status         text NOT NULL DEFAULT 'aberto',
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text,
  completed_at   timestamptz,
  completed_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_by_name text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.maintenance_orders TO authenticated;
GRANT ALL ON public.maintenance_orders TO service_role;

ALTER TABLE public.maintenance_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "maintenance_orders_select" ON public.maintenance_orders;
CREATE POLICY "maintenance_orders_select" ON public.maintenance_orders
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));

DROP POLICY IF EXISTS "maintenance_orders_insert" ON public.maintenance_orders;
CREATE POLICY "maintenance_orders_insert" ON public.maintenance_orders
  FOR INSERT TO authenticated WITH CHECK (public.has_farm_access(auth.uid(), farm_id));

DROP POLICY IF EXISTS "maintenance_orders_update" ON public.maintenance_orders;
CREATE POLICY "maintenance_orders_update" ON public.maintenance_orders
  FOR UPDATE TO authenticated USING (public.has_farm_access(auth.uid(), farm_id))
  WITH CHECK (public.has_farm_access(auth.uid(), farm_id));

CREATE INDEX IF NOT EXISTS idx_maintenance_orders_farm_status
  ON public.maintenance_orders (farm_id, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_orders_equipment
  ON public.maintenance_orders (equipment_id) WHERE status IN ('aberto', 'em_andamento');

CREATE TRIGGER update_maintenance_orders_updated_at
  BEFORE UPDATE ON public.maintenance_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();