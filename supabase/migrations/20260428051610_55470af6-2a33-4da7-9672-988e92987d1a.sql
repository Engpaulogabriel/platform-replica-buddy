-- Adiciona 'update_agent' ao enum agent_cmd_kind se ainda não existir
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'agent_cmd_kind' AND e.enumlabel = 'update_agent'
  ) THEN
    ALTER TYPE agent_cmd_kind ADD VALUE 'update_agent';
  END IF;
EXCEPTION WHEN undefined_object THEN
  -- enum não existe; ignorar (fluxo legado)
  NULL;
END $$;

-- Tabela de releases do agente
CREATE TABLE IF NOT EXISTS public.agent_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL UNIQUE,
  download_url TEXT NOT NULL,
  release_notes TEXT,
  is_latest BOOLEAN NOT NULL DEFAULT false,
  mandatory BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Garantir apenas 1 release marcado como latest
CREATE UNIQUE INDEX IF NOT EXISTS agent_releases_only_one_latest
  ON public.agent_releases ((is_latest)) WHERE is_latest = true;

ALTER TABLE public.agent_releases ENABLE ROW LEVEL SECURITY;

-- Todo mundo autenticado lê (agente precisa pra checar versão)
CREATE POLICY "agent_releases_select_all_authenticated"
  ON public.agent_releases FOR SELECT
  TO authenticated
  USING (true);

-- Apenas platform admins gerenciam
CREATE POLICY "agent_releases_insert_platform_admin"
  ON public.agent_releases FOR INSERT
  TO authenticated
  WITH CHECK (is_platform_admin(auth.uid()));

CREATE POLICY "agent_releases_update_platform_admin"
  ON public.agent_releases FOR UPDATE
  TO authenticated
  USING (is_platform_admin(auth.uid()))
  WITH CHECK (is_platform_admin(auth.uid()));

CREATE POLICY "agent_releases_delete_platform_admin"
  ON public.agent_releases FOR DELETE
  TO authenticated
  USING (is_platform_admin(auth.uid()));

-- Trigger pra garantir que ao marcar is_latest=true, desmarca os outros
CREATE OR REPLACE FUNCTION public.ensure_single_latest_release()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.is_latest = true THEN
    UPDATE public.agent_releases
       SET is_latest = false
     WHERE id <> NEW.id AND is_latest = true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_single_latest_release ON public.agent_releases;
CREATE TRIGGER trg_ensure_single_latest_release
  BEFORE INSERT OR UPDATE ON public.agent_releases
  FOR EACH ROW EXECUTE FUNCTION public.ensure_single_latest_release();