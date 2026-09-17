ALTER TABLE public.device_licenses
  ADD COLUMN IF NOT EXISTS current_token_expires_at timestamptz;

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

CREATE TABLE IF NOT EXISTS public.agent_release_keys (
  version    text PRIMARY KEY,
  aes_key    text NOT NULL,
  algo       text NOT NULL DEFAULT 'aes-256-gcm',
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.agent_release_keys TO service_role;

ALTER TABLE public.agent_release_keys ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.agent_release_keys IS
  'Chave AES-256 (base64) por versão do app.asar.enc. Acesso SÓ via service_role (edge function agent-asar-key valida fingerprint+token antes de entregar). FASE 3.';