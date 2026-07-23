-- Tabela de saúde do agente Electron por fazenda
CREATE TABLE public.site_health (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  agent_status text NOT NULL DEFAULT 'offline' CHECK (agent_status IN ('online', 'offline', 'error')),
  last_heartbeat timestamptz NOT NULL DEFAULT now(),
  com_port text,
  com_connected boolean NOT NULL DEFAULT false,
  agent_version text,
  firmware_server text,
  uptime_seconds bigint DEFAULT 0,
  pending_commands int DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(farm_id)
);

CREATE INDEX idx_site_health_farm ON public.site_health(farm_id);

-- Trigger updated_at (reusa touch_updated_at já existente)
CREATE TRIGGER trg_site_health_updated_at
  BEFORE UPDATE ON public.site_health
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- RLS
ALTER TABLE public.site_health ENABLE ROW LEVEL SECURITY;

-- Membros da fazenda podem ler
CREATE POLICY "site_health_select_members"
  ON public.site_health FOR SELECT
  TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id));

-- Operator/admin/owner podem inserir (agente faz upsert)
CREATE POLICY "site_health_insert_operators"
  ON public.site_health FOR INSERT
  TO authenticated
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

-- Operator/admin/owner podem atualizar (heartbeat)
CREATE POLICY "site_health_update_operators"
  ON public.site_health FOR UPDATE
  TO authenticated
  USING (public.can_write_farm(auth.uid(), farm_id))
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

-- Admin pode deletar
CREATE POLICY "site_health_delete_admin"
  ON public.site_health FOR DELETE
  TO authenticated
  USING (public.is_farm_admin(auth.uid(), farm_id));

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.site_health;
ALTER TABLE public.site_health REPLICA IDENTITY FULL;