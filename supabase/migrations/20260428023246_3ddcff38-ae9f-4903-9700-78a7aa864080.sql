
-- ─────────────────────────────────────────────────────────────────
-- FUNCTION: platform_users_overview
-- Lista todos os usuários com fazendas/papéis agregados
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_users_overview()
RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text,
  phone text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  is_platform_admin boolean,
  is_platform_support boolean,
  farms_count integer,
  farms jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.email::text,
    p.full_name,
    p.phone,
    u.created_at,
    u.last_sign_in_at,
    EXISTS(SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = u.id),
    EXISTS(SELECT 1 FROM public.platform_support ps WHERE ps.user_id = u.id),
    COALESCE((SELECT count(*)::int FROM public.user_roles ur WHERE ur.user_id = u.id), 0),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'farm_id', ur.farm_id,
        'farm_name', f.name,
        'role', ur.role
      ) ORDER BY f.name)
      FROM public.user_roles ur
      JOIN public.farms f ON f.id = ur.farm_id
      WHERE ur.user_id = u.id
    ), '[]'::jsonb)
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  ORDER BY u.created_at DESC;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- FUNCTION: platform_user_detail
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_user_detail(_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT public.is_platform_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT jsonb_build_object(
    'user', (SELECT jsonb_build_object(
      'id', u.id, 'email', u.email, 'created_at', u.created_at,
      'last_sign_in_at', u.last_sign_in_at, 'email_confirmed_at', u.email_confirmed_at
    ) FROM auth.users u WHERE u.id = _user_id),
    'profile', (SELECT to_jsonb(p) FROM public.profiles p WHERE p.id = _user_id),
    'is_platform_admin', EXISTS(SELECT 1 FROM public.platform_admins WHERE user_id = _user_id),
    'is_platform_support', EXISTS(SELECT 1 FROM public.platform_support WHERE user_id = _user_id),
    'farms', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'farm_id', ur.farm_id, 'farm_name', f.name, 'farm_city', f.city,
        'farm_state', f.state, 'role', ur.role, 'created_at', ur.created_at
      ) ORDER BY f.name)
      FROM public.user_roles ur JOIN public.farms f ON f.id = ur.farm_id
      WHERE ur.user_id = _user_id
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- FUNCTION: platform_assign_role
-- Atribui/substitui papel em uma fazenda (substitui se já existir)
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_assign_role(
  _user_id uuid, _farm_id uuid, _role app_role
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- Remove papéis anteriores do mesmo usuário na mesma fazenda
  DELETE FROM public.user_roles WHERE user_id = _user_id AND farm_id = _farm_id;
  -- Insere o novo
  INSERT INTO public.user_roles (user_id, farm_id, role)
  VALUES (_user_id, _farm_id, _role);

  INSERT INTO public.agent_logs (farm_id, level, category, message)
  VALUES (_farm_id, 'info', 'admin',
    format('Platform admin %s atribuiu papel %s ao usuário %s', auth.uid(), _role, _user_id));
END $$;

-- ─────────────────────────────────────────────────────────────────
-- FUNCTION: platform_remove_role
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_remove_role(
  _user_id uuid, _farm_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  DELETE FROM public.user_roles WHERE user_id = _user_id AND farm_id = _farm_id;

  INSERT INTO public.agent_logs (farm_id, level, category, message)
  VALUES (_farm_id, 'warn', 'admin',
    format('Platform admin %s removeu acesso do usuário %s a esta fazenda', auth.uid(), _user_id));
END $$;

-- ─────────────────────────────────────────────────────────────────
-- FUNCTION: platform_set_admin / platform_set_support
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_set_admin(_user_id uuid, _enabled boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF _enabled THEN
    INSERT INTO public.platform_admins (user_id, created_by)
    VALUES (_user_id, auth.uid()) ON CONFLICT DO NOTHING;
  ELSE
    -- Não permitir auto-remoção do último admin
    IF _user_id = auth.uid()
       AND (SELECT count(*) FROM public.platform_admins) <= 1 THEN
      RAISE EXCEPTION 'cannot_remove_last_admin';
    END IF;
    DELETE FROM public.platform_admins WHERE user_id = _user_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.platform_set_support(_user_id uuid, _enabled boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF _enabled THEN
    INSERT INTO public.platform_support (user_id, created_by)
    VALUES (_user_id, auth.uid()) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.platform_support WHERE user_id = _user_id;
  END IF;
END $$;
