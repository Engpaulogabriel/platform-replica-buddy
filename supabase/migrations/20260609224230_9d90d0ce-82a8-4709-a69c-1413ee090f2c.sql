CREATE OR REPLACE FUNCTION public.request_agent_update(_farm_id uuid, _version text, _force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  rel public.agent_releases%ROWTYPE;
  pending_count int;
BEGIN
  IF NOT is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Apenas platform_admin pode disparar atualizações';
  END IF;

  SELECT * INTO rel FROM public.agent_releases WHERE version = _version LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Release % não encontrada', _version;
  END IF;

  IF NOT _force THEN
    SELECT COUNT(*) INTO pending_count
      FROM public.commands
      WHERE farm_id = _farm_id
        AND status IN ('pending','sent');
    IF pending_count > 0 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'reason', 'pending_commands',
        'pending_count', pending_count,
        'message', format('Existem %s comandos pendentes na fila. Aguarde esvaziar ou use force.', pending_count)
      );
    END IF;
  END IF;

  INSERT INTO public.agent_update_status(
    farm_id, target_version, target_download_url, target_file_hash,
    update_status, download_progress, error_message,
    force_update, requested_at, requested_by, started_at, completed_at
  ) VALUES (
    _farm_id, rel.version, rel.download_url, rel.file_hash,
    'pending', 0, NULL,
    _force, now(), auth.uid(), NULL, NULL
  )
  ON CONFLICT (farm_id) DO UPDATE SET
    target_version       = EXCLUDED.target_version,
    target_download_url  = EXCLUDED.target_download_url,
    target_file_hash     = EXCLUDED.target_file_hash,
    update_status        = 'pending',
    download_progress    = 0,
    error_message        = NULL,
    force_update         = EXCLUDED.force_update,
    requested_at         = now(),
    requested_by         = auth.uid(),
    started_at           = NULL,
    completed_at         = NULL;

  -- v3.11.8: inclui artifact_type e file_size_bytes para o agente saber
  -- qual fluxo usar (asar via signed URL, ou exe via URL externa).
  INSERT INTO public.agent_commands(farm_id, kind, payload, created_by)
  VALUES (
    _farm_id,
    'update_agent',
    jsonb_build_object(
      'version', rel.version,
      'download_url', rel.download_url,
      'file_hash', rel.file_hash,
      'file_size_bytes', rel.file_size_bytes,
      'artifact_type', COALESCE(rel.artifact_type, CASE WHEN rel.download_url IS NULL THEN 'asar' ELSE 'exe' END),
      'storage_path', rel.storage_path,
      'force', _force
    ),
    auth.uid()
  );

  RETURN jsonb_build_object('ok', true, 'version', rel.version);
END;
$function$;