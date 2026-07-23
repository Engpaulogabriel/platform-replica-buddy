
ALTER TABLE public.agent_hardware ADD COLUMN IF NOT EXISTS log_encryption_key TEXT;

CREATE OR REPLACE FUNCTION public.get_farm_log_key(_farm_id UUID)
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_key TEXT;
BEGIN
  IF NOT (public.is_platform_admin(auth.uid()) OR public.is_farm_admin(auth.uid(), _farm_id)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  SELECT log_encryption_key INTO v_key FROM public.agent_hardware WHERE farm_id = _farm_id;
  RETURN v_key;
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_farm_log_key(_farm_id UUID, _new_key TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_key TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND ur.farm_id = _farm_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  SELECT log_encryption_key INTO v_key FROM public.agent_hardware WHERE farm_id = _farm_id;
  IF v_key IS NULL OR v_key = '' THEN
    UPDATE public.agent_hardware SET log_encryption_key = _new_key WHERE farm_id = _farm_id;
    v_key := _new_key;
  END IF;
  RETURN v_key;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_farm_log_key(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_farm_log_key(UUID, TEXT) TO authenticated;

CREATE POLICY "agent-logs upload por membros da fazenda"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'agent-logs'
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.farm_id::text = (storage.foldername(name))[1]
  )
);

CREATE POLICY "agent-logs update por membros da fazenda"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'agent-logs'
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.farm_id::text = (storage.foldername(name))[1]
  )
);

CREATE POLICY "agent-logs leitura admins da fazenda"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'agent-logs'
  AND (
    public.is_platform_admin(auth.uid())
    OR public.is_farm_admin(auth.uid(), ((storage.foldername(name))[1])::uuid)
  )
);
