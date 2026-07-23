-- Tabela de logs do agente Electron
CREATE TABLE public.agent_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('info', 'warn', 'error', 'debug')),
  category text NOT NULL CHECK (category IN ('tx', 'rx', 'serial', 'cloud', 'system', 'timeout')),
  message text NOT NULL,
  raw_frame text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Índice para consultas rápidas (últimos logs por fazenda)
CREATE INDEX idx_agent_logs_farm_created
  ON public.agent_logs(farm_id, created_at DESC);

-- Índice auxiliar para filtros por categoria/nível
CREATE INDEX idx_agent_logs_farm_category
  ON public.agent_logs(farm_id, category, created_at DESC);

-- RLS
ALTER TABLE public.agent_logs ENABLE ROW LEVEL SECURITY;

-- SELECT: membros da fazenda podem ver os logs
CREATE POLICY "agent_logs_select_members"
  ON public.agent_logs
  FOR SELECT
  TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id));

-- INSERT: membros com permissão de escrita podem inserir logs
CREATE POLICY "agent_logs_insert_writers"
  ON public.agent_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

-- Habilita Realtime para a tabela
ALTER TABLE public.agent_logs REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_logs;