-- Per-farm agent version pinning para rollout gradual de updates do Electron.
-- Cada fazenda pode ser fixada numa versão específica (canary/teste); se NULL,
-- segue a release marcada como is_latest=true.

ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS target_agent_version text;

COMMENT ON COLUMN public.farms.target_agent_version IS
  'Versão do Renov Agent que esta fazenda DEVE rodar. NULL = segue a release is_latest=true (canal estável global).';

-- RPC chamada pelo agente para descobrir qual versão ele deve estar rodando.
-- Devolve a versão pinned na fazenda OU a release is_latest atual. Devolve
-- também a download_url para o agente baixar diretamente caso eletron-updater
-- esteja indisponível.
CREATE OR REPLACE FUNCTION public.get_agent_target_version(_farm_id uuid)
RETURNS TABLE (
  target_version text,
  download_url text,
  is_pinned boolean,
  mandatory boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pinned_version text;
BEGIN
  SELECT f.target_agent_version INTO pinned_version
  FROM public.farms f
  WHERE f.id = _farm_id;

  IF pinned_version IS NOT NULL THEN
    RETURN QUERY
    SELECT r.version, r.download_url, true, r.mandatory
    FROM public.agent_releases r
    WHERE r.version = pinned_version
    LIMIT 1;
  ELSE
    RETURN QUERY
    SELECT r.version, r.download_url, false, r.mandatory
    FROM public.agent_releases r
    WHERE r.is_latest = true
    LIMIT 1;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_target_version(uuid) TO authenticated;