-- Licenças de Diagnóstico (anti-clone do renov_diag.exe) ─────────────────────
-- Cada .exe calcula um device_id (hash de serial do HD + UUID da placa + hostname
-- + MAC). Na 1ª abertura registra (status='pending'); o admin AUTORIZA/REVOGA pela
-- plataforma. A cada abertura a ferramenta valida online (edge diag-license). Se
-- copiado p/ outro PC → device_id diferente → não autorizado → bloqueia.

CREATE TABLE IF NOT EXISTS public.diag_licenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    text NOT NULL UNIQUE,
  hostname     text,
  device_info  jsonb,
  status       text NOT NULL DEFAULT 'pending',   -- pending | authorized | revoked
  farm_id      uuid,
  notes        text,
  activated_by uuid,
  activated_at timestamptz,
  revoked_at   timestamptz,
  last_seen    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_diag_licenses_device ON public.diag_licenses(device_id);
CREATE INDEX IF NOT EXISTS idx_diag_licenses_status ON public.diag_licenses(status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.diag_licenses TO authenticated;
GRANT ALL ON public.diag_licenses TO service_role;

ALTER TABLE public.diag_licenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS diag_licenses_admin_all ON public.diag_licenses;
CREATE POLICY diag_licenses_admin_all ON public.diag_licenses FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

COMMENT ON TABLE public.diag_licenses IS
  'Licenças por device_id do renov_diag (anti-clone). Admin autoriza/revoga; a ferramenta valida online.';
