-- Helper: nome amigável, evita "Remoto Não Identificado"
CREATE OR REPLACE FUNCTION public.resolve_user_display_name(_uid uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT full_name FROM public.master_managers WHERE user_id = _uid AND status = 'active' LIMIT 1),
    (SELECT full_name FROM public.profiles WHERE id = _uid LIMIT 1),
    (SELECT email FROM auth.users WHERE id = _uid LIMIT 1),
    'Remoto Não Identificado'
  );
$$;

GRANT EXECUTE ON FUNCTION public.resolve_user_display_name(uuid) TO authenticated, service_role;

-- Helper: checa se é gestor master ativo
CREATE OR REPLACE FUNCTION public.is_master_manager(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.master_managers
    WHERE user_id = _uid AND status = 'active'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_master_manager(uuid) TO authenticated, service_role;

-- Coluna de role no audit log (idempotente)
ALTER TABLE public.automation_audit_log
  ADD COLUMN IF NOT EXISTS changed_by_role text;