
DROP FUNCTION IF EXISTS public.get_agent_target_version(uuid);

CREATE OR REPLACE FUNCTION public.get_agent_target_version(_farm_id uuid)
 RETURNS TABLE(target_version text, download_url text, file_hash text, is_pinned boolean, mandatory boolean, artifact_type text, storage_path text, file_size_bytes bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  pinned_version text;
BEGIN
  SELECT f.target_agent_version INTO pinned_version
  FROM public.farms f
  WHERE f.id = _farm_id;

  IF pinned_version IS NOT NULL THEN
    RETURN QUERY
    SELECT r.version, r.download_url, r.file_hash, true, r.mandatory,
           r.artifact_type, r.storage_path, r.file_size_bytes
    FROM public.agent_releases r
    WHERE r.version = pinned_version
    LIMIT 1;
  ELSE
    RETURN QUERY
    SELECT r.version, r.download_url, r.file_hash, false, r.mandatory,
           r.artifact_type, r.storage_path, r.file_size_bytes
    FROM public.agent_releases r
    WHERE r.is_latest = true
    LIMIT 1;
  END IF;
END;
$function$;
