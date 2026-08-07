-- FASE 2 — Token rotativo do agente (agent-auth) ────────────────────────────
-- device_licenses já tem current_token_jti (uuid) e fingerprint_mismatch_count.
-- Aqui só adicionamos a expiração do token e um helper de incremento atômico.

ALTER TABLE public.device_licenses
  ADD COLUMN IF NOT EXISTS current_token_expires_at timestamptz;

-- Incremento atômico do contador de clone (usado pela agent-auth via service_role).
CREATE OR REPLACE FUNCTION public.increment_fingerprint_mismatch(_device_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.device_licenses
     SET fingerprint_mismatch_count = COALESCE(fingerprint_mismatch_count, 0) + 1,
         last_fingerprint_check = now(),
         updated_at = now()
   WHERE id = _device_id;
$$;

REVOKE ALL ON FUNCTION public.increment_fingerprint_mismatch(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_fingerprint_mismatch(uuid) TO service_role;

COMMENT ON COLUMN public.device_licenses.current_token_expires_at IS
  'Expiração (TTL 5min) do token rotativo emitido pela agent-auth. Ver FASE 2.';
