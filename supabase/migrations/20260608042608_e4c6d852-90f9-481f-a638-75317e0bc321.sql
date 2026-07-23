
ALTER TABLE public.agent_releases
  ADD COLUMN IF NOT EXISTS storage_path text,
  ADD COLUMN IF NOT EXISTS artifact_type text NOT NULL DEFAULT 'exe'
    CHECK (artifact_type IN ('asar', 'exe'));

-- Storage policies for the private bucket `agent-releases`
DROP POLICY IF EXISTS "agent_releases_storage_admin_write" ON storage.objects;
DROP POLICY IF EXISTS "agent_releases_storage_admin_update" ON storage.objects;
DROP POLICY IF EXISTS "agent_releases_storage_admin_delete" ON storage.objects;
DROP POLICY IF EXISTS "agent_releases_storage_auth_read" ON storage.objects;

CREATE POLICY "agent_releases_storage_admin_write"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'agent-releases' AND public.is_platform_admin(auth.uid()));

CREATE POLICY "agent_releases_storage_admin_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'agent-releases' AND public.is_platform_admin(auth.uid()))
  WITH CHECK (bucket_id = 'agent-releases' AND public.is_platform_admin(auth.uid()));

CREATE POLICY "agent_releases_storage_admin_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'agent-releases' AND public.is_platform_admin(auth.uid()));

CREATE POLICY "agent_releases_storage_auth_read"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'agent-releases');
