-- ==================================================================
-- Groundwork — Supabase schema
-- Paste this whole file into: Supabase dashboard → SQL Editor → Run.
-- Safe to re-run.
-- ==================================================================

-- ---------- profiles: one row per user, tracks the free quota ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  plan         text        not null default 'free',
  usage_count  int         not null default 0,
  usage_limit  int         not null default 10,
  created_at   timestamptz not null default now()
);

-- ---------- generations: saved briefs (history) ----------
create table if not exists public.generations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users (id) on delete cascade,
  prospect_url  text,
  prospect_name text,
  offer         text,
  tone          text,
  result        jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists generations_user_created_idx
  on public.generations (user_id, created_at desc);

-- ==================================================================
-- Row-Level Security: a user can only read their own rows.
-- (Writes happen in the Netlify function with the service key, which
--  bypasses RLS — so we don't add insert/update policies here.)
-- ==================================================================
alter table public.profiles     enable row level security;
alter table public.generations  enable row level security;

drop policy if exists "read own profile"     on public.profiles;
drop policy if exists "read own generations" on public.generations;

create policy "read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "read own generations"
  on public.generations for select
  using (auth.uid() = user_id);

-- ==================================================================
-- Auto-create a profile row whenever a new auth user signs up.
-- ==================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
