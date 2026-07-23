-- Corrige search_path da função utilitária
create or replace function public.touch_updated_at()
returns trigger language plpgsql
set search_path = public
as $$
begin new.updated_at = now(); return new; end;
$$;

-- Remove a policy permissiva de INSERT em farms
drop policy if exists "farms_insert_authenticated" on public.farms;

-- Função que cria a fazenda E vincula o criador como owner (atomicamente)
create or replace function public.create_farm_with_owner(
  _name text,
  _city text default null,
  _state text default null,
  _timezone text default 'America/Sao_Paulo',
  _plan text default 'lite'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_farm_id uuid;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  insert into public.farms (name, city, state, timezone, plan)
  values (_name, _city, _state, _timezone, _plan)
  returning id into v_farm_id;

  insert into public.user_roles (user_id, farm_id, role)
  values (v_user_id, v_farm_id, 'owner');

  -- define como fazenda padrão se o usuário ainda não tiver uma
  update public.profiles
    set default_farm_id = v_farm_id
    where id = v_user_id and default_farm_id is null;

  return v_farm_id;
end;
$$;