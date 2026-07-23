
-- ============ master_managers ============
CREATE TABLE public.master_managers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  cpf TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.master_managers TO authenticated;
GRANT ALL ON public.master_managers TO service_role;

ALTER TABLE public.master_managers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins manage master managers"
  ON public.master_managers FOR ALL
  TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- master managers can view their own row (needed for Etapa 2 hook)
CREATE POLICY "Master manager can read own row"
  ON public.master_managers FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ============ master_manager_farms ============
CREATE TABLE public.master_manager_farms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id UUID NOT NULL REFERENCES public.master_managers(id) ON DELETE CASCADE,
  farm_id UUID NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(manager_id, farm_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.master_manager_farms TO authenticated;
GRANT ALL ON public.master_manager_farms TO service_role;

ALTER TABLE public.master_manager_farms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins manage manager farm links"
  ON public.master_manager_farms FOR ALL
  TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE POLICY "Master manager can read own farm links"
  ON public.master_manager_farms FOR SELECT
  TO authenticated
  USING (
    manager_id IN (SELECT id FROM public.master_managers WHERE user_id = auth.uid())
  );

-- ============ master_manager_permissions ============
CREATE TABLE public.master_manager_permissions (
  manager_id UUID PRIMARY KEY REFERENCES public.master_managers(id) ON DELETE CASCADE,
  can_view_dashboard BOOLEAN NOT NULL DEFAULT true,
  can_view_reports BOOLEAN NOT NULL DEFAULT true,
  can_command_pumps BOOLEAN NOT NULL DEFAULT true,
  can_edit_schedules BOOLEAN NOT NULL DEFAULT true,
  can_manage_maintenance BOOLEAN NOT NULL DEFAULT true,
  can_view_financial BOOLEAN NOT NULL DEFAULT false,
  can_manage_operational_users BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.master_manager_permissions TO authenticated;
GRANT ALL ON public.master_manager_permissions TO service_role;

ALTER TABLE public.master_manager_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins manage manager permissions"
  ON public.master_manager_permissions FOR ALL
  TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE POLICY "Master manager can read own permissions"
  ON public.master_manager_permissions FOR SELECT
  TO authenticated
  USING (
    manager_id IN (SELECT id FROM public.master_managers WHERE user_id = auth.uid())
  );

-- updated_at triggers (reusa função padrão do projeto)
CREATE TRIGGER trg_master_managers_updated_at
  BEFORE UPDATE ON public.master_managers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_master_manager_permissions_updated_at
  BEFORE UPDATE ON public.master_manager_permissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Overview RPC (para a listagem)
CREATE OR REPLACE FUNCTION public.master_managers_overview()
RETURNS TABLE (
  id UUID,
  user_id UUID,
  full_name TEXT,
  cpf TEXT,
  email TEXT,
  whatsapp TEXT,
  status TEXT,
  farms_count BIGINT,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    m.id, m.user_id, m.full_name, m.cpf, m.email, m.whatsapp, m.status,
    COALESCE((SELECT COUNT(*) FROM public.master_manager_farms f WHERE f.manager_id = m.id), 0) AS farms_count,
    m.created_at
  FROM public.master_managers m
  WHERE public.is_platform_admin(auth.uid())
  ORDER BY m.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.master_managers_overview() TO authenticated;
