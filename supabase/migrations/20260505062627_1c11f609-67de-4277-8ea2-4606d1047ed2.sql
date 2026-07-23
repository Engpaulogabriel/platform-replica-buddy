
-- 1. Estende agent_releases com hash + tamanho + min version
ALTER TABLE public.agent_releases
  ADD COLUMN IF NOT EXISTS file_hash text,
  ADD COLUMN IF NOT EXISTS file_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS min_version_required text;

-- 2. Tabela de status de atualização por fazenda (1 linha por fazenda)
CREATE TABLE IF NOT EXISTS public.agent_update_status (
  farm_id uuid PRIMARY KEY REFERENCES public.farms(id) ON DELETE CASCADE,
  current_version text,
  target_version text,
  target_download_url text,
  target_file_hash text,
  update_status text NOT NULL DEFAULT 'idle',
  -- idle | pending | downloading | downloaded | installing | success | failed | rolled_back
  download_progress smallint NOT NULL DEFAULT 0 CHECK (download_progress BETWEEN 0 AND 100),
  error_message text,
  force_update boolean NOT NULL DEFAULT false,
  requested_at timestamptz,
  requested_by uuid,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_update_status_status
  ON public.agent_update_status(update_status) WHERE update_status <> 'idle';

ALTER TABLE public.agent_update_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aus_select_members ON public.agent_update_status;
CREATE POLICY aus_select_members ON public.agent_update_status
  FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));

-- Agente da fazenda atualiza o próprio status (current_version, progress, etc.)
DROP POLICY IF EXISTS aus_update_writers ON public.agent_update_status;
CREATE POLICY aus_update_writers ON public.agent_update_status
  FOR UPDATE TO authenticated
  USING (can_write_farm(auth.uid(), farm_id))
  WITH CHECK (can_write_farm(auth.uid(), farm_id));

-- Insert/upsert pelo agente também
DROP POLICY IF EXISTS aus_insert_writers ON public.agent_update_status;
CREATE POLICY aus_insert_writers ON public.agent_update_status
  FOR INSERT TO authenticated
  WITH CHECK (can_write_farm(auth.uid(), farm_id));

-- platform_admin pode tudo (limpar, reiniciar)
DROP POLICY IF EXISTS aus_admin_all ON public.agent_update_status;
CREATE POLICY aus_admin_all ON public.agent_update_status
  FOR ALL TO authenticated
  USING (is_platform_admin(auth.uid()))
  WITH CHECK (is_platform_admin(auth.uid()));

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.touch_agent_update_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aus_touch ON public.agent_update_status;
CREATE TRIGGER trg_aus_touch
  BEFORE UPDATE ON public.agent_update_status
  FOR EACH ROW EXECUTE FUNCTION public.touch_agent_update_status();

-- 3. Histórico de atualizações
CREATE TABLE IF NOT EXISTS public.agent_update_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  from_version text,
  to_version text NOT NULL,
  status text NOT NULL,             -- success | failed | rolled_back
  error_message text,
  duration_ms integer,
  triggered_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aupd_hist_farm_created
  ON public.agent_update_history(farm_id, created_at DESC);

ALTER TABLE public.agent_update_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auh_select_members ON public.agent_update_history;
CREATE POLICY auh_select_members ON public.agent_update_history
  FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));

DROP POLICY IF EXISTS auh_insert_writers ON public.agent_update_history;
CREATE POLICY auh_insert_writers ON public.agent_update_history
  FOR INSERT TO authenticated
  WITH CHECK (can_write_farm(auth.uid(), farm_id));

-- 4. RPC: request_agent_update — enfileira update + valida guards
CREATE OR REPLACE FUNCTION public.request_agent_update(
  _farm_id uuid,
  _version text,
  _force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Guard: não atualiza se houver comando pendente na fila (a menos que force)
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

  -- Upsert no status
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

  -- Também enfileira agent_command para acelerar (Realtime fast-path)
  INSERT INTO public.agent_commands(farm_id, kind, payload, created_by)
  VALUES (
    _farm_id,
    'update_agent',
    jsonb_build_object(
      'version', rel.version,
      'download_url', rel.download_url,
      'file_hash', rel.file_hash,
      'force', _force
    ),
    auth.uid()
  );

  RETURN jsonb_build_object('ok', true, 'version', rel.version);
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_agent_update(uuid, text, boolean) TO authenticated;

-- 5. RPC: clear_agent_update — admin reseta o status (recomeçar / cancelar)
CREATE OR REPLACE FUNCTION public.clear_agent_update(_farm_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Apenas platform_admin';
  END IF;
  UPDATE public.agent_update_status
    SET update_status = 'idle',
        download_progress = 0,
        error_message = NULL,
        target_version = NULL,
        target_download_url = NULL,
        target_file_hash = NULL,
        force_update = false,
        completed_at = NULL,
        started_at = NULL
   WHERE farm_id = _farm_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.clear_agent_update(uuid) TO authenticated;

-- 6. Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_update_status;
