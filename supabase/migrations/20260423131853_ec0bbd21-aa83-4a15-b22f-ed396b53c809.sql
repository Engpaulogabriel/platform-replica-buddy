-- 1) Tabela de super-admins globais (não atrelada a farm_id)
CREATE TABLE public.platform_admins (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes      text
);

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

-- 2) Função SECURITY DEFINER para evitar recursão em RLS
CREATE OR REPLACE FUNCTION public.is_platform_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = _user_id
  )
$$;

-- 3) Policies: só super-admins veem/gerenciam a tabela
CREATE POLICY "platform_admins_select_admins"
  ON public.platform_admins FOR SELECT
  TO authenticated
  USING (public.is_platform_admin(auth.uid()));

CREATE POLICY "platform_admins_insert_admins"
  ON public.platform_admins FOR INSERT
  TO authenticated
  WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE POLICY "platform_admins_delete_admins"
  ON public.platform_admins FOR DELETE
  TO authenticated
  USING (public.is_platform_admin(auth.uid()));

-- 4) Cadastra o super-admin inicial
INSERT INTO public.platform_admins (user_id, notes)
VALUES ('a9988fda-6d6a-4eb1-8722-dadb8dabd1a4', 'Super-admin inicial — owner da plataforma')
ON CONFLICT (user_id) DO NOTHING;

-- 5) Restringe create_farm_with_owner: só super-admin
CREATE OR REPLACE FUNCTION public.create_farm_with_owner(
  _name text,
  _city text DEFAULT NULL::text,
  _state text DEFAULT NULL::text,
  _timezone text DEFAULT 'America/Sao_Paulo'::text,
  _plan text DEFAULT 'lite'::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
declare
  v_farm_id uuid;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  if NOT public.is_platform_admin(v_user_id) then
    raise exception 'forbidden: apenas super-admin da plataforma pode criar fazendas';
  end if;

  insert into public.farms (name, city, state, timezone, plan)
  values (_name, _city, _state, _timezone, _plan)
  returning id into v_farm_id;

  insert into public.user_roles (user_id, farm_id, role)
  values (v_user_id, v_farm_id, 'owner');

  update public.profiles
    set default_farm_id = v_farm_id
    where id = v_user_id and default_farm_id is null;

  return v_farm_id;
end;
$function$;