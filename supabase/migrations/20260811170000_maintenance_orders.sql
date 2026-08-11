-- Setor Técnico — Ordens de manutenção de equipamentos ───────────────────────
-- Ordem de serviço por equipamento (poço/bomba/nível/reservatório). NÃO bloqueia
-- a operação (diferente de equipments.maintenance_mode) — só sinaliza que aquele
-- equipamento pode não estar confiável, com badge automático no dashboard
-- enquanto houver ordem ABERTA/EM ANDAMENTO.
-- problem_type/priority/status como text (sem enum → sem ALTER TYPE p/ novos valores).
CREATE TABLE IF NOT EXISTS public.maintenance_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id        uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  equipment_id   uuid REFERENCES public.equipments(id) ON DELETE SET NULL,
  equipment_name text,
  problem_type   text NOT NULL,                          -- nivel_zerado|sensor_defeito|bomba_ruido|sem_comunicacao|vazamento|preventiva|outro
  description    text,
  priority       text NOT NULL DEFAULT 'media'
                   CHECK (priority IN ('alta','media','baixa')),
  status         text NOT NULL DEFAULT 'aberto'
                   CHECK (status IN ('aberto','em_andamento','concluido')),
  created_by     uuid,
  created_by_name text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  completed_by   uuid,
  notes          text
);

-- Badge no dashboard: lookup rápido por fazenda/equipamento das ordens abertas.
CREATE INDEX IF NOT EXISTS idx_maintenance_orders_farm_status
  ON public.maintenance_orders (farm_id, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_orders_open_equip
  ON public.maintenance_orders (equipment_id) WHERE status <> 'concluido';

ALTER TABLE public.maintenance_orders ENABLE ROW LEVEL SECURITY;

-- LEITURA: qualquer usuário com acesso à fazenda (operador vê o badge no dashboard).
DROP POLICY IF EXISTS maintenance_orders_select ON public.maintenance_orders;
CREATE POLICY maintenance_orders_select ON public.maintenance_orders
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));

-- ESCRITA (criar/editar/concluir/apagar): quem pode escrever na fazenda
-- (can_write_farm cobre platform_admin). O bot/edge usa service_role (ignora RLS).
DROP POLICY IF EXISTS maintenance_orders_insert ON public.maintenance_orders;
CREATE POLICY maintenance_orders_insert ON public.maintenance_orders
  FOR INSERT TO authenticated WITH CHECK (public.can_write_farm(auth.uid(), farm_id));
DROP POLICY IF EXISTS maintenance_orders_update ON public.maintenance_orders;
CREATE POLICY maintenance_orders_update ON public.maintenance_orders
  FOR UPDATE TO authenticated USING (public.can_write_farm(auth.uid(), farm_id))
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));
DROP POLICY IF EXISTS maintenance_orders_delete ON public.maintenance_orders;
CREATE POLICY maintenance_orders_delete ON public.maintenance_orders
  FOR DELETE TO authenticated USING (public.can_write_farm(auth.uid(), farm_id));
