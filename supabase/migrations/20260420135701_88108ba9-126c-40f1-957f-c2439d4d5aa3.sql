-- =========================================================
-- ENUMS
-- =========================================================
create type public.app_role as enum ('owner', 'admin', 'operator', 'viewer');
create type public.equipment_type as enum ('poco', 'bombeamento', 'nivel', 'repetidor');
create type public.event_origin as enum ('remote', 'local', 'auto', 'reading', 'system');
create type public.event_action as enum ('turn_on', 'turn_off', 'status_read', 'mode_change', 'reset');
create type public.event_result as enum ('success', 'fail', 'pending', 'timeout');

-- =========================================================
-- UTIL: trigger de updated_at
-- =========================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

-- =========================================================
-- FARMS
-- =========================================================
create table public.farms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text,
  state text,
  timezone text not null default 'America/Sao_Paulo',
  plan text not null default 'lite',
  license_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.farms enable row level security;
create trigger trg_farms_touch before update on public.farms
  for each row execute function public.touch_updated_at();

-- =========================================================
-- PROFILES
-- =========================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  phone text,
  avatar_url text,
  default_farm_id uuid references public.farms(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================
-- USER ROLES
-- =========================================================
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  farm_id uuid not null references public.farms(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, farm_id, role)
);
alter table public.user_roles enable row level security;
create index idx_user_roles_user on public.user_roles(user_id);
create index idx_user_roles_farm on public.user_roles(farm_id);

-- =========================================================
-- SECURITY DEFINER FUNCTIONS (anti-recursão de RLS)
-- =========================================================
create or replace function public.has_farm_role(_user_id uuid, _farm_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and farm_id = _farm_id and role = _role
  )
$$;

create or replace function public.has_farm_access(_user_id uuid, _farm_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and farm_id = _farm_id
  )
$$;

create or replace function public.can_write_farm(_user_id uuid, _farm_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and farm_id = _farm_id
      and role in ('owner', 'admin', 'operator')
  )
$$;

create or replace function public.is_farm_admin(_user_id uuid, _farm_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and farm_id = _farm_id
      and role in ('owner', 'admin')
  )
$$;

-- =========================================================
-- EQUIPMENTS (com firmware_version e last_communication)
-- =========================================================
create table public.equipments (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  hw_id text not null,
  name text not null,
  type public.equipment_type not null,
  latitude numeric(10, 7),
  longitude numeric(10, 7),
  max_height numeric(6, 2),
  alarm_low numeric(5, 2),
  alarm_high numeric(5, 2),
  sector_id uuid,
  plc_group_id uuid,
  active boolean not null default true,
  firmware_version text,
  last_communication timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (farm_id, hw_id)
);
alter table public.equipments enable row level security;
create index idx_equipments_farm on public.equipments(farm_id);
create index idx_equipments_last_comm on public.equipments(farm_id, last_communication desc);
create trigger trg_equipments_touch before update on public.equipments
  for each row execute function public.touch_updated_at();

-- =========================================================
-- AUTOMATION LOG (coração da Fase 2)
-- =========================================================
create table public.automation_log (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  equipment_id uuid references public.equipments(id) on delete set null,
  equipment_name text not null,
  occurred_at timestamptz not null default now(),
  origin public.event_origin not null,
  action public.event_action not null,
  result public.event_result not null default 'success',
  new_state text,
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  details jsonb,
  client_event_id uuid not null,
  source_device text,
  created_at timestamptz not null default now(),
  unique (farm_id, client_event_id)
);
alter table public.automation_log enable row level security;
create index idx_log_farm_time on public.automation_log(farm_id, occurred_at desc);
create index idx_log_equipment on public.automation_log(equipment_id);
create index idx_log_farm_pump_time on public.automation_log(farm_id, equipment_name, occurred_at desc);

-- Realtime
alter publication supabase_realtime add table public.automation_log;
alter table public.automation_log replica identity full;

-- =========================================================
-- POLÍTICAS RLS
-- =========================================================

-- FARMS
create policy "farms_select_members" on public.farms for select to authenticated
  using (public.has_farm_access(auth.uid(), id));
create policy "farms_update_owner" on public.farms for update to authenticated
  using (public.has_farm_role(auth.uid(), id, 'owner'));
create policy "farms_insert_authenticated" on public.farms for insert to authenticated
  with check (true);

-- PROFILES
create policy "profiles_select_own" on public.profiles for select to authenticated
  using (id = auth.uid());
create policy "profiles_update_own" on public.profiles for update to authenticated
  using (id = auth.uid());
create policy "profiles_select_farm_admins" on public.profiles for select to authenticated
  using (
    exists (
      select 1 from public.user_roles ur
      where ur.user_id = profiles.id
        and public.is_farm_admin(auth.uid(), ur.farm_id)
    )
  );

-- USER_ROLES
create policy "user_roles_select_own" on public.user_roles for select to authenticated
  using (user_id = auth.uid());
create policy "user_roles_select_farm_admin" on public.user_roles for select to authenticated
  using (public.is_farm_admin(auth.uid(), farm_id));
create policy "user_roles_admin_manage" on public.user_roles for all to authenticated
  using (public.is_farm_admin(auth.uid(), farm_id))
  with check (public.is_farm_admin(auth.uid(), farm_id));

-- EQUIPMENTS
create policy "equipments_select_members" on public.equipments for select to authenticated
  using (public.has_farm_access(auth.uid(), farm_id));
create policy "equipments_admin_manage" on public.equipments for all to authenticated
  using (public.is_farm_admin(auth.uid(), farm_id))
  with check (public.is_farm_admin(auth.uid(), farm_id));

-- AUTOMATION_LOG
create policy "log_select_members" on public.automation_log for select to authenticated
  using (public.has_farm_access(auth.uid(), farm_id));
create policy "log_insert_operators" on public.automation_log for insert to authenticated
  with check (
    public.can_write_farm(auth.uid(), farm_id)
    and (user_id is null or user_id = auth.uid())
  );
-- Sem policies de UPDATE/DELETE: log é imutável.