-- ============================================================================
-- AI SEN — esquema de Supabase
-- Pégalo completo en: Supabase → tu proyecto → SQL Editor → Run
-- ============================================================================

-- Perfil de cada usuario. El id apunta al usuario real de Supabase Auth.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  plan       text not null default 'free'
             check (plan in ('free','basico','pro','premium')),
  created_at timestamptz not null default now()
);

-- Consumo diario de tokens, por usuario y día.
create table if not exists public.usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  tokens  bigint not null default 0,
  primary key (user_id, day)
);

-- Suma tokens de forma atómica: si hay dos peticiones a la vez, no se pisan.
create or replace function public.add_usage(
  p_user_id uuid, p_day date, p_tokens bigint
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.usage (user_id, day, tokens)
  values (p_user_id, p_day, p_tokens)
  on conflict (user_id, day)
  do update set tokens = public.usage.tokens + excluded.tokens;
$$;

-- ----------------------------------------------------------------------------
-- Seguridad: RLS activado y SIN políticas de escritura.
-- La API entra con la service_role key, que salta RLS. Cualquier otro
-- (incluido el navegador con la anon key) no puede tocar estas tablas.
-- Cada usuario sí puede leer lo suyo, para mostrar su plan y su consumo.
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.usage    enable row level security;

drop policy if exists "leer mi perfil" on public.profiles;
create policy "leer mi perfil" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "leer mi consumo" on public.usage;
create policy "leer mi consumo" on public.usage
  for select using (auth.uid() = user_id);

-- Crea el perfil automáticamente al registrarse un usuario nuevo.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
