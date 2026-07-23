-- Tabela do Automation Guard (1 registro por equipamento ativo)
CREATE TABLE IF NOT EXISTS public.automation_guards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES public.equipments(id) ON DELETE CASCADE,
  pump_name text NOT NULL,
  silenced_schedule_ids uuid[] NOT NULL DEFAULT '{}',
  triggered_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(farm_id, equipment_id)
);

ALTER TABLE public.automation_guards ENABLE ROW LEVEL SECURITY;

CREATE POLICY automation_guards_select_members ON public.automation_guards
  FOR SELECT TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id));

CREATE POLICY automation_guards_insert_writers ON public.automation_guards
  FOR INSERT TO authenticated
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

CREATE POLICY automation_guards_update_writers ON public.automation_guards
  FOR UPDATE TO authenticated
  USING (public.can_write_farm(auth.uid(), farm_id))
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

CREATE POLICY automation_guards_delete_writers ON public.automation_guards
  FOR DELETE TO authenticated
  USING (public.can_write_farm(auth.uid(), farm_id));

ALTER PUBLICATION supabase_realtime ADD TABLE public.automation_guards;
ALTER TABLE public.automation_guards REPLICA IDENTITY FULL;