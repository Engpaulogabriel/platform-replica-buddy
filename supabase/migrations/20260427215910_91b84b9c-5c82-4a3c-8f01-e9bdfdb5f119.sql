
-- 1) Tabela de suporte (read-only staff)
CREATE TABLE IF NOT EXISTS public.platform_support (
  user_id uuid PRIMARY KEY,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
ALTER TABLE public.platform_support ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_platform_support(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.platform_support WHERE user_id = _user_id) $$;

CREATE OR REPLACE FUNCTION public.is_platform_staff(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT public.is_platform_admin(_user_id) OR public.is_platform_support(_user_id) $$;

DROP POLICY IF EXISTS platform_support_select ON public.platform_support;
CREATE POLICY platform_support_select ON public.platform_support FOR SELECT TO authenticated
USING (public.is_platform_admin(auth.uid()) OR user_id = auth.uid());

DROP POLICY IF EXISTS platform_support_admin_all ON public.platform_support;
CREATE POLICY platform_support_admin_all ON public.platform_support FOR ALL TO authenticated
USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

-- 2) Políticas adicionais para staff ler tudo
DROP POLICY IF EXISTS farms_select_platform_staff ON public.farms;
CREATE POLICY farms_select_platform_staff ON public.farms FOR SELECT TO authenticated
USING (public.is_platform_staff(auth.uid()));

DROP POLICY IF EXISTS equipments_select_platform_staff ON public.equipments;
CREATE POLICY equipments_select_platform_staff ON public.equipments FOR SELECT TO authenticated
USING (public.is_platform_staff(auth.uid()));

DROP POLICY IF EXISTS user_roles_select_platform_staff ON public.user_roles;
CREATE POLICY user_roles_select_platform_staff ON public.user_roles FOR SELECT TO authenticated
USING (public.is_platform_staff(auth.uid()));

DROP POLICY IF EXISTS profiles_select_platform_staff ON public.profiles;
CREATE POLICY profiles_select_platform_staff ON public.profiles FOR SELECT TO authenticated
USING (public.is_platform_staff(auth.uid()));

DROP POLICY IF EXISTS site_health_select_platform_staff ON public.site_health;
CREATE POLICY site_health_select_platform_staff ON public.site_health FOR SELECT TO authenticated
USING (public.is_platform_staff(auth.uid()));

DROP POLICY IF EXISTS agent_logs_select_platform_staff ON public.agent_logs;
CREATE POLICY agent_logs_select_platform_staff ON public.agent_logs FOR SELECT TO authenticated
USING (public.is_platform_staff(auth.uid()));

DROP POLICY IF EXISTS commands_select_platform_staff ON public.commands;
CREATE POLICY commands_select_platform_staff ON public.commands FOR SELECT TO authenticated
USING (public.is_platform_staff(auth.uid()));

-- Admin da plataforma também pode editar farms (atualizar plano/licença)
DROP POLICY IF EXISTS farms_update_platform_admin ON public.farms;
CREATE POLICY farms_update_platform_admin ON public.farms FOR UPDATE TO authenticated
USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

-- 3) RPCs administrativas

