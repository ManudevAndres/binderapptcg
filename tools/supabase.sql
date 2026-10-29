-- Binder: tabla de datos de usuario (colección, listas y carrito en un único documento JSON).
-- Ejecutar una vez en Supabase → SQL Editor → New query → Run.

create table if not exists public.user_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Cada usuario solo puede ver y modificar su propia fila.
alter table public.user_data enable row level security;

drop policy if exists "leer mis datos" on public.user_data;
create policy "leer mis datos" on public.user_data
  for select using (auth.uid() = user_id);

drop policy if exists "crear mis datos" on public.user_data;
create policy "crear mis datos" on public.user_data
  for insert with check (auth.uid() = user_id);

drop policy if exists "actualizar mis datos" on public.user_data;
create policy "actualizar mis datos" on public.user_data
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
