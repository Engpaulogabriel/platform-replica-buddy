-- ─────────────────────────────────────────────
-- 1) Tabela: plc_groups
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plc_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id     uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  name        text NOT NULL,
  hw_id       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, hw_id)
);

CREATE INDEX IF NOT EXISTS plc_groups_farm_idx ON public.plc_groups(farm_id);

ALTER TABLE public.plc_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY plc_groups_select_members
  ON public.plc_groups FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id));

CREATE POLICY plc_groups_admin_manage
  ON public.plc_groups FOR ALL TO authenticated
  USING (is_farm_admin(auth.uid(), farm_id))
  WITH CHECK (is_farm_admin(auth.uid(), farm_id));

CREATE TRIGGER plc_groups_touch_updated_at
  BEFORE UPDATE ON public.plc_groups
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────
-- 2) Tabela: sectors
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sectors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id     uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sectors_farm_idx ON public.sectors(farm_id);

ALTER TABLE public.sectors ENABLE ROW LEVEL SECURITY;

CREATE POLICY sectors_select_members
  ON public.sectors FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id));

CREATE POLICY sectors_admin_manage
  ON public.sectors FOR ALL TO authenticated
  USING (is_farm_admin(auth.uid(), farm_id))
  WITH CHECK (is_farm_admin(auth.uid(), farm_id));

CREATE TRIGGER sectors_touch_updated_at
  BEFORE UPDATE ON public.sectors
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────
-- 3) equipments: novas colunas + FKs
-- ─────────────────────────────────────────────
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS saida          smallint,
  ADD COLUMN IF NOT EXISTS horas_pico     text,
  ADD COLUMN IF NOT EXISTS max_horas_dia  numeric,
  ADD COLUMN IF NOT EXISTS demanda_kw     numeric,
  ADD COLUMN IF NOT EXISTS fonte_tipo     text,
  ADD COLUMN IF NOT EXISTS alimenta_id    uuid;

-- saída entre 1 e 6 (validação por trigger — CHECK seria fixo e ok aqui, mas mantemos flex via trigger se mudar no futuro)
ALTER TABLE public.equipments
  DROP CONSTRAINT IF EXISTS equipments_saida_range;
ALTER TABLE public.equipments
  ADD CONSTRAINT equipments_saida_range
  CHECK (saida IS NULL OR (saida >= 1 AND saida <= 6));

-- FK opcional para sectors e plc_groups (já existiam como uuid soltas)
ALTER TABLE public.equipments
  DROP CONSTRAINT IF EXISTS equipments_sector_fk;
ALTER TABLE public.equipments
  ADD CONSTRAINT equipments_sector_fk
  FOREIGN KEY (sector_id) REFERENCES public.sectors(id) ON DELETE SET NULL;

ALTER TABLE public.equipments
  DROP CONSTRAINT IF EXISTS equipments_plc_group_fk;
ALTER TABLE public.equipments
  ADD CONSTRAINT equipments_plc_group_fk
  FOREIGN KEY (plc_group_id) REFERENCES public.plc_groups(id) ON DELETE SET NULL;

-- alimenta_id: auto-FK para outro equipamento (diagrama de fluxo)
ALTER TABLE public.equipments
  DROP CONSTRAINT IF EXISTS equipments_alimenta_fk;
ALTER TABLE public.equipments
  ADD CONSTRAINT equipments_alimenta_fk
  FOREIGN KEY (alimenta_id) REFERENCES public.equipments(id) ON DELETE SET NULL;

-- Garantir trigger de updated_at em equipments (pode já existir, é idempotente)
DROP TRIGGER IF EXISTS equipments_touch_updated_at ON public.equipments;
CREATE TRIGGER equipments_touch_updated_at
  BEFORE UPDATE ON public.equipments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────
-- 4) Realtime
-- ─────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'plc_groups'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.plc_groups';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sectors'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.sectors';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'equipments'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.equipments';
  END IF;
END $$;

ALTER TABLE public.plc_groups REPLICA IDENTITY FULL;
ALTER TABLE public.sectors    REPLICA IDENTITY FULL;
ALTER TABLE public.equipments REPLICA IDENTITY FULL;