-- Cria fazenda + vincula owner por email + gera license key
CREATE OR REPLACE FUNCTION public.platform_create_farm_full(
  _name text,
  _owner_email text,
  _city text DEFAULT NULL,
  _state text DEFAULT NULL,
  _timezone text DEFAULT 'America/Sao_Paulo',
  _plan text DEFAULT 'lite'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_farm_id uuid;
  v_owner_id uuid;
  v_license text;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden: apenas platform admin';
  END IF;

  SELECT id INTO v_owner_id FROM auth.users WHERE lower(email) = lower(_owner_email) LIMIT 1;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'usuario_owner_nao_encontrado: convide o usuario primeiro pelo Auth';
  END IF;

  v_license := 'RNV-' || upper(substring(replace(gen_random_uuid()::text,'-','') from 1 for 16));

  INSERT INTO public.farms (name, city, state, timezone, plan, license_key)
  VALUES (_name, _city, _state, _timezone, _plan, v_license)
  RETURNING id INTO v_farm_id;

  INSERT INTO public.user_roles (user_id, farm_id, role)
  VALUES (v_owner_id, v_farm_id, 'owner')
  ON CONFLICT DO NOTHING;

  UPDATE public.profiles
    SET default_farm_id = v_farm_id
    WHERE id = v_owner_id AND default_farm_id IS NULL;

  RETURN v_farm_id;
END $$;

CREATE OR REPLACE FUNCTION public.platform_update_farm(
  _farm_id uuid,
  _name text DEFAULT NULL,
  _city text DEFAULT NULL,
  _state text DEFAULT NULL,
  _plan text DEFAULT NULL,
  _license_key text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden: apenas platform admin';
  END IF;

  UPDATE public.farms SET
    name = COALESCE(_name, name),
    city = COALESCE(_city, city),
    state = COALESCE(_state, state),
    plan = COALESCE(_plan, plan),
    license_key = COALESCE(_license_key, license_key),
    updated_at = now()
  WHERE id = _farm_id;
END $$;

CREATE OR REPLACE FUNCTION public.platform_regen_license(_farm_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_license text;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_license := 'RNV-' || upper(substring(replace(gen_random_uuid()::text,'-','') from 1 for 16));
  UPDATE public.farms SET license_key = v_license, updated_at = now() WHERE id = _farm_id;
  RETURN v_license;
END $$;

CREATE OR REPLACE FUNCTION public.platform_set_farm_suspended(_farm_id uuid, _suspended boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF _suspended THEN
    UPDATE public.farms SET license_key = NULL, updated_at = now() WHERE id = _farm_id;
  ELSE
    UPDATE public.farms
       SET license_key = COALESCE(license_key,
             'RNV-' || upper(substring(replace(gen_random_uuid()::text,'-','') from 1 for 16))),
           updated_at = now()
     WHERE id = _farm_id;
  END IF;
END $$;

-- Visão geral de todas as fazendas com métricas
CREATE OR REPLACE FUNCTION public.platform_farms_overview()
RETURNS TABLE(
  farm_id uuid,
  name text,
  city text,
  state text,
  plan text,
  license_key text,
  created_at timestamptz,
  equipments_count integer,
  users_count integer,
  agent_status text,
  last_heartbeat timestamptz,
  com_connected boolean,
  pending_commands integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    f.id, f.name, f.city, f.state, f.plan, f.license_key, f.created_at,
    (SELECT count(*)::int FROM public.equipments e WHERE e.farm_id = f.id AND e.active),
    (SELECT count(*)::int FROM public.user_roles ur WHERE ur.farm_id = f.id),
    COALESCE(sh.agent_status, 'offline'),
    sh.last_heartbeat,
    COALESCE(sh.com_connected, false),
    (SELECT count(*)::int FROM public.commands c WHERE c.farm_id = f.id AND c.status IN ('pending','sent'))
  FROM public.farms f
  LEFT JOIN LATERAL (
    SELECT * FROM public.site_health s WHERE s.farm_id = f.id ORDER BY s.last_heartbeat DESC NULLS LAST LIMIT 1
  ) sh ON true
  ORDER BY f.created_at DESC;
END $$;

-- Detalhe de uma fazenda
CREATE OR REPLACE FUNCTION public.platform_farm_detail(_farm_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT public.is_platform_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT jsonb_build_object(
    'farm', (SELECT to_jsonb(f) FROM public.farms f WHERE f.id = _farm_id),
    'equipments', COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.name) FROM public.equipments e WHERE e.farm_id = _farm_id), '[]'::jsonb),
    'users', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'user_id', ur.user_id, 'role', ur.role,
        'email', p.email, 'full_name', p.full_name
      ) ORDER BY ur.role)
      FROM public.user_roles ur
      LEFT JOIN public.profiles p ON p.id = ur.user_id
      WHERE ur.farm_id = _farm_id
    ), '[]'::jsonb),
    'site_health', (SELECT to_jsonb(s) FROM public.site_health s WHERE s.farm_id = _farm_id ORDER BY s.last_heartbeat DESC NULLS LAST LIMIT 1),
    'recent_logs', COALESCE((
      SELECT jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC)
      FROM (SELECT * FROM public.agent_logs WHERE farm_id = _farm_id ORDER BY created_at DESC LIMIT 50) l
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END $$;

-- KPIs gerais
CREATE OR REPLACE FUNCTION public.platform_overview_stats()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN jsonb_build_object(
    'total_farms', (SELECT count(*) FROM public.farms),
    'farms_lite', (SELECT count(*) FROM public.farms WHERE plan = 'lite'),
    'farms_pro', (SELECT count(*) FROM public.farms WHERE plan = 'pro'),
    'farms_suspended', (SELECT count(*) FROM public.farms WHERE license_key IS NULL),
    'agents_online', (SELECT count(*) FROM public.site_health WHERE last_heartbeat > now() - interval '5 minutes'),
    'agents_offline', (SELECT count(*) FROM public.farms f WHERE NOT EXISTS (
        SELECT 1 FROM public.site_health s WHERE s.farm_id = f.id AND s.last_heartbeat > now() - interval '5 minutes')),
    'total_equipments', (SELECT count(*) FROM public.equipments WHERE active),
    'total_users', (SELECT count(DISTINCT user_id) FROM public.user_roles),
    'pending_commands', (SELECT count(*) FROM public.commands WHERE status IN ('pending','sent'))
  );
END $$;